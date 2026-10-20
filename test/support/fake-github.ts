// GitHub side of the fake world: device flow of the project's OAuth App and the REST calls
// the CLI makes (user, repos and their deletion, contents, Actions secrets with sealed boxes, dispatch, runs,
// job logs). withGitHub(world) chains it in front of world.fetch, so one fetch serves
// ChatGPT, auth.openai.com and GitHub. A dispatch, or github.schedule for the cron, hands the
// repository to world.github.runner. Its replies have the shapes the real client reads.
import { createHash } from 'node:crypto';
import sodium from 'libsodium-wrappers';
import { GITHUB_OAUTH_CLIENT_ID } from '../../src/github/oauth-app.ts';
import { USER_AGENT } from '../../src/chatgpt/http.ts';
import type { Fetch } from '../../src/chatgpt/http.ts';
import type { Repository, WorkflowRun, NewRepositoryBody, PutFileBody, PutSecretBody, DispatchBody } from '../../src/github/api.ts';

export interface FakeRun extends WorkflowRun {
  inputs: Record<string, string>;
  log: string;
  queuedUntil?: number;
}
export interface FakeRepository {
  meta: { name: string; private: boolean; description: string | null };
  files: Map<string, { text: string; sha: string }>;
  commits: { message: string; paths: string[] }[];
  // name → sealed value, as GitHub keeps it.
  secrets: Map<string, string>;
  // The latest first.
  runs: FakeRun[];
  workflowState: string;
}
// What the runner made of a run; null or undefined leaves it queued.
export type RunResult = { conclusion: string; log: string } | null | undefined;
export type Runner = (repo: FakeRepository, run: FakeRun) => RunResult | Promise<RunResult>;
// true: the user approves the code, false: not yet, 'denied': refuses it.
export type Approval = boolean | 'denied';

export interface FakeGitHub {
  login: string;
  devices: Map<string, { userCode: string; approved: Approval; polls: number; scope: string }>;
  // access token → the scopes the user granted to it.
  tokens: Map<string, string[]>;
  repos: Map<string, FakeRepository>;
  requests: { host: string; method: string; path: string; body: string }[];
  violations: string[];
  runner: Runner | null;
  // Dispatches refused as right after the workflow's push: 404, the last one 422 (trigger not
  // registered yet). Until then its runs are 404 too.
  dispatchNotFound: number;
  // Job log reads answered 404 after the run completed, before the log is ready.
  logDelay: number;
  // (method, path) → Response | null, to break one call; a rejected promise drops the connection.
  fail: ((method: string, path: string) => Response | Promise<Response> | null | undefined) | null;
  // How long a dispatched run waits in the queue before the runner takes it, as in an outage.
  queueMs: number;
  // false: a dispatch answers 204 even when asked for the run, as before return_run_details.
  runDetails: boolean;
  approve(userCode: string, answer?: Approval): void;
  repo(name?: string): FakeRepository | undefined;
  // The text of a file that must be there.
  text(repo: FakeRepository, path: string): string;
  write(repo: FakeRepository, path: string, text: string): void;
  setSecret(repo: FakeRepository, name: string, value: string): void;
  schedule(repo?: FakeRepository): Promise<FakeRun> | null;
  dispatch(repo?: FakeRepository): Promise<FakeRun>;
  secret(repo: FakeRepository, name: string): string | undefined;
}
// The part of the fake world GitHub runs in: its fetch and clock.
export interface GitHubWorld { fetch: Fetch; now: number; github?: FakeGitHub }

// Any of the JSON bodies the client sends; the fake reads them as they come.
type Sent = Partial<NewRepositoryBody & PutFileBody & PutSecretBody & DispatchBody>;

const json = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const blobSha = (text: string): string => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');

export async function withGitHub(world: GitHubWorld, { login = 'octo-fake' }: { login?: string } = {}): Promise<FakeGitHub> {
  await sodium.ready;
  const keys = sodium.crypto_box_keypair();
  let serial = 0;
  const github: FakeGitHub = {
    login, devices: new Map(), tokens: new Map(), repos: new Map(), requests: [], violations: [],
    runner: null, dispatchNotFound: 0, logDelay: 0, fail: null, queueMs: 0, runDetails: true,
    approve: (userCode, answer = true) => {
      for (const device of github.devices.values()) if (device.userCode === userCode) device.approved = answer;
    },
    repo: (name = 'codex-auto-resets-worker') => github.repos.get(`${login}/${name}`),
    text: (repo, path) => {
      const file = repo.files.get(path);
      if (!file) throw new Error(`no ${path} in ${repo.meta.name}`);
      return file.text;
    },
    // A commit by someone other than the CLI, e.g. the worker's own push.
    write: (repo, path, text) => {
      repo.files.set(path, { text, sha: blobSha(text) });
      repo.commits.push({ message: `write ${path}`, paths: [path] });
    },
    // A secret set by hand in the repository settings.
    setSecret: (repo, name, value) => {
      repo.secrets.set(name, Buffer.from(sodium.crypto_box_seal(Buffer.from(value), keys.publicKey)).toString('base64'));
    },
    // The hourly cron fires; a disabled workflow does not run.
    schedule: (repo = github.repo()) => {
      if (!repo) throw new Error('no worker repository to schedule');
      return repo.workflowState === 'active' ? startRun(repo, 'schedule', {}) : null;
    },
    // A run started by hand with the Run workflow button.
    dispatch: (repo = github.repo()) => {
      if (!repo) throw new Error('no worker repository to dispatch');
      return startRun(repo, 'workflow_dispatch', {});
    },
    secret: (repo, name) => {
      const sealed = repo.secrets.get(name);
      return sealed && Buffer.from(sodium.crypto_box_seal_open(Buffer.from(sealed, 'base64'), keys.publicKey, keys.privateKey)).toString();
    },
  };
  world.github = github;

  // A field the client always sends: without it the call fails, as a crash of the fake did.
  function sent<K extends keyof Sent>(body: Sent, field: K): NonNullable<Sent[K]> {
    const value = body[field];
    if (value == null) {
      github.violations.push(`no ${field} in the request`);
      throw new Error(`fake GitHub: no ${field} in the request`);
    }
    return value;
  }

  // One run of the workflow: dispatched with inputs, or by the cron (event 'schedule').
  async function startRun(repo: FakeRepository, event: string, inputs: Record<string, string>): Promise<FakeRun> {
    const at = new Date(world.now).toISOString();
    const run: FakeRun = { id: 9000 + ++serial, event, status: 'queued', conclusion: null, created_at: at, run_started_at: at, updated_at: at,
      html_url: `https://github.com/${login}/${repo.meta.name}/actions/runs/${9000 + serial}`, inputs, log: '' };
    repo.runs.unshift(run);
    if (github.queueMs) run.queuedUntil = world.now + github.queueMs;
    else await execute(repo, run);
    return run;
  }
  async function execute(repo: FakeRepository, run: FakeRun): Promise<void> {
    delete run.queuedUntil;
    const result = await github.runner?.(repo, run);
    if (result) Object.assign(run, { status: 'completed', conclusion: result.conclusion, log: result.log });
  }
  // The runner takes the queued runs whose time has come.
  async function dequeue(repo: FakeRepository): Promise<void> {
    for (const run of repo.runs) if (run.queuedUntil !== undefined && run.queuedUntil <= world.now) await execute(repo, run);
  }

  function device(path: string, data: Record<string, string>): Response {
    if (data.client_id !== GITHUB_OAUTH_CLIENT_ID) return json(400, { error: 'incorrect_client_credentials' });
    if (path === '/login/device/code') {
      const scope = data.scope ?? '';
      if (!['repo workflow', 'repo workflow delete_repo'].includes(scope)) github.violations.push(`scope ${data.scope}`);
      const id = `gh-device-${++serial}`, userCode = `GHFK-${1000 + serial}`;
      github.devices.set(id, { userCode, approved: false, polls: 0, scope });
      return json(200, { device_code: id, user_code: userCode, verification_uri: 'https://github.com/login/device',
        expires_in: 899, interval: 5 });
    }
    const deviceCode = data.device_code ?? '';
    const entry = github.devices.get(deviceCode);
    if (data.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') return json(200, { error: 'unsupported_grant_type' });
    if (!entry) return json(200, { error: 'expired_token' });
    if (entry.approved === 'denied') return json(200, { error: 'access_denied' });
    if (!entry.approved) return json(200, { error: entry.polls++ === 0 ? 'slow_down' : 'authorization_pending', interval: 10 });
    github.devices.delete(deviceCode);
    const token = `gho_fake${String(++serial).padStart(32, '0')}`;
    github.tokens.set(token, entry.scope.split(' '));
    return json(200, { access_token: token, token_type: 'bearer', scope: entry.scope.replaceAll(' ', ',') });
  }

  const repoView = (repo: FakeRepository): Repository => ({ ...repo.meta, full_name: `${login}/${repo.meta.name}`,
    html_url: `https://github.com/${login}/${repo.meta.name}`, default_branch: 'main', owner: { login } });
  const runView = ({ log, inputs, queuedUntil, ...run }: FakeRun): WorkflowRun => run;

  async function api(method: string, url: URL, body: Sent, scopes: string[]): Promise<Response | null> {
    const path = url.pathname;
    if (path === '/user' && method === 'GET') return json(200, { login, id: 1 });
    if (path === '/user/repos' && method === 'POST') {
      const name = sent(body, 'name');
      if (github.repos.has(`${login}/${name}`)) return json(422, { message: 'Repository creation failed.' });
      const repo: FakeRepository = { meta: { name, private: body.private === true, description: body.description ?? null },
        files: new Map(), commits: [], secrets: new Map(), runs: [], workflowState: 'active' };
      github.repos.set(`${login}/${name}`, repo);
      return json(201, repoView(repo));
    }
    const match = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    const repo = match && github.repos.get(`${match[1]}/${match[2]}`);
    if (!match || !repo) return json(404, { message: 'Not Found' });
    const rest = match[3] ?? '';
    if (rest === '' && method === 'GET') return json(200, repoView(repo));
    // Deleting a repository takes the delete_repo scope on top of repo.
    if (rest === '' && method === 'DELETE') {
      if (!scopes.includes('delete_repo')) return json(403, { message: 'Must have admin rights to Repository.' });
      github.repos.delete(`${match[1]}/${match[2]}`);
      return new Response(null, { status: 204 });
    }
    if (rest.startsWith('/contents/')) {
      const file = decodeURIComponent(rest.slice('/contents/'.length));
      const current = repo.files.get(file);
      if (method === 'GET') {
        // An empty repository answers 404 to every contents read.
        if (!current) return json(404, { message: repo.files.size ? 'Not Found' : 'This repository is empty.' });
        return json(200, { type: 'file', path: file, sha: current.sha, encoding: 'base64',
          content: Buffer.from(current.text).toString('base64').replace(/(.{60})/g, '$1\n') });
      }
      if (method === 'PUT') {
        if (current && body.sha !== current.sha) return json(current && !body.sha ? 422 : 409, { message: 'sha mismatch' });
        if (!current && body.sha) return json(404, { message: 'Not Found' });
        const text = Buffer.from(sent(body, 'content'), 'base64').toString('utf8');
        repo.files.set(file, { text, sha: blobSha(text) });
        repo.commits.push({ message: sent(body, 'message'), paths: [file] });
        return json(current ? 200 : 201, { content: { path: file, sha: blobSha(text) } });
      }
    }
    if (rest === '/actions/secrets/public-key' && method === 'GET') {
      return json(200, { key_id: 'fake-key-id', key: Buffer.from(keys.publicKey).toString('base64') });
    }
    const secret = rest.match(/^\/actions\/secrets\/([A-Z0-9_]+)$/)?.[1];
    if (secret && method === 'GET') return repo.secrets.has(secret) ? json(200, { name: secret }) : json(404, { message: 'Not Found' });
    if (secret && method === 'DELETE') return new Response(null, { status: repo.secrets.delete(secret) ? 204 : 404 });
    if (secret && method === 'PUT') {
      if (body.key_id !== 'fake-key-id') return json(422, { message: 'Bad key id' });
      const existed = repo.secrets.has(secret);
      repo.secrets.set(secret, sent(body, 'encrypted_value'));
      return new Response(null, { status: existed ? 204 : 201 });
    }
    const workflow = rest.match(/^\/actions\/workflows\/([^/]+)(?:\/(dispatches|runs))?$/);
    if (workflow) {
      const exists = [...repo.files.keys()].includes(`.github/workflows/${workflow[1]}`);
      if (!workflow[2] && method === 'GET') {
        if (!exists || github.dispatchNotFound > 0) return json(404, { message: 'Not Found' });
        return json(200, { id: 77, name: 'aures', path: `.github/workflows/${workflow[1]}`, state: repo.workflowState });
      }
      if (workflow[2] === 'dispatches' && method === 'POST') {
        if (!exists) return json(404, { message: 'Not Found' });
        if (github.dispatchNotFound > 0) {
          return json(github.dispatchNotFound-- > 1 ? 404 : 422, { message: "Workflow does not have 'workflow_dispatch' trigger" });
        }
        if (body.ref !== 'main') return json(422, { message: 'No ref found' });
        if (repo.workflowState !== 'active') return json(422, { message: 'Cannot trigger a \'workflow_dispatch\' on a disabled workflow' });
        // GitHub refuses an input the workflow does not declare.
        const declared = repo.files.get(`.github/workflows/${workflow[1]}`)?.text ?? '';
        const unexpected = Object.keys(sent(body, 'inputs')).filter(input => !declared.includes(`\n      ${input}:\n`));
        if (unexpected.length) return json(422, { message: `Unexpected inputs provided: ${JSON.stringify(unexpected)}` });
        const run = await startRun(repo, 'workflow_dispatch', sent(body, 'inputs'));
        if (body.return_run_details !== true || !github.runDetails) return new Response(null, { status: 204 });
        const url = `https://api.github.com/repos/${login}/${repo.meta.name}/actions/runs/${run.id}`;
        return json(200, { workflow_run_id: run.id, run_url: url, html_url: run.html_url });
      }
      if (workflow[2] === 'runs' && method === 'GET') {
        if (!exists || github.dispatchNotFound > 0) return json(404, { message: 'Not Found' });
        await dequeue(repo);
        const event = url.searchParams.get('event');
        const perPage = Number(url.searchParams.get('per_page') ?? 30);
        const runs = repo.runs.filter(r => !event || r.event === event).slice(0, perPage).map(runView);
        return json(200, { total_count: runs.length, workflow_runs: runs });
      }
    }
    const runPath = rest.match(/^\/actions\/runs\/(\d+)(\/jobs)?$/);
    const run = runPath && repo.runs.find(r => r.id === Number(runPath[1]));
    if (runPath && run && method === 'GET') {
      await dequeue(repo);
      return runPath[2] ? json(200, { total_count: 1, jobs: [{ id: run.id * 10, run_id: run.id, status: run.status }] }) : json(200, runView(run));
    }
    const job = rest.match(/^\/actions\/jobs\/(\d+)\/logs$/);
    const logged = job && repo.runs.find(r => r.id * 10 === Number(job[1]));
    if (logged && method === 'GET' && github.logDelay-- > 0) return json(404, { message: 'Not Found' });
    if (logged && method === 'GET') return new Response(logged.log, { status: 200, headers: { 'content-type': 'text/plain' } });
    return null;
  }

  const next = world.fetch;
  world.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.host !== 'github.com' && url.host !== 'api.github.com') return next(input, init);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const text = typeof init.body === 'string' ? init.body : '';
    github.requests.push({ host: url.host, method, path: url.pathname, body: text });
    if (headers.get('user-agent') !== USER_AGENT) github.violations.push(`user-agent ${url.pathname}`);
    const broken = github.fail?.(method, url.pathname);
    if (broken) return broken;
    if (url.host === 'github.com') {
      if (method === 'POST' && ['/login/device/code', '/login/oauth/access_token'].includes(url.pathname)) {
        if (headers.get('accept') !== 'application/json') github.violations.push(`accept ${url.pathname}`);
        if (headers.get('content-type') !== 'application/x-www-form-urlencoded') github.violations.push(`form ${url.pathname}`);
        return device(url.pathname, Object.fromEntries(new URLSearchParams(text)));
      }
    } else {
      let body: Sent | null = null;
      try { body = text ? JSON.parse(text) : null; } catch { return json(400, { message: 'Problems parsing JSON' }); }
      const scopes = github.tokens.get(headers.get('authorization')?.replace(/^Bearer /, '') ?? '');
      if (!scopes) return json(401, { message: 'Bad credentials' });
      const reply = await api(method, url, body ?? {}, scopes);
      if (reply) return reply;
    }
    github.violations.push(`${method} ${url.href}`);
    return json(404, { message: 'Not Found' });
  };
  return github;
}
