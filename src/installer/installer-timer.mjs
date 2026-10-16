import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createPrivateKey, randomBytes } from 'node:crypto';
import { StateFailure } from '../core/state-store.mjs';
import { TIMER_PLAN_PATH } from '../schedule/managed-schedule.mjs';
import { TIMER_PERMISSIONS, appJwt, importAppKey, readInstallationToken, tokenRequest } from '../schedule/timer-app.mjs';

// Timer app setup (ADR-0003, ticket 42). The user clicks Create and Install; the installer
// registers the App from a manifest, finds its installation and pipes the key to the Worker
// secret. The key lives only in memory here: never in arguments, environment, files, the
// journal, state or logs. State receives the App ID, slug and installation ID.
export const WRANGLER = 'wrangler@4.139.0'; // Version verified in E1 (ticket 35), as in worker/README.md.
const BRANCH = 'main'; // The Worker dispatches and reads the plan on main only.
const HOOK_URL = 'https://example.invalid/auto-reset-timer'; // GitHub rejects a manifest without one (39).
const fail = kind => { throw new StateFailure(kind); };
const html = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const nowSeconds = () => Math.floor(Date.now() / 1000);
export const appInstallUrl = slug => `https://github.com/apps/${slug}/installations/new`;
export const appSettingsUrl = slug => `https://github.com/settings/apps/${slug}/advanced`; // Delete GitHub App.

export function appManifest({ repository, redirectUrl, suffix = randomBytes(3).toString('hex') }) {
  return { name: `auto-reset-timer-${suffix}`, url: `https://github.com/${repository}`, public: false,
    description: `External timer of ${repository}: starts the auto-reset workflow and reads the window plan.`,
    hook_attributes: { url: HOOK_URL, active: false }, redirect_url: redirectUrl,
    default_permissions: TIMER_PERMISSIONS, default_events: [] };
}
// The key goes to the Worker as one base64 line of PKCS#8 DER: stdin of `secret put` keeps it whole.
export const pkcs8Key = pem => createPrivateKey(pem).export({ type: 'pkcs8', format: 'der' }).toString('base64');

// One request per call; GitHub bodies never leave this function except as checked fields.
async function request(fetchImpl, path, { method = 'GET', body, bearer }) {
  let response;
  try {
    response = await fetchImpl(`https://api.github.com${path}`, { method, redirect: 'manual',
      signal: AbortSignal.timeout(10_000), body: body && JSON.stringify(body),
      headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10', 'user-agent': 'auto-reset-installer',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } });
  } catch { fail('timer_github_unreachable'); }
  return { status: response.status, body: await response.json().catch(() => null) };
}

// Manifest flow on loopback: the local page auto-submits the manifest, GitHub redirects back with
// a one-hour code and our state, and the code is exchanged once. The server then closes; it also
// closes on timeout. Only the user's own account can own the App: billing is per user (ADR-0003).
export function registerTimerApp({ repository, open, fetchImpl = fetch, timeoutMs = 15 * 60_000, onListen = () => {} }) {
  const state = randomBytes(16).toString('hex'), owner = repository.split('/')[0].toLowerCase();
  return new Promise((resolve, reject) => {
    let manifest, exchanging = false, settled = false;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const page = (status, title) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`<!doctype html><meta charset="utf-8"><title>auto-reset</title><p>${html(title)}</p>`); };
      if (req.method !== 'GET') return page(405, 'Method not allowed');
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(`<!doctype html><meta charset="utf-8"><title>auto-reset timer app</title>
<form method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${html(JSON.stringify(manifest))}">
<p>Create the auto-reset timer app on GitHub.</p><button type="submit">Continue to GitHub</button></form>
<script>document.forms[0].submit()</script>`);
      }
      const code = url.searchParams.get('code');
      // A foreign or repeated callback is refused without touching the exchange.
      if (url.pathname !== '/callback' || url.searchParams.get('state') !== state || !/^[A-Za-z0-9_-]{1,200}$/.test(code ?? '') || exchanging) {
        return page(400, 'Unexpected request');
      }
      exchanging = true;
      try {
        const { status, body } = await request(fetchImpl, `/app-manifests/${code}/conversions`, { method: 'POST' });
        if (status !== 201) fail('timer_app_exchange_failed');
        if (!Number.isSafeInteger(body?.id) || body.id <= 0 || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(body.slug ?? '') ||
          typeof body.pem !== 'string') fail('timer_app_exchange_failed');
        // client_secret and webhook_secret are not needed and not kept; the PEM is converted at once.
        const app = { appId: body.id, slug: body.slug };
        if (body.owner?.login?.toLowerCase() !== owner) { page(200, 'The app belongs to another GitHub account. Return to the terminal.'); return finish(new StateFailure('timer_app_owner_mismatch'), app); }
        let key;
        try { key = pkcs8Key(body.pem); }
        catch { page(502, 'GitHub returned an unusable key. Return to the terminal.'); return finish(new StateFailure('timer_app_exchange_failed'), app); }
        page(200, 'Timer app created. Return to the terminal.');
        finish(null, { ...app, key });
      } catch (error) {
        page(502, 'GitHub did not complete the app registration. Return to the terminal.');
        finish(error instanceof StateFailure ? error : new StateFailure('timer_app_exchange_failed'));
      }
    });
    const timer = setTimeout(() => finish(new StateFailure('timer_app_timeout')), timeoutMs);
    // An App GitHub created but we cannot use travels with the error, so the user can delete it.
    // The last page is still flushing: only idle connections are closed, and none keeps the process.
    function finish(error, app = null) {
      if (settled) return;
      settled = true; clearTimeout(timer); server.close(); server.closeIdleConnections(); server.unref();
      if (error) { error.app = app; reject(error); } else resolve(app);
    }
    server.once('error', () => finish(new StateFailure('timer_app_server_failed')));
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      manifest = appManifest({ repository, redirectUrl: `${base}/callback` });
      onListen(base); open(`${base}/`);
    });
  });
}

// Installation ID without a webhook: the App JWT reads the repo's installation (39). Narrower
// installation is checked, not enforced: "all" is a warning and the Worker narrows each token.
export async function findInstallation({ repository, appId, key, fetchImpl = fetch, now = nowSeconds }) {
  const jwt = await appJwt({ appId, key: await importAppKey(key), now: now() });
  const { status, body } = await request(fetchImpl, `/repos/${repository}/installation`, { bearer: jwt });
  if (status === 404) fail('timer_app_not_installed');
  if (status === 401) fail('timer_app_unauthorized');
  if (status !== 200) fail('timer_github_unavailable');
  if (!Number.isSafeInteger(body?.id) || body.id <= 0 || body.app_id !== appId) fail('timer_app_not_installed');
  return { installationId: body.id, selection: body.repository_selection === 'selected' ? 'selected' : 'all' };
}

// Reads exactly what the Worker reads, with the same narrow token; Actions: write is proven later
// by the probe dispatch. The token is revoked at the end: it is not needed for its hour.
export async function verifyTimerAccess({ repository, appId, installationId, key, fetchImpl = fetch, now = nowSeconds }) {
  const jwt = await appJwt({ appId, key: await importAppKey(key), now: now() });
  const issued = await request(fetchImpl, `/app/installations/${installationId}/access_tokens`, { method: 'POST', body: tokenRequest(repository), bearer: jwt });
  if (issued.status === 401) fail('timer_app_unauthorized');
  if (issued.status === 404) fail('timer_app_not_installed');
  if (issued.status === 422) fail('timer_app_permissions_denied'); // The repo or a permission is not granted.
  if (issued.status !== 201) fail('timer_github_unavailable');
  let token;
  try { ({ token } = readInstallationToken(issued.body)); } catch { fail('timer_github_unavailable'); }
  try {
    const get = async (path, denied, absent = false) => {
      const response = await request(fetchImpl, `/repos/${repository}${path}`, { bearer: token });
      if (absent && response.status === 404) return null;
      if ([401, 403, 404].includes(response.status)) fail(denied);
      if (response.status !== 200) fail('timer_github_unavailable');
      return response.body;
    };
    const repo = await get('', 'timer_app_repository_denied');
    if (repo?.private !== true || repo.full_name?.toLowerCase() !== repository.toLowerCase()) fail('private_repository_required');
    if (repo.default_branch !== BRANCH) fail('timer_requires_main_branch');
    // An absent plan is an empty one (GitHubScheduleWriter): an Upgrade from a pin before 37 has
    // none until the probe. Contents read is then proven by the marker every bootstrap commits.
    const plan = await get(`/contents/${TIMER_PLAN_PATH}?ref=${BRANCH}`, 'timer_app_contents_denied', true) ??
      await get(`/contents/.auto-reset-installation.json?ref=${BRANCH}`, 'timer_app_contents_denied');
    if (plan?.type !== 'file') fail('timer_plan_missing');
  } finally {
    await request(fetchImpl, '/installation/token', { method: 'DELETE', bearer: token }).catch(() => {});
  }
}

// Wrangler prompts (browser login, delete confirmation) stay interactive; the key goes only
// through stdin of `secret put`, never in arguments, environment or files.
export function runWrangler(args, { root, input = null, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('npx', ['--yes', WRANGLER, ...args, '--config', 'worker/wrangler.toml'],
      { cwd: root, stdio: [input === null ? 'inherit' : 'pipe', 'inherit', 'inherit'] });
    child.once('error', () => reject(new StateFailure('timer_wrangler_failed')));
    child.once('close', code => code === 0 ? resolve() : reject(new StateFailure('timer_wrangler_failed')));
    if (input !== null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}
export async function deployTimerWorker({ repository, appId, installationId, key, root, spawnImpl }) {
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repository)) fail('repository_invalid');
  if (![appId, installationId].every(x => Number.isSafeInteger(x) && x > 0)) fail('invalid_command');
  await runWrangler(['deploy', '--var', `REPOSITORY:${repository}`, '--var', `TIMER_APP_ID:${appId}`,
    '--var', `TIMER_INSTALLATION_ID:${installationId}`], { root, spawnImpl });
  await runWrangler(['secret', 'put', 'TIMER_APP_KEY'], { root, input: key, spawnImpl });
}
// Migration from the timer token (ticket 38): the Worker no longer reads it, so a failure only
// leaves an unused secret for the user to delete by hand.
export const deleteTimerTokenSecret = ({ root, spawnImpl }) => runWrangler(['secret', 'delete', 'TIMER_TOKEN'], { root, spawnImpl });
export const deleteTimerWorker = ({ root, spawnImpl }) => runWrangler(['delete'], { root, spawnImpl });
