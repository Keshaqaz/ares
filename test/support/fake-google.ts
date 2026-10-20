// Google side of the fake world: the consent of the project's Desktop OAuth client with boxes the
// user may leave unticked, its token endpoint, the Apps Script API calls the CLI makes and the web
// apps of the deployed projects. withGoogle(world) chains it in front of world.fetch. google.open
// is the user's browser: it answers the consent through the CLI's loopback server, turns on the
// Apps Script API at usersettings and grants the script its scopes at the web app URL. A web app's
// doPost runs the deployed version in the fake Apps Script runtime over the same world.
import { createHash } from 'node:crypto';
import { GOOGLE_OAUTH_CLIENT } from '../../src/google/oauth-client.ts';
import { GOOGLE_SCOPES } from '../../src/google/api.ts';
import type { GoogleScope, ScriptFile, DeploymentConfig } from '../../src/google/api.ts';
import { USER_AGENT } from '../../src/chatgpt/http.ts';
import type { Fetch } from '../../src/chatgpt/http.ts';
import { fakeAppsScript } from './fake-apps-script.ts';
import type { FakeAppsScript } from './fake-apps-script.ts';
import type { FakeWorld } from './fake-world.ts';

export const USER_SETTINGS = 'https://script.google.com/home/usersettings';
export const SCRIPT_HOME = 'https://script.google.com/home';
// Probe 01, the reply to the first projects.create.
const API_DISABLED = 'User has not enabled the Apps Script API. Enable it by visiting https://script.google.com/home/usersettings ' +
  'then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.';
const ACCESS_SECONDS = 3599;

export interface FakeProject {
  scriptId: string;
  title: string;
  files: ScriptFile[];
  // Version n is versions[n - 1].
  versions: ScriptFile[][];
  // deploymentId → the version it serves.
  deployments: Map<string, number>;
  // The owner granted the script its scopes at the web app URL.
  authorized: boolean;
  // The script's runtime, with its properties and triggers; it runs the version last loaded.
  gas: FakeAppsScript | null;
  loaded: number | null;
}
// What the user does on the consent page: ticks these boxes, or refuses.
export type Consent = GoogleScope[] | 'denied';

export type ApiCall = 'create_project' | 'update_content' | 'create_version' | 'create_deployment' | 'update_deployment';

export interface FakeGoogle {
  // The switch in script.google.com/home/usersettings.
  apiEnabled: boolean;
  // How long after opening usersettings the user turns the switch on; null: never.
  enableAfterMs: number | null;
  // What the user does on each consent, in turn; when none is left, ticks every box.
  consents: Consent[];
  // Whether the user lets the script run when its web app opens; false: closes the page.
  allowsScript: boolean;
  // Every URL the CLI opened in the browser.
  opened: string[];
  // refresh token → its scopes; a revoked or expired one is gone.
  refreshTokens: Map<string, string[]>;
  accessTokens: Map<string, { scopes: string[]; expiresAt: number }>;
  projects: Map<string, FakeProject>;
  // The next Apps Script API call of this kind answers 500, as an outage mid-deploy.
  failNext: ApiCall | null;
  requests: { method: string; url: string }[];
  violations: string[];
  open(url: string): Promise<void>;
  // Testing mode: every refresh token dies 7 days after it was issued.
  expireRefreshTokens(): void;
  project(): FakeProject | undefined;
  // The secret in the project's deployed secret file.
  deployedSecret(project?: FakeProject): string | undefined;
}

const json = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const apiError = (code: number, status: string, message: string): Response => json(code, { error: { code, message, status } });
const challenge = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

export function withGoogle(world: FakeWorld & { google?: FakeGoogle }): FakeGoogle {
  let serial = 0, enableAt: number | null = null;
  const codes = new Map<string, { scopes: string[]; redirect: string; challenge: string }>();
  // user_content_key → the doPost reply waiting for its GET.
  const replies = new Map<string, string>();
  const isEnabled = () => {
    if (!google.apiEnabled && enableAt !== null && world.now >= enableAt) google.apiEnabled = true;
    return google.apiEnabled;
  };

  const google: FakeGoogle = {
    apiEnabled: false, enableAfterMs: 12_000, consents: [], allowsScript: true, opened: [], refreshTokens: new Map(), accessTokens: new Map(),
    projects: new Map(), failNext: null, requests: [], violations: [],
    open: async href => {
      google.opened.push(href);
      const url = new URL(href);
      if (href === SCRIPT_HOME) return;
      if (href === USER_SETTINGS) {
        if (google.enableAfterMs !== null) enableAt ??= world.now + google.enableAfterMs;
        return;
      }
      const exec = url.host === 'script.google.com' && url.pathname.match(/^\/macros\/s\/([^/]+)\/exec$/);
      if (exec) {
        const project = [...google.projects.values()].find(p => p.deployments.has(exec[1] ?? ''));
        if (project && google.allowsScript) project.authorized = true;
        return;
      }
      if (url.origin + url.pathname !== 'https://accounts.google.com/o/oauth2/v2/auth') {
        google.violations.push(`opened ${href}`);
        return;
      }
      const q = url.searchParams;
      const redirect = q.get('redirect_uri') ?? '';
      const expected = { client_id: GOOGLE_OAUTH_CLIENT.id, response_type: 'code', code_challenge_method: 'S256', access_type: 'offline' };
      for (const [key, value] of Object.entries(expected)) if (q.get(key) !== value) google.violations.push(`${key} ${q.get(key)}`);
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(redirect)) google.violations.push(`redirect_uri ${redirect}`);
      const requested = (q.get('scope') ?? '').split(' ');
      if (Object.values(GOOGLE_SCOPES).some(scope => !requested.includes(scope))) google.violations.push(`scope ${q.get('scope')}`);
      const consent = google.consents.shift() ?? (Object.keys(GOOGLE_SCOPES) as GoogleScope[]);
      const back = new URL(redirect);
      back.searchParams.set('state', q.get('state') ?? '');
      if (consent === 'denied') back.searchParams.set('error', 'access_denied');
      else {
        const code = `4/fake-code-${++serial}`;
        codes.set(code, { scopes: consent.map(scope => GOOGLE_SCOPES[scope]), redirect, challenge: q.get('code_challenge') ?? '' });
        back.searchParams.set('code', code);
      }
      // The browser follows Google's redirect to the CLI's own server on this Mac.
      const answer = await globalThis.fetch(back);
      if (answer.status !== 200) google.violations.push(`loopback ${answer.status}`);
    },
    expireRefreshTokens: () => { google.refreshTokens.clear(); },
    project: () => [...google.projects.values()][0],
    deployedSecret: (project = google.project()) => {
      const version = project && [...project.deployments.values()].at(-1);
      const source = version ? project.versions[version - 1]?.find(file => file.name === 'secret')?.source : undefined;
      return source?.match(/"([^"]+)"/)?.[1];
    },
  };
  world.google = google;

  function issue(scopes: string[]): { access_token: string; expires_in: number; scope: string; token_type: string } {
    const token = `ya29.fake-${++serial}`;
    google.accessTokens.set(token, { scopes, expiresAt: world.now + ACCESS_SECONDS * 1000 });
    return { access_token: token, expires_in: ACCESS_SECONDS, scope: scopes.join(' '), token_type: 'Bearer' };
  }

  function token(form: Record<string, string>): Response {
    if (form.client_id !== GOOGLE_OAUTH_CLIENT.id || form.client_secret !== GOOGLE_OAUTH_CLIENT.secret) {
      return json(401, { error: 'invalid_client' });
    }
    if (form.grant_type === 'authorization_code') {
      const grant = codes.get(form.code ?? '');
      codes.delete(form.code ?? '');
      if (!grant || grant.redirect !== form.redirect_uri || challenge(form.code_verifier ?? '') !== grant.challenge) {
        return json(400, { error: 'invalid_grant', error_description: 'Bad Request' });
      }
      const refresh = `1//fake-refresh-${++serial}`;
      google.refreshTokens.set(refresh, grant.scopes);
      return json(200, { ...issue(grant.scopes), refresh_token: refresh, refresh_token_expires_in: 604799 });
    }
    if (form.grant_type === 'refresh_token') {
      const scopes = google.refreshTokens.get(form.refresh_token ?? '');
      if (!scopes) return json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      return json(200, issue(scopes));
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  const insufficient = () => apiError(403, 'PERMISSION_DENIED', 'Request had insufficient authentication scopes.');
  const deploymentView = (project: FakeProject, deploymentId: string, config: Partial<DeploymentConfig>) => ({
    deploymentId, deploymentConfig: { scriptId: project.scriptId, ...config },
    entryPoints: [{ entryPointType: 'WEB_APP', webApp: { url: `https://script.google.com/macros/s/${deploymentId}/exec`,
      entryPointConfig: { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' } } }],
  });

  const callOf = (method: string, path: string): ApiCall | null => {
    if (method === 'GET') return null;
    if (path === '/v1/projects') return 'create_project';
    const what = path.match(/\/(content|versions|deployments)(\/[^/]+)?$/);
    if (what?.[1] === 'content') return 'update_content';
    if (what?.[1] === 'versions') return 'create_version';
    if (what?.[1] === 'deployments') return method === 'PUT' ? 'update_deployment' : 'create_deployment';
    return null;
  };

  function scriptApi(method: string, path: string, body: Record<string, unknown>, scopes: string[]): Response {
    if (!isEnabled()) return apiError(403, 'PERMISSION_DENIED', API_DISABLED);
    if (google.failNext && google.failNext === callOf(method, path)) {
      google.failNext = null;
      return apiError(500, 'INTERNAL', 'Internal error encountered.');
    }
    const can = (scope: GoogleScope) => scopes.includes(GOOGLE_SCOPES[scope]);
    if (path === '/v1/projects' && method === 'POST') {
      if (!can('projects')) return insufficient();
      if (typeof body.title !== 'string') return apiError(400, 'INVALID_ARGUMENT', 'title');
      const scriptId = `fake-script-${++serial}`;
      google.projects.set(scriptId, { scriptId, title: body.title, files: [], versions: [], deployments: new Map(), authorized: false,
        gas: null, loaded: null });
      return json(200, { scriptId, title: body.title });
    }
    const match = path.match(/^\/v1\/projects\/([^/]+)(?:\/(content|versions|deployments)(?:\/([^/]+))?)?$/);
    const project = match && google.projects.get(decodeURIComponent(match[1] ?? ''));
    if (!match || !project) return apiError(404, 'NOT_FOUND', 'Requested entity was not found.');
    const [, , what, id] = match;
    if (method === 'GET') {
      if (!can('projects') && what !== 'deployments' || what === 'deployments' && !can('deployments')) return insufficient();
      if (what === undefined) return json(200, { scriptId: project.scriptId, title: project.title });
      if (what === 'content') return json(200, { scriptId: project.scriptId, files: project.files });
      if (what === 'deployments' && id === undefined) {
        // The editor's head deployment has no version and no web app here.
        return json(200, { deployments: [{ deploymentId: `AKfycbHead${project.scriptId}`, deploymentConfig: { scriptId: project.scriptId,
          manifestFileName: 'appsscript' } }, ...[...project.deployments].map(([deploymentId, versionNumber]) =>
          deploymentView(project, deploymentId, { versionNumber, manifestFileName: 'appsscript' }))] });
      }
    }
    if (what === 'content' && method === 'PUT') {
      if (!can('projects')) return insufficient();
      const files = body.files as ScriptFile[] | undefined;
      const manifest = files?.find(file => file.name === 'appsscript' && file.type === 'JSON');
      if (!files || !manifest) return apiError(400, 'INVALID_ARGUMENT', 'The project must have a manifest file.');
      project.files = files;
      return json(200, { scriptId: project.scriptId, files });
    }
    if (what === 'versions' && method === 'POST') {
      if (!can('projects')) return insufficient();
      project.versions.push(project.files);
      return json(200, { scriptId: project.scriptId, versionNumber: project.versions.length, description: body.description });
    }
    if (what === 'deployments') {
      if (!can('deployments')) return insufficient();
      const config = (method === 'PUT' ? body.deploymentConfig : body) as Partial<DeploymentConfig> | undefined;
      const version = config?.versionNumber;
      if (config?.manifestFileName !== 'appsscript') google.violations.push(`manifestFileName ${config?.manifestFileName}`);
      if (typeof version !== 'number' || !project.versions[version - 1]) return apiError(400, 'INVALID_ARGUMENT', 'versionNumber');
      if (method === 'POST' && id === undefined) {
        const deploymentId = `AKfycbFake${++serial}`;
        project.deployments.set(deploymentId, version);
        return json(200, deploymentView(project, deploymentId, config ?? {}));
      }
      if (method === 'PUT' && id !== undefined && project.deployments.has(id)) {
        project.deployments.set(id, version);
        return json(200, deploymentView(project, id, config ?? {}));
      }
    }
    return apiError(404, 'NOT_FOUND', 'Requested entity was not found.');
  }

  // POST to the web app: Apps Script runs doPost and redirects to where its reply can be read.
  async function webApp(deploymentId: string, body: string): Promise<Response> {
    const project = [...google.projects.values()].find(p => p.deployments.has(deploymentId));
    const version = project?.deployments.get(deploymentId);
    if (!project || version === undefined) return new Response('Sorry, unable to open the file at this time.', { status: 404 });
    if (!project.authorized) {
      return new Response('<html>Authorization is required to perform that action.</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    const sources = (project.versions[version - 1] ?? []).filter(file => file.type === 'SERVER_JS').map(file => file.source);
    if (!project.gas) project.gas = await fakeAppsScript({ world, files: sources });
    else if (project.loaded !== version) project.gas.load(sources);
    project.loaded = version;
    const key = `fake-key-${++serial}`;
    replies.set(key, project.gas.doPost(body).text);
    return new Response(null, { status: 302, headers: { location: `https://script.googleusercontent.com/macros/echo?user_content_key=${key}` } });
  }

  const next: Fetch = world.fetch;
  world.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const hosts = ['oauth2.googleapis.com', 'script.googleapis.com', 'script.google.com', 'script.googleusercontent.com'];
    if (!hosts.includes(url.host)) return next(input, init);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const text = typeof init.body === 'string' ? init.body : '';
    google.requests.push({ method, url: url.href });
    if (headers.get('user-agent') !== USER_AGENT) google.violations.push(`user-agent ${url.href}`);
    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token' && method === 'POST') {
      if (headers.get('content-type') !== 'application/x-www-form-urlencoded') google.violations.push('token form');
      return token(Object.fromEntries(new URLSearchParams(text)));
    }
    if (url.host === 'script.googleapis.com') {
      const access = google.accessTokens.get(headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
      if (!access || access.expiresAt <= world.now) return apiError(401, 'UNAUTHENTICATED', 'Request had invalid authentication credentials.');
      let body: Record<string, unknown> = {};
      try { body = text ? JSON.parse(text) : {}; } catch { return apiError(400, 'INVALID_ARGUMENT', 'Invalid JSON payload received.'); }
      return scriptApi(method, url.pathname, body, access.scopes);
    }
    const exec = url.host === 'script.google.com' && url.pathname.match(/^\/macros\/s\/([^/]+)\/exec$/);
    if (exec && method === 'POST') {
      if (init.redirect !== 'manual') google.violations.push('web app redirect followed by fetch');
      return webApp(exec[1] ?? '', text);
    }
    const key = url.host === 'script.googleusercontent.com' && url.pathname === '/macros/echo' && url.searchParams.get('user_content_key');
    if (key && method === 'GET' && replies.has(key)) {
      const reply = replies.get(key) ?? '';
      replies.delete(key);
      return new Response(reply, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    google.violations.push(`${method} ${url.href}`);
    return new Response('Not Found', { status: 404 });
  };
  return google;
}
