import sodium from 'libsodium-wrappers';
import { GITHUB_OAUTH_CLIENT_ID } from './oauth-app.mjs';
import { USER_AGENT } from '../chatgpt/http.mjs';

const API = 'https://api.github.com';
const GITHUB_SCOPES = 'repo workflow';

// GitHub refused or could not be reached. reason: network, unauthorized, or `<what>_<status>`.
export class GitHubFailure extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

async function send(fetch, url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
  let response, text;
  try {
    // Job logs redirect to blob storage; fetch drops the Authorization header across origins.
    const form = body instanceof URLSearchParams;
    response = await fetch(url, { method, body: body === undefined ? undefined : form ? body.toString() : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': USER_AGENT,
        ...(body === undefined ? {} : { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }), ...headers } });
    text = await response.text();
  } catch { throw new GitHubFailure('network'); }
  let value = null;
  try { value = text ? JSON.parse(text) : null; } catch { /* plain text: logs, error pages */ }
  return { status: response.status, value, text };
}

// Device flow of the project's OAuth App: the user enters onCode's userCode at
// verificationUrl while we poll. Returns the user's access token; it never expires.
export async function githubDeviceLogin({ fetch, onCode, sleep, now }) {
  const headers = { accept: 'application/json' };
  const issued = await send(fetch, 'https://github.com/login/device/code', { method: 'POST', headers,
    body: new URLSearchParams({ client_id: GITHUB_OAUTH_CLIENT_ID, scope: GITHUB_SCOPES }) });
  const device = issued.value;
  if (issued.status !== 200 || typeof device?.device_code !== 'string' || typeof device.user_code !== 'string') {
    throw new GitHubFailure(`device_code_${issued.status}`);
  }
  await onCode({ userCode: device.user_code, verificationUrl: device.verification_uri });
  let interval = Math.max(1, Number(device.interval) || 5) * 1000;
  const deadline = now() + Math.max(60, Number(device.expires_in) || 900) * 1000;
  for (;;) {
    if (now() >= deadline) throw new GitHubFailure('login_timeout');
    await sleep(interval);
    let poll;
    try {
      poll = await send(fetch, 'https://github.com/login/oauth/access_token', { method: 'POST', headers,
        body: new URLSearchParams({ client_id: GITHUB_OAUTH_CLIENT_ID, device_code: device.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) });
    } catch { continue; } // one lost poll should not end the login
    const { value } = poll;
    if (typeof value?.access_token === 'string' && value.access_token) return value.access_token;
    if (value?.error === 'authorization_pending') continue;
    // GitHub asks for a longer interval and names it; otherwise add 5 s, as the docs say.
    if (value?.error === 'slow_down') { interval = (Number(value.interval) || interval / 1000 + 5) * 1000; continue; }
    if (value?.error === 'expired_token') throw new GitHubFailure('login_timeout');
    if (value?.error === 'access_denied') throw new GitHubFailure('login_denied');
    throw new GitHubFailure(`login_${value?.error ?? poll.status}`);
  }
}

const path = file => file.split('/').map(encodeURIComponent).join('/');

// REST calls of the CLI with the user's token. `repo` is a repository's full name, owner/name.
export class GitHubApi {
  constructor({ fetch, token }) { Object.assign(this, { fetch, token }); }

  async call(url, options = {}) {
    const reply = await send(this.fetch, `${API}${url}`, { ...options, headers: { accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', authorization: `Bearer ${this.token}`, ...options.headers } });
    if (reply.status === 401) throw new GitHubFailure('unauthorized');
    return reply;
  }
  async expect(what, url, statuses, options) {
    const reply = await this.call(url, options);
    if (!statuses.includes(reply.status)) throw new GitHubFailure(`${what}_${reply.status}`);
    return reply;
  }

  async login() {
    const { value } = await this.expect('user', '/user', [200]);
    if (typeof value?.login !== 'string') throw new GitHubFailure('user_invalid');
    return value.login;
  }
  // null when there is no such repository.
  async repository(repo) {
    const reply = await this.expect('repository', `/repos/${repo}`, [200, 404]);
    return reply.status === 200 ? reply.value : null;
  }
  async createRepository({ name, description }) {
    const { value } = await this.expect('create_repository', '/user/repos', [201], { method: 'POST',
      body: { name, description, private: true, auto_init: false, has_issues: false, has_projects: false, has_wiki: false } });
    return value;
  }
  // { text, sha } of a file on the default branch, or null when it is missing (an empty
  // repository answers 404 to every read).
  async file(repo, file) {
    const reply = await this.expect('read_file', `/repos/${repo}/contents/${path(file)}`, [200, 404]);
    if (reply.status === 404) return null;
    if (reply.value?.type !== 'file' || reply.value.encoding !== 'base64') throw new GitHubFailure('read_file_invalid');
    return { text: Buffer.from(reply.value.content, 'base64').toString('utf8'), sha: reply.value.sha };
  }
  // One commit on the default branch. sha names the version being replaced.
  async putFile(repo, file, text, { message, sha }) {
    await this.expect('write_file', `/repos/${repo}/contents/${path(file)}`, [200, 201], { method: 'PUT',
      body: { message, content: Buffer.from(text).toString('base64'), ...(sha ? { sha } : {}) } });
  }
  async hasSecret(repo, secret) {
    return (await this.expect('read_secret', `/repos/${repo}/actions/secrets/${secret}`, [200, 404])).status === 200;
  }
  // Actions secrets travel as a libsodium sealed box to the repository's public key.
  async putSecret(repo, secret, value) {
    const { value: key } = await this.expect('secret_key', `/repos/${repo}/actions/secrets/public-key`, [200]);
    await sodium.ready;
    const sealed = sodium.crypto_box_seal(Buffer.from(value), Buffer.from(key.key, 'base64'));
    await this.expect('write_secret', `/repos/${repo}/actions/secrets/${secret}`, [201, 204], { method: 'PUT',
      body: { key_id: key.key_id, encrypted_value: Buffer.from(sealed).toString('base64') } });
  }
  async deleteSecret(repo, secret) {
    await this.expect('delete_secret', `/repos/${repo}/actions/secrets/${secret}`, [204, 404], { method: 'DELETE' });
  }
  // false while GitHub does not know the workflow yet: right after its push a dispatch gets
  // 404, or 422 while the workflow_dispatch trigger is not registered.
  async dispatch(repo, workflow, { ref, inputs }) {
    const reply = await this.expect('dispatch', `/repos/${repo}/actions/workflows/${workflow}/dispatches`, [204, 404, 422],
      { method: 'POST', body: { ref, inputs } });
    return reply.status === 204;
  }
  // active, disabled_manually, disabled_inactivity…; null while GitHub does not know the workflow.
  async workflowState(repo, workflow) {
    const reply = await this.expect('workflow', `/repos/${repo}/actions/workflows/${workflow}`, [200, 404]);
    return reply.status === 200 ? reply.value?.state ?? null : null;
  }
  // The latest run of the workflow, scheduled or dispatched; null when there is none.
  async latestRun(repo, workflow) {
    const { status, value } = await this.expect('runs', `/repos/${repo}/actions/workflows/${workflow}/runs?per_page=1`, [200, 404]);
    return status === 200 ? value?.workflow_runs?.[0] ?? null : null;
  }
  // Empty while GitHub does not know the workflow yet (404).
  async dispatchRuns(repo, workflow) {
    const { status, value } = await this.expect('runs',
      `/repos/${repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=20`, [200, 404]);
    return status === 200 ? value?.workflow_runs ?? [] : [];
  }
  async run(repo, id) {
    return (await this.expect('run', `/repos/${repo}/actions/runs/${id}`, [200])).value;
  }
  // Plain text log of the run's job, or null when GitHub does not give it (yet).
  async runLog(repo, id) {
    const { value } = await this.expect('jobs', `/repos/${repo}/actions/runs/${id}/jobs`, [200]);
    const job = value?.jobs?.[0];
    if (!job) return null;
    const reply = await this.call(`/repos/${repo}/actions/jobs/${job.id}/logs`);
    return reply.status === 200 ? reply.text : null;
  }
}
