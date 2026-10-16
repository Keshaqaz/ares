// External timer (ADR-0002, ticket 36). On each Cron Trigger tick it reads the published plan
// and, only when the nominal UTC minute matches it, sends one empty workflow_dispatch.
// It never decides about consume: a late or double tick is an ordinary reconcile in the
// private workflow. Access comes from the timer app (ADR-0003, ticket 42): TIMER_APP_KEY signs
// a JWT for an installation token narrowed to the repo, Actions: write and Contents: read.
// Neither the key nor a token is ever logged.
import { StateFailure } from '../core/state-failure.mjs';
import { TIMER_PLAN_PATH, expandCron, readTimerPlan } from '../schedule/managed-schedule.mjs';
import { CADENCE } from '../schedule/schedule-time.mjs';
import { importAppKey, appJwt, tokenRequest, readInstallationToken } from '../schedule/timer-app.mjs';

const BRANCH = 'main';
const WORKFLOW = 'auto-reset.yml';
const fail = kind => { throw new StateFailure(kind); };
const minuteIso = at => new Date(at * 1000).toISOString().slice(0, 19) + 'Z';
const id = value => /^[1-9][0-9]*$/.test(value ?? '') && Number.isSafeInteger(Number(value)) ? Number(value) : null;
// Fixed log vocabulary: GitHub bodies, headers and plan content never reach the log.
const statusKind = status => ({ 401: 'github_unauthorized', 403: 'github_forbidden', 404: 'github_not_found' })[status] ??
  (status >= 500 ? 'github_unavailable' : 'github_unexpected');
// Token request: a bad key or deleted App is 401, a removed installation 404, a permission the
// App no longer has 422.
const tokenKind = status => ({ 401: 'app_unauthorized', 403: 'app_forbidden', 404: 'installation_not_found',
  422: 'app_permissions_denied' })[status] ?? statusKind(status);

export function timerConfig(env) {
  if (typeof env?.TIMER_APP_KEY !== 'string' || !env.TIMER_APP_KEY) fail('key_missing');
  if (typeof env.REPOSITORY !== 'string' || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(env.REPOSITORY)) fail('repository_invalid');
  const appId = id(env.TIMER_APP_ID), installationId = id(env.TIMER_INSTALLATION_ID);
  if (!appId || !installationId) fail('app_invalid');
  return { key: env.TIMER_APP_KEY, appId, installationId, repository: env.REPOSITORY };
}

// One request per call, no retries: the next tick is five minutes later. A redirect
// (renamed or transferred repository) is not followed and fails closed as unexpected.
async function call(fetchImpl, record, path, { method = 'GET', body, bearer, statuses = [200], kind = statusKind }) {
  record.subrequests++;
  let response;
  try {
    response = await fetchImpl(`https://api.github.com${path}`, { method, redirect: 'manual',
      signal: AbortSignal.timeout(10_000), body: body && JSON.stringify(body),
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${bearer}`,
        // 2026-03-10 answers a dispatch with 200 and workflow_run_id (E1, ticket 35).
        'x-github-api-version': '2026-03-10', 'user-agent': 'auto-reset-timer',
        ...(body ? { 'content-type': 'application/json' } : {}) } });
  } catch { fail('github_unreachable'); }
  record.status = response.status;
  if (!statuses.includes(response.status)) fail(kind(response.status));
  return response.status === 204 ? null : response.json().catch(() => null);
}

// Installation tokens live an hour; the isolate keeps one until five minutes before expiry, so
// most idle ticks cost a single subrequest. A token rejected later is dropped (see tick).
const tokens = new Map();
const cacheSlot = config => `${config.appId}/${config.installationId}/${config.repository}`;
async function installationToken(config, fetchImpl, record, cache, now) {
  const cached = cache.get(cacheSlot(config));
  if (cached && cached.expiresAt - 300 > now) { record.token = 'cached'; return cached.token; }
  cache.delete(cacheSlot(config));
  const jwt = await appJwt({ appId: config.appId, key: await importAppKey(config.key), now });
  const issued = readInstallationToken(await call(fetchImpl, record, `/app/installations/${config.installationId}/access_tokens`,
    { method: 'POST', body: tokenRequest(config.repository), bearer: jwt, statuses: [201], kind: tokenKind }));
  cache.set(cacheSlot(config), issued); record.token = 'issued';
  return issued.token;
}

// The only place that knows where the planner publishes windows: the timer plan file on main
// (ticket 37), read with Contents: read. Its edits never touch the workflow or its cron.
export async function readPlan(github) {
  const file = await github(`/contents/${TIMER_PLAN_PATH}?ref=${BRANCH}`);
  if (file?.type !== 'file' || file.path !== TIMER_PLAN_PATH || file.encoding !== 'base64' ||
    typeof file.content !== 'string' || file.content.length > 2 * 1024 * 1024) fail('plan_invalid');
  try {
    const bytes = Uint8Array.from(atob(file.content.replace(/\n/g, '')), c => c.charCodeAt(0));
    return readTimerPlan(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { fail('plan_invalid'); }
}

// Idle ticks cost one subrequest (two with a new token); a matching one at most five (Free limit is 50).
export async function tick(scheduledTime, env, { fetchImpl = fetch, now = () => Math.floor(Date.now() / 1000), cache = tokens } = {}) {
  const record = { slot: null, outcome: 'failed', problem: null, status: null, runId: null, token: null, subrequests: 0 };
  let config = null;
  try {
    // Match by Cloudflare's nominal time: E1 measured ticks 32–34 s after the minute.
    const minute = Math.floor(scheduledTime / 60000) * 60;
    if (!Number.isSafeInteger(minute) || minute < 0) fail('clock_invalid');
    record.slot = minuteIso(minute);
    config = timerConfig(env);
    const bearer = await installationToken(config, fetchImpl, record, cache, now());
    const github = (path, options = {}) => call(fetchImpl, record, `/repos/${config.repository}${path}`, { ...options, bearer });
    const expressions = await readPlan(github);
    if (!expandCron(expressions, minute, minute + 60).length) record.outcome = 'idle';
    else {
      const repo = await github('');
      if (repo?.private !== true || typeof repo.full_name !== 'string' ||
        repo.full_name.toLowerCase() !== env.REPOSITORY.toLowerCase()) fail('repository_mismatch');
      // The planner publishes on the default branch; a plan on another main is not authoritative.
      if (repo.default_branch !== BRANCH) fail('branch_mismatch');
      // Any run created in this slot (native schedule, repeated tick) performs the same reconcile.
      const created = `${minuteIso(minute)}..${minuteIso(minute + CADENCE - 1)}`;
      const runs = await github(`/actions/workflows/${WORKFLOW}/runs?created=${encodeURIComponent(created)}&per_page=1`);
      if (!Number.isSafeInteger(runs?.total_count) || runs.total_count < 0) fail('github_unexpected');
      if (runs.total_count) record.outcome = 'duplicate';
      else {
        // No inputs: an empty dispatch is an ordinary reconcile; open commands are refused (34).
        const sent = await github(`/actions/workflows/${WORKFLOW}/dispatches`, { method: 'POST', body: { ref: BRANCH },
          statuses: [200, 204] });
        record.outcome = 'dispatched';
        if (Number.isSafeInteger(sent?.workflow_run_id) && sent.workflow_run_id > 0) record.runId = sent.workflow_run_id;
        else record.problem = 'run_id_missing';
      }
    }
  } catch (error) {
    record.outcome = 'failed';
    record.problem = error instanceof StateFailure ? error.kind : 'internal_error';
    // A revoked or narrowed cached token is replaced on the next tick, not reused for its hour.
    if (config && record.token === 'cached' && ['github_unauthorized', 'github_forbidden'].includes(record.problem)) cache.delete(cacheSlot(config));
  }
  console.log(JSON.stringify({ autoResetTimer: record }));
  return record;
}

// Scheduled handler only: the Worker has no fetch handler and no public URL.
export default {
  async scheduled(controller, env) { await tick(controller.scheduledTime, env); },
};
