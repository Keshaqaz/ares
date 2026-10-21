import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { GOOGLE_OAUTH_CLIENT } from './oauth-client.ts';
import { USER_AGENT } from '../chatgpt/http.ts';
import type { Fetch } from '../chatgpt/http.ts';
import { t } from '../cli/language.ts';

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const SCRIPT_API = 'https://script.googleapis.com/v1';
// What the CLI deploys with; the consent screen shows each with a box the user may leave unticked.
export const GOOGLE_SCOPES = {
  projects: 'https://www.googleapis.com/auth/script.projects',
  deployments: 'https://www.googleapis.com/auth/script.deployments',
} as const;
export type GoogleScope = keyof typeof GOOGLE_SCOPES;
// Asked on top, for the email of the account that the screen «Воркер» names. Never required: a
// grant without them, such as one from before them, is no broken grant, just one without an email.
export const EMAIL_SCOPES = ['openid', 'email'] as const;
// An access token is refreshed this long before it expires.
const EXPIRY_MARGIN_MS = 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

// What a call was for; a refusal names it in its reason.
type Purpose = 'token' | 'refresh' | 'create_project' | 'get_project' | 'get_content' | 'update_content' | 'create_version' |
  'create_deployment' | 'update_deployment' | 'delete_deployment' | 'list_deployments' | 'web_app' | 'revoke';
// api_disabled: the user has not turned on the Apps Script API in script.google.com/home/usersettings.
// invalid_grant: the refresh token is gone (revoked, or 7 days old in testing mode).
export type GoogleFailureReason = 'network' | 'unauthorized' | 'invalid_grant' | 'api_disabled' | `${Purpose}_${number}` |
  `${Purpose}_invalid` | 'login_denied' | 'login_timeout' | `login_${string}`;

// Google refused or could not be reached.
export class GoogleFailure extends Error {
  reason: GoogleFailureReason;
  constructor(reason: GoogleFailureReason) { super(reason); this.reason = reason; }
}
// The user left boxes of the consent unticked: the grant lacks these scopes.
export class ScopesMissing extends Error {
  missing: GoogleScope[];
  constructor(missing: GoogleScope[]) { super(`scopes missing: ${missing.join(' ')}`); this.missing = missing; }
}

interface SendOptions { method?: string; headers?: Record<string, string>; body?: unknown; redirect?: RequestRedirect }
// value: the parsed JSON body (null for none or not JSON), text: the body as is.
export interface GoogleReply { status: number; value: unknown; text: string; location: string | null }

export async function send(fetch: Fetch, url: string, { method = 'GET', headers = {}, body, redirect = 'follow' }: SendOptions = {}):
  Promise<GoogleReply> {
  let response, text;
  try {
    const form = body instanceof URLSearchParams;
    response = await fetch(url, { method, redirect, body: body === undefined ? undefined : form ? body.toString() : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000), headers: { 'user-agent': USER_AGENT,
        ...(body === undefined ? {} : { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }), ...headers } });
    text = await response.text();
  } catch { throw new GoogleFailure('network'); }
  let value: unknown = null;
  try { value = text ? JSON.parse(text) : null; } catch { /* an HTML page */ }
  return { status: response.status, value, text, location: response.headers.get('location') };
}

// An access token and when it runs out, in ms.
export interface AccessToken { token: string; expiresAt: number }
// What a sign-in gives: the refresh token to keep, a fresh access token and the account's email
// from the id_token, null without one.
export interface GoogleGrant { refreshToken: string; access: AccessToken; email: string | null }
interface TokenReply { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; id_token?: unknown; error?: unknown }

// The email claim of the id_token the token endpoint gave over TLS: not a credential, so it is read without its signature.
function emailOf(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  try {
    const email: unknown = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8'))?.email;
    return typeof email === 'string' && email ? email : null;
  } catch { return null; }
}

// One call to the token endpoint as the project's client; access is null when the reply has no access token.
async function requestToken(fetch: Fetch, now: () => number, form: Record<string, string>):
  Promise<{ status: number; tokens: TokenReply | null; access: AccessToken | null }> {
  const started = now();
  const reply = await send(fetch, TOKEN, { method: 'POST', body: new URLSearchParams({ ...form,
    client_id: GOOGLE_OAUTH_CLIENT.id, client_secret: GOOGLE_OAUTH_CLIENT.secret }) });
  const tokens = reply.value as TokenReply | null;
  const access = typeof tokens?.access_token === 'string' ?
    { token: tokens.access_token, expiresAt: started + (Number(tokens.expires_in) || 3600) * 1000 } : null;
  return { status: reply.status, tokens, access };
}

const base64url = (bytes: Buffer): string => bytes.toString('base64url');
const PAGE = { 'content-type': 'text/plain; charset=utf-8' };

export interface GoogleLoginOptions {
  fetch: Fetch;
  // Opens the consent page in the browser.
  open: (url: string) => unknown;
  now: () => number;
  timeoutMs?: number;
}

// Sign-in of the Desktop client: the browser shows Google's consent, then returns to a one-off
// server on 127.0.0.1 with the code, which the CLI exchanges with its PKCE verifier. Throws
// ScopesMissing when the user left a box unticked.
export async function googleLogin({ fetch, open, now, timeoutMs = LOGIN_TIMEOUT_MS }: GoogleLoginOptions): Promise<GoogleGrant> {
  const verifier = base64url(randomBytes(32)), state = base64url(randomBytes(16));
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let code: string;
  try {
    // Only the redirect with our state ends the wait: a favicon or a stray tab does not.
    const returned = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new GoogleFailure('login_timeout')), timeoutMs);
      timer.unref();
      server.on('request', (request, response) => {
        const query = new URL(request.url ?? '/', redirect).searchParams;
        if (query.get('state') !== state) { response.writeHead(404, PAGE).end(); return; }
        const given = query.get('code'), error = query.get('error');
        response.writeHead(200, PAGE).end(given ? t('aures: signed in to Google, go back to the terminal.', 'aures: вход в Google выполнен, вернитесь в терминал.') :
          t('aures: the Google sign-in did not succeed, go back to the terminal.', 'aures: вход в Google не удался, вернитесь в терминал.'));
        clearTimeout(timer);
        if (given) resolve(given);
        else reject(new GoogleFailure(error === 'access_denied' ? 'login_denied' : `login_${error ?? 'no_code'}`));
      });
    });
    // The browser may come back before open resolves; the failure is read below.
    returned.catch(() => {});
    await open(`${AUTHORIZE}?${new URLSearchParams({ client_id: GOOGLE_OAUTH_CLIENT.id, redirect_uri: redirect, response_type: 'code',
      scope: [...Object.values(GOOGLE_SCOPES), ...EMAIL_SCOPES].join(' '), code_challenge: base64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', state })}`);
    code = await returned;
  } finally { server.close(); }

  const { status, tokens, access } = await requestToken(fetch, now, { code, code_verifier: verifier, redirect_uri: redirect,
    grant_type: 'authorization_code' });
  if (status !== 200) throw new GoogleFailure(`token_${status}`);
  if (!access || typeof tokens?.refresh_token !== 'string' || typeof tokens.scope !== 'string') throw new GoogleFailure('token_invalid');
  const granted = tokens.scope.split(' ');
  const missing = (Object.keys(GOOGLE_SCOPES) as GoogleScope[]).filter(scope => !granted.includes(GOOGLE_SCOPES[scope]));
  if (missing.length) throw new ScopesMissing(missing);
  return { refreshToken: tokens.refresh_token, access, email: emailOf(tokens.id_token) };
}

// One file of a script project, as updateContent takes it.
export interface ScriptFile { name: string; type: 'JSON' | 'SERVER_JS'; source: string }
// A deployment of the project and the URL of its web app.
export interface Deployment { deploymentId: string; url: string }
// The JSON bodies the client sends.
export interface DeploymentConfig { versionNumber: number; manifestFileName: string; description: string }
interface DeploymentReply { deploymentId?: unknown; deploymentConfig?: { versionNumber?: unknown };
  entryPoints?: { entryPointType?: unknown; webApp?: { url?: unknown } }[] }

export interface GoogleApiOptions { fetch: Fetch; now: () => number; refreshToken: string; access?: AccessToken }

// Apps Script API calls of the CLI with the user's grant. The access token lives in memory only
// and comes from the refresh token when it runs out.
export class GoogleApi {
  fetch: Fetch;
  now: () => number;
  refreshToken: string;
  access: AccessToken | null;
  constructor({ fetch, now, refreshToken, access }: GoogleApiOptions) {
    this.fetch = fetch;
    this.now = now;
    this.refreshToken = refreshToken;
    this.access = access ?? null;
  }

  // A valid access token; throws invalid_grant when the refresh token is gone.
  async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - EXPIRY_MARGIN_MS > this.now()) return this.access.token;
    const { status, tokens, access } = await requestToken(this.fetch, this.now, { refresh_token: this.refreshToken, grant_type: 'refresh_token' });
    if (tokens?.error === 'invalid_grant') throw new GoogleFailure('invalid_grant');
    if (status !== 200) throw new GoogleFailure(`refresh_${status}`);
    if (!access) throw new GoogleFailure('refresh_invalid');
    this.access = access;
    return access.token;
  }

  async expect(what: Purpose, path: string, method: string, body?: unknown): Promise<unknown> {
    const reply = await send(this.fetch, `${SCRIPT_API}${path}`, { method, body,
      headers: { authorization: `Bearer ${await this.accessToken()}` } });
    if (reply.status === 401) throw new GoogleFailure('unauthorized');
    const message = (reply.value as { error?: { message?: unknown } } | null)?.error?.message;
    // Probe 01: «User has not enabled the Apps Script API. Enable it by visiting https://script.google.com/home/usersettings then retry…»
    if (reply.status === 403 && typeof message === 'string' && message.includes('has not enabled the Apps Script API')) {
      throw new GoogleFailure('api_disabled');
    }
    if (reply.status !== 200) throw new GoogleFailure(`${what}_${reply.status}`);
    return reply.value;
  }

  // The project's title; throws get_project_404 when there is no such project.
  async projectTitle(scriptId: string): Promise<string> {
    const project = await this.expect('get_project', `/projects/${encodeURIComponent(scriptId)}`, 'GET') as { title?: unknown } | null;
    if (typeof project?.title !== 'string') throw new GoogleFailure('get_project_invalid');
    return project.title;
  }
  async createProject(title: string): Promise<string> {
    const project = await this.expect('create_project', '/projects', 'POST', { title }) as { scriptId?: unknown } | null;
    if (typeof project?.scriptId !== 'string') throw new GoogleFailure('create_project_invalid');
    return project.scriptId;
  }
  // Replaces every file of the project.
  async updateContent(scriptId: string, files: ScriptFile[]): Promise<void> {
    await this.expect('update_content', `/projects/${encodeURIComponent(scriptId)}/content`, 'PUT', { files });
  }
  // The project's files as they are now, not as a deployment serves them.
  async content(scriptId: string): Promise<ScriptFile[]> {
    const content = await this.expect('get_content', `/projects/${encodeURIComponent(scriptId)}/content`, 'GET') as { files?: unknown } | null;
    if (!Array.isArray(content?.files)) throw new GoogleFailure('get_content_invalid');
    return content.files as ScriptFile[];
  }
  // A version is a frozen copy of the content; a deployment serves one.
  async createVersion(scriptId: string, description: string): Promise<number> {
    const version = await this.expect('create_version', `/projects/${encodeURIComponent(scriptId)}/versions`, 'POST', { description }) as
      { versionNumber?: unknown } | null;
    if (typeof version?.versionNumber !== 'number') throw new GoogleFailure('create_version_invalid');
    return version.versionNumber;
  }
  async createDeployment(scriptId: string, config: DeploymentConfig): Promise<Deployment> {
    return deployment('create_deployment', await this.expect('create_deployment', `/projects/${encodeURIComponent(scriptId)}/deployments`,
      'POST', config));
  }
  // Points the deployment at another version: its web app keeps its URL.
  async updateDeployment(scriptId: string, deploymentId: string, config: DeploymentConfig): Promise<Deployment> {
    return deployment('update_deployment', await this.expect('update_deployment',
      `/projects/${encodeURIComponent(scriptId)}/deployments/${encodeURIComponent(deploymentId)}`, 'PUT', { deploymentConfig: config }));
  }
  // Its web app stops answering; a deployment already gone counts as deleted.
  async deleteDeployment(scriptId: string, deploymentId: string): Promise<void> {
    try {
      await this.expect('delete_deployment', `/projects/${encodeURIComponent(scriptId)}/deployments/${encodeURIComponent(deploymentId)}`, 'DELETE');
    } catch (error) { if (!(error instanceof GoogleFailure && error.reason === 'delete_deployment_404')) throw error; }
  }
  // The deployments that serve a version as a web app; the head deployment of the editor is not one of them.
  async deployments(scriptId: string): Promise<Deployment[]> {
    const reply = await this.expect('list_deployments', `/projects/${encodeURIComponent(scriptId)}/deployments`, 'GET') as
      { deployments?: unknown } | null;
    const all = Array.isArray(reply?.deployments) ? reply.deployments as DeploymentReply[] : [];
    return all.filter(one => typeof one.deploymentConfig?.versionNumber === 'number').flatMap(one => {
      try { return [deployment('list_deployments', one)]; } catch { return []; }
    });
  }
}

function deployment(what: 'create_deployment' | 'update_deployment' | 'list_deployments', value: unknown): Deployment {
  const reply = value as DeploymentReply | null;
  const url = reply?.entryPoints?.find(entry => entry.entryPointType === 'WEB_APP')?.webApp?.url;
  if (typeof reply?.deploymentId !== 'string' || typeof url !== 'string') throw new GoogleFailure(`${what}_invalid`);
  return { deploymentId: reply.deploymentId, url };
}

// Ends the CLI's grant: the refresh token and the access tokens it gave stop working. A token
// already gone (revoked, or 7 days old in testing mode) counts as ended.
export async function revokeGoogle(fetch: Fetch, refreshToken: string): Promise<void> {
  const reply = await send(fetch, REVOKE, { method: 'POST', body: new URLSearchParams({ token: refreshToken }) });
  if (reply.status !== 200 && (reply.value as { error?: unknown } | null)?.error !== 'invalid_token') throw new GoogleFailure(`revoke_${reply.status}`);
}

// One doPost of the worker's web app. Apps Script answers the POST with a redirect to
// script.googleusercontent.com, where a GET reads the reply. null when the reply is not JSON:
// the script is not authorized yet and Google shows a page instead.
export async function postWorker(fetch: Fetch, url: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  let reply = await send(fetch, url, { method: 'POST', body, redirect: 'manual' });
  if ([301, 302, 303].includes(reply.status) && reply.location) reply = await send(fetch, new URL(reply.location, url).href);
  if (reply.status !== 200) throw new GoogleFailure(`web_app_${reply.status}`);
  const value = reply.value;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
