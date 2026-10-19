import sodium from 'libsodium-wrappers';
import { GITHUB_OAUTH_CLIENT_ID } from './oauth-app.ts';
import { USER_AGENT } from '../chatgpt/http.ts';
import type { Fetch } from '../chatgpt/http.ts';

const API = 'https://api.github.com';
const GITHUB_SCOPES = 'repo workflow';
// `uninstall` alone needs to delete the repository, which repo does not cover.
export const UNINSTALL_SCOPES = `${GITHUB_SCOPES} delete_repo`;

// What a REST call was for; a refusal names it in its reason.
type Purpose = 'user' | 'repository' | 'create_repository' | 'delete_repository' | 'read_file' | 'write_file' | 'read_secret' |
  'secret_key' | 'write_secret' | 'delete_secret' | 'dispatch' | 'workflow' | 'runs' | 'run' | 'jobs';
export type GitHubFailureReason = 'network' | 'unauthorized' | `${Purpose}_${number}` | 'user_invalid' | 'read_file_invalid' |
  `device_code_${number}` | 'login_timeout' | 'login_denied' | `login_${string}`;

// GitHub refused or could not be reached. reason: network, unauthorized, or `<what>_<status>`.
export class GitHubFailure extends Error {
  reason: GitHubFailureReason;
  constructor(reason: GitHubFailureReason) { super(reason); this.reason = reason; }
}

// The parts of GitHub's replies the CLI reads; they are typed, not checked.
export interface Repository {
  name: string; full_name: string; html_url: string; default_branch: string; private: boolean; description: string | null;
  owner: { login: string };
}
export interface WorkflowRun {
  id: number; event: string; status: string; conclusion: string | null; html_url: string;
  created_at: string; run_started_at: string; updated_at: string;
}
interface Runs { workflow_runs?: WorkflowRun[] }

// The JSON bodies the client sends.
export interface NewRepositoryBody {
  name: string; description: string; private: boolean; auto_init: boolean; has_issues: boolean; has_projects: boolean;
  has_wiki: boolean;
}
// sha is absent for a new file.
export interface PutFileBody { message: string; content: string; sha?: string }
export interface PutSecretBody { key_id: string; encrypted_value: string }
export interface DispatchBody { ref: string; inputs: Record<string, string> }
// A file on the default branch; sha names this version of it.
export interface RepositoryFile { text: string; sha: string }

interface SendOptions {
  method?: string;
  headers?: Record<string, string>;
  // Sent as JSON, or as a form for URLSearchParams.
  body?: unknown;
  timeoutMs?: number;
}
// value: the parsed JSON body (null for none or plain text), text: the body as is.
interface GitHubReply { status: number; value: unknown; text: string }

async function send(fetch: Fetch, url: string, { method = 'GET', headers = {}, body, timeoutMs = 30_000 }: SendOptions = {}): Promise<GitHubReply> {
  let response, text;
  try {
    // Job logs redirect to blob storage; fetch drops the Authorization header across origins.
    const form = body instanceof URLSearchParams;
    response = await fetch(url, { method, body: body === undefined ? undefined : form ? body.toString() : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': USER_AGENT,
        ...(body === undefined ? {} : { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }), ...headers } });
    text = await response.text();
  } catch { throw new GitHubFailure('network'); }
  let value: unknown = null;
  try { value = text ? JSON.parse(text) : null; } catch { /* plain text: logs, error pages */ }
  return { status: response.status, value, text };
}

export interface DeviceCode { userCode: string; verificationUrl: string }
export interface GitHubDeviceLoginOptions {
  fetch: Fetch;
  onCode: (code: DeviceCode) => unknown;
  sleep: (ms: number) => Promise<unknown>;
  now: () => number;
  scopes?: string;
}

interface DeviceCodeReply { device_code?: unknown; user_code?: unknown; verification_uri: string; interval?: unknown; expires_in?: unknown }
interface TokenReply { access_token?: unknown; error?: string; interval?: unknown }

// Device flow of the project's OAuth App: the user enters onCode's userCode at
// verificationUrl while we poll. Returns the user's access token; it never expires.
export async function githubDeviceLogin({ fetch, onCode, sleep, now, scopes = GITHUB_SCOPES }: GitHubDeviceLoginOptions): Promise<string> {
  const headers = { accept: 'application/json' };
  const issued = await send(fetch, 'https://github.com/login/device/code', { method: 'POST', headers,
    body: new URLSearchParams({ client_id: GITHUB_OAUTH_CLIENT_ID, scope: scopes }) });
  const device = issued.value as DeviceCodeReply | null;
  if (issued.status !== 200 || typeof device?.device_code !== 'string' || typeof device.user_code !== 'string') {
    throw new GitHubFailure(`device_code_${issued.status}`);
  }
  const deviceCode = device.device_code;
  await onCode({ userCode: device.user_code, verificationUrl: device.verification_uri });
  let interval = Math.max(1, Number(device.interval) || 5) * 1000;
  const deadline = now() + Math.max(60, Number(device.expires_in) || 900) * 1000;
  for (;;) {
    if (now() >= deadline) throw new GitHubFailure('login_timeout');
    await sleep(interval);
    let poll: GitHubReply;
    try {
      poll = await send(fetch, 'https://github.com/login/oauth/access_token', { method: 'POST', headers,
        body: new URLSearchParams({ client_id: GITHUB_OAUTH_CLIENT_ID, device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) });
    } catch { continue; } // one lost poll should not end the login
    const value = poll.value as TokenReply | null;
    if (typeof value?.access_token === 'string' && value.access_token) return value.access_token;
    if (value?.error === 'authorization_pending') continue;
    // GitHub asks for a longer interval and names it; otherwise add 5 s, as the docs say.
    if (value?.error === 'slow_down') { interval = (Number(value.interval) || interval / 1000 + 5) * 1000; continue; }
    if (value?.error === 'expired_token') throw new GitHubFailure('login_timeout');
    if (value?.error === 'access_denied') throw new GitHubFailure('login_denied');
    throw new GitHubFailure(`login_${value?.error ?? poll.status}`);
  }
}

const path = (file: string): string => file.split('/').map(encodeURIComponent).join('/');

export interface GitHubApiOptions { fetch: Fetch; token: string }

// REST calls of the CLI with the user's token. `repo` is a repository's full name, owner/name.
export class GitHubApi {
  fetch: Fetch;
  token: string;
  constructor({ fetch, token }: GitHubApiOptions) { this.fetch = fetch; this.token = token; }

  async call(url: string, options: SendOptions = {}): Promise<GitHubReply> {
    const reply = await send(this.fetch, `${API}${url}`, { ...options, headers: { accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', authorization: `Bearer ${this.token}`, ...options.headers } });
    if (reply.status === 401) throw new GitHubFailure('unauthorized');
    return reply;
  }
  async expect(what: Purpose, url: string, statuses: number[], options?: SendOptions): Promise<GitHubReply> {
    const reply = await this.call(url, options);
    if (!statuses.includes(reply.status)) throw new GitHubFailure(`${what}_${reply.status}`);
    return reply;
  }

  async login(): Promise<string> {
    const { value } = await this.expect('user', '/user', [200]);
    const user = value as { login?: unknown } | null;
    if (typeof user?.login !== 'string') throw new GitHubFailure('user_invalid');
    return user.login;
  }
  // null when there is no such repository.
  async repository(repo: string): Promise<Repository | null> {
    const reply = await this.expect('repository', `/repos/${repo}`, [200, 404]);
    return reply.status === 200 ? reply.value as Repository : null;
  }
  async createRepository({ name, description }: { name: string; description: string }): Promise<Repository> {
    const { value } = await this.expect('create_repository', '/user/repos', [201], { method: 'POST',
      body: { name, description, private: true, auto_init: false, has_issues: false, has_projects: false, has_wiki: false } satisfies NewRepositoryBody });
    return value as Repository;
  }
  // Takes a token with the delete_repo scope. A repository already gone is not an error.
  async deleteRepository(repo: string): Promise<void> {
    await this.expect('delete_repository', `/repos/${repo}`, [204, 404], { method: 'DELETE' });
  }
  // { text, sha } of a file on the default branch, or null when it is missing (an empty
  // repository answers 404 to every read).
  async file(repo: string, file: string): Promise<RepositoryFile | null> {
    const reply = await this.expect('read_file', `/repos/${repo}/contents/${path(file)}`, [200, 404]);
    if (reply.status === 404) return null;
    const value = reply.value as { type?: unknown; encoding?: unknown; content: string; sha: string } | null;
    if (value?.type !== 'file' || value.encoding !== 'base64') throw new GitHubFailure('read_file_invalid');
    return { text: Buffer.from(value.content, 'base64').toString('utf8'), sha: value.sha };
  }
  // One commit on the default branch. sha names the version being replaced.
  async putFile(repo: string, file: string, text: string, { message, sha }: { message: string; sha?: string | null }): Promise<void> {
    await this.expect('write_file', `/repos/${repo}/contents/${path(file)}`, [200, 201], { method: 'PUT',
      body: { message, content: Buffer.from(text).toString('base64'), ...(sha ? { sha } : {}) } satisfies PutFileBody });
  }
  async hasSecret(repo: string, secret: string): Promise<boolean> {
    return (await this.expect('read_secret', `/repos/${repo}/actions/secrets/${secret}`, [200, 404])).status === 200;
  }
  // Actions secrets travel as a libsodium sealed box to the repository's public key.
  async putSecret(repo: string, secret: string, value: string): Promise<void> {
    const reply = await this.expect('secret_key', `/repos/${repo}/actions/secrets/public-key`, [200]);
    const key = reply.value as { key_id: string; key: string };
    await sodium.ready;
    const sealed = sodium.crypto_box_seal(Buffer.from(value), Buffer.from(key.key, 'base64'));
    await this.expect('write_secret', `/repos/${repo}/actions/secrets/${secret}`, [201, 204], { method: 'PUT',
      body: { key_id: key.key_id, encrypted_value: Buffer.from(sealed).toString('base64') } satisfies PutSecretBody });
  }
  async deleteSecret(repo: string, secret: string): Promise<void> {
    await this.expect('delete_secret', `/repos/${repo}/actions/secrets/${secret}`, [204, 404], { method: 'DELETE' });
  }
  // false while GitHub does not know the workflow yet: right after its push a dispatch gets
  // 404, or 422 while the workflow_dispatch trigger is not registered.
  async dispatch(repo: string, workflow: string, { ref, inputs }: { ref: string; inputs: Record<string, string> }): Promise<boolean> {
    const reply = await this.expect('dispatch', `/repos/${repo}/actions/workflows/${workflow}/dispatches`, [204, 404, 422],
      { method: 'POST', body: { ref, inputs } satisfies DispatchBody });
    return reply.status === 204;
  }
  // active, disabled_manually, disabled_inactivity…; null while GitHub does not know the workflow.
  async workflowState(repo: string, workflow: string): Promise<string | null> {
    const reply = await this.expect('workflow', `/repos/${repo}/actions/workflows/${workflow}`, [200, 404]);
    return reply.status === 200 ? (reply.value as { state?: string } | null)?.state ?? null : null;
  }
  // The latest run of the workflow, scheduled or dispatched; null when there is none.
  async latestRun(repo: string, workflow: string): Promise<WorkflowRun | null> {
    const { status, value } = await this.expect('runs', `/repos/${repo}/actions/workflows/${workflow}/runs?per_page=1`, [200, 404]);
    return status === 200 ? (value as Runs | null)?.workflow_runs?.[0] ?? null : null;
  }
  // The latest runs the cron started, newest first; empty while GitHub does not know the workflow yet (404).
  async scheduledRuns(repo: string, workflow: string): Promise<WorkflowRun[]> {
    const { status, value } = await this.expect('runs', `/repos/${repo}/actions/workflows/${workflow}/runs?event=schedule&per_page=10`, [200, 404]);
    return status === 200 ? (value as Runs | null)?.workflow_runs ?? [] : [];
  }
  // Empty while GitHub does not know the workflow yet (404).
  async dispatchRuns(repo: string, workflow: string): Promise<WorkflowRun[]> {
    const { status, value } = await this.expect('runs',
      `/repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=20`, [200, 404]);
    return status === 200 ? (value as Runs | null)?.workflow_runs ?? [] : [];
  }
  async run(repo: string, id: number): Promise<WorkflowRun> {
    return (await this.expect('run', `/repos/${repo}/actions/runs/${id}`, [200])).value as WorkflowRun;
  }
  // Plain text log of the run's job, or null when GitHub does not give it (yet).
  async runLog(repo: string, id: number): Promise<string | null> {
    const { value } = await this.expect('jobs', `/repos/${repo}/actions/runs/${id}/jobs`, [200]);
    const job = (value as { jobs?: { id: number }[] } | null)?.jobs?.[0];
    if (!job) return null;
    const reply = await this.call(`/repos/${repo}/actions/jobs/${job.id}/logs`);
    return reply.status === 200 ? reply.text : null;
  }
}
