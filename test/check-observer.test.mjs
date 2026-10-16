import test from 'node:test';
import assert from 'node:assert/strict';
import { privateWorkflowFixture, PROGRAM_COMMIT, confirmedTimer } from './support/private-workflow-fixture.mjs';
import { hostBytes } from './support/host-auth-fixture.mjs';
import { syntheticGrant } from './support/auth-fixture.mjs';
import { AuthFailure, makeBundle, encodeBundle, hostCredentials } from '../src/session/auth-bundle.mjs';
import { HostAuthSession } from '../src/session/host-auth-session.mjs';
import { sealAdmin, runInstallerAdmin } from '../src/installer/installer-admin.mjs';
import { projectUsage } from '../src/account/check-observer.mjs';
import { renderInstallerReport } from '../src/installer/installer-report.mjs';

const response = (clock, accountId) => ({ accountId, ordinaryUsageAllowed: false,
  rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: clock + 100 },
    secondary: null, rateLimitReachedType: 'rate_limit_reached', spendControlReached: false },
  rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'PRIVATE-CREDIT', grantedAt: clock - 10,
    expiresAt: clock + 1000, resetType: 'codexRateLimits', status: 'available' }] } });
async function fixture(t, exp) {
  const f = await privateWorkflowFixture(t); let seq = 0;
  const bundle = makeBundle(hostBytes(1, exp === undefined ? {} : { exp }), { protocol: 2 });
  f.command = (action, payload) => sealAdmin('synthetic/private', syntheticGrant,
    { action, commandId: `observer-${++seq}`, expectedVersion: f.github.state.version }, payload);
  f.providerCalls = 0;
  f.provider = async () => { f.providerCalls++; return { observedAt: f.clock, quota: { ...f.quota, queuedJobs: 0 }, evidence: { outstandingMinutes: 10 } }; };
  f.admin = (c, extra = {}) => f.actions.writer(() => runInstallerAdmin({ storage: f.github.storage,
    workflow: f.workflow, serialization: f.serialization, command: c, grant: syntheticGrant,
    snapshot: f.github.secret, programCommit: PROGRAM_COMMIT, pilotApproved: true, now: () => f.clock, quotaProvider: f.provider,
    sessionFactory: snapshot => new HostAuthSession({ store: f.github.storage, secrets: f.github.storage,
      serialization: f.serialization, oauth: f.oauth, vault: f.vault, runtime: f.external,
      snapshot, grant: syntheticGrant, owner: 'observer-test', now: () => f.clock }), ...extra }));
  await f.admin(f.command('pause', {}));
  await f.actions.writer(() => f.github.storage.update(v => { v.installation.timer = confirmedTimer(f.clock); }));
  await f.admin(f.command('seed', { bundle: encodeBundle(bundle) }));
  f.accountId = hostCredentials(hostBytes(1)).accountId;
  f.value = response(f.clock, f.accountId); f.sent = [];
  f.rpc.request = async (method, params) => { f.sent.push({ method, params });
    if (f.error) throw new AuthFailure(f.error);
    return method === 'account/read' ? { account: { type: 'chatgpt', email: 'PRIVATE-EMAIL' } } : f.value;
  };
  f.check = (extra = {}) => f.admin(f.command('check', { forceRefresh: false, observer: { schema: 1, futureMinutes: 288 } }), extra);
  return f;
}

test('observer encrypted check separates account/usage/details and preserves disabled/history/metadata', async t => {
  const f = await fixture(t);
  const before = structuredClone(f.github.state);
  const r = await f.check();
  assert.equal(r.observer.zeroReadConfirmed, true);
  assert.equal(r.observer.account.state, 'received'); assert.equal(r.observer.usage.state, 'received');
  assert.deepEqual(r.observer.details, { kind: 'details', count: 1 });
  assert.equal(f.providerCalls, 4); assert.equal(f.refreshes, 0);
  assert.deepEqual(f.sent.map(r => r.method), ['account/read', 'account/rateLimits/read']);
  assert.deepEqual(f.sent[0].params, { refreshToken: false });
  for (const field of ['requests', 'cycles', 'groups', 'auth', 'disabled', 'scheduler']) assert.deepEqual(f.github.state[field], before[field]);
  assert.deepEqual((await f.actions.writer(() => f.workflow.read())).expressions, []);
  assert.deepEqual(f.github.state.installation.metadata, before.installation.metadata);
  const rendered = await f.actions.writer(() => renderInstallerReport(f.github.storage, {}, r, () => f.clock));
  assert.ok(!/PRIVATE|synthetic-account|authBase64|ciphertext|refresh_token|bundleId|sessionId|email/.test(JSON.stringify(r.observer) + rendered));
});

test('projection rejects ambiguous allowance, windows, binding, spend and renewed windows', () => {
  const now = 10000;
  for (const transform of [
    v => ({ ...v, ordinaryUsageAllowed: true }), v => ({ ...v, ordinaryUsageAllowed: null }),
    v => ({ ...v, accountId: 'other' }), v => ({ ...v, accountId: null }),
    v => ({ ...v, rateLimits: { ...v.rateLimits, primary: null } }),
    v => ({ ...v, rateLimits: { ...v.rateLimits, primary: { ...v.rateLimits.primary, windowDurationMins: null } } }),
    v => ({ ...v, rateLimits: { ...v.rateLimits, primary: { ...v.rateLimits.primary, resetsAt: now } } }),
    v => ({ ...v, rateLimits: { ...v.rateLimits, spendControlReached: true, rateLimitReachedType: 'workspace_member_usage_limit_reached' } }),
    v => ({ ...v, rateLimits: { ...v.rateLimits, rateLimitReachedType: 'PRIVATE-REASON' } }),
    v => ({ ...v, rateLimits: { ...v.rateLimits, limitId: 'unknown' } }),
  ]) assert.equal(projectUsage(transform(response(now, 'ci')), 'ci', now).zeroObserved, false);
});

test('observer stops instead of host refresh, including unknown expiry and publishing state', async t => {
  for (const exp of [1, null]) {
    const f = await fixture(t, exp);
    const r = await f.check(); assert.equal(r.observer.errorKind, 'refresh_required');
    assert.equal(f.refreshes, 0); assert.deepEqual(f.sent, []); assert.ok(!f.events.includes('child.login'));
  }
});

test('fresh admission after startup and final freshness stop stale quota before RPC', async t => {
  const f = await fixture(t);
  const old = f.clock;
  f.open = async () => { f.clock += 301; };
  f.provider = async () => ({ observedAt: old, quota: { ...f.quota, queuedJobs: 0 }, evidence: { outstandingMinutes: 10 } });
  const r = await f.check(); assert.equal(r.observer.errorKind, 'quota_unavailable');
  assert.deepEqual(f.sent, []); assert.equal(f.refreshes, 0);
});

test('fresh quota insufficient after queue prevents startup; missing provider cannot use encrypted receipt', async t => {
  const f = await fixture(t);
  f.quota.periods[0].usedMinutes = 700;
  let r = await f.check(); assert.equal(r.observer.errorKind, 'service_quota_insufficient');
  assert.deepEqual(f.sent, []); assert.ok(!f.events.includes('child.login'));
  r = await f.check({ quotaProvider: null }); assert.equal(r.observer.errorKind, 'quota_provider_required');
});

test('HTTP auth/429 RPC error, timeout and external refresh are fixed errors without retry', async t => {
  for (const kind of ['rpc_error', 'rpc_timeout', 'external_refresh_required', 'process_exited', 'malformed_rpc',
    'invalid_app_server_config', 'billing_invalid_response', 'PRIVATE-TRANSPORT', 'Bearer abc.def']) {
    const f = await fixture(t); f.error = kind;
    const r = await f.check();
    assert.equal(r.observer.errorKind, /^[a-z_]+$/.test(kind) ? kind : 'observer_failed');
    assert.equal(r.observer.zeroReadConfirmed, false); assert.equal(r.observer.usage.state, 'notSent');
    assert.equal(f.sent.length, 1); assert.equal(f.refreshes, 0);
  }
});

test('account success and count-only metadata do not prove details access; response after reset does not prove zero', async t => {
  const f = await fixture(t); f.value.rateLimitResetCredits.credits = null;
  let r = await f.check(); assert.equal(r.observer.account.state, 'received');
  assert.equal(r.observer.usage.zeroObserved, true); assert.equal(r.observer.zeroReadConfirmed, false);
  f.value = response(f.clock, f.accountId); f.afterResponse = async method => { if (method.endsWith('rateLimits/read')) f.clock += 101; };
  r = await f.check(); assert.equal(r.observer.usage.zeroObserved, false); assert.equal(r.observer.details.kind, 'details');
});

test('observer rejects select/forced service and preserves setup/version/writer guards', async t => {
  const f = await fixture(t);
  for (const [action, forceRefresh] of [['select', false], ['check', true]]) {
    await assert.rejects(f.admin(f.command(action, { forceRefresh, observer: { schema: 1, futureMinutes: 0 } })), /invalid_observer_command/);
  }
  assert.deepEqual(f.sent, []); assert.equal(f.refreshes, 0);
  const c = f.command('check', { forceRefresh: false, observer: { schema: 1, futureMinutes: 0 } });
  await f.actions.writer(() => f.github.storage.update(s => { s.disabled = false; }));
  await assert.rejects(f.admin(c), /version_conflict/);
});

test('observer preserves nonempty unknown consume history and does not replay it', async t => {
  const f = await fixture(t);
  await f.admin(f.command('check', {}));
  await f.admin(f.command('select', { selection: { creditId: 'PRIVATE-CREDIT', deltaSeconds: 1000 } }));
  // The durable consume attempt behind this history requires confirmed weekly exhaustion.
  f.value = { ...f.value, rateLimits: { ...f.value.rateLimits,
    secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: f.clock + 604800 } } };
  await f.admin(f.command('enable', { evidence: { clientPath: true, costPolicy: true, persistence: true },
    quotaReceipt: { observedAt: f.clock, quota: f.quota } }));
  await f.actions.writer(() => f.job());
  await f.admin(f.command('pause', {}));
  const history = structuredClone({ requests: f.github.state.requests, cycles: f.github.state.cycles, groups: f.github.state.groups });
  assert.equal(history.requests.length, 1); assert.equal(history.requests[0].state, 'unconfirmed');
  const before = f.sent.length;
  const r = await f.check(); assert.equal(r.observer.zeroReadConfirmed, true);
  assert.deepEqual({ requests: f.github.state.requests, cycles: f.github.state.cycles, groups: f.github.state.groups }, history);
  assert.deepEqual(f.sent.slice(before).map(r => r.method), ['account/read', 'account/rateLimits/read']);
});

test('observer no-maintenance rejects publishing without finalization or Secret mutation', async t => {
  const f = await fixture(t);
  await f.actions.writer(() => f.github.storage.update(s => {
    s.auth.phase = 'publishing'; s.auth.transition = 'rotation'; s.auth.operationId = '12345678-1234-1234-1234-123456789abc'; s.auth.owner = 'observer-test';
    const next = makeBundle(hostBytes(2), { protocol: 2, previous: makeBundle(hostBytes(1), { protocol: 2 }) });
    s.auth.target = { ...s.auth.committed, generation: 2, digest: next.digest, bundleId: next.bundleId };
  }));
  const auth = structuredClone(f.github.state.auth), secret = f.github.secret;
  const r = await f.check(); assert.equal(r.observer.errorKind, 'refresh_required');
  assert.deepEqual(f.github.state.auth, auth); assert.equal(f.github.secret, secret);
  assert.equal(f.refreshes, 0); assert.deepEqual(f.sent, []);
});

test('invalid details cannot erase a received usage projection or become details access evidence', async t => {
  const f = await fixture(t); f.value.rateLimitResetCredits.availableCount = -1;
  const r = await f.check(); assert.equal(r.observer.errorKind, 'invalid_read');
  assert.equal(r.observer.usage.state, 'received'); assert.equal(r.observer.usage.ordinaryUsageAllowed, false);
  assert.equal(r.observer.details.kind, 'invalid'); assert.equal(r.observer.zeroReadConfirmed, false);
});

test('future dispatch refuses old source pin or workflow before sending an ignored observer payload', async () => {
  const { verifyObserverRuntime } = await import('../src/account/observer-dispatch.mjs');
  const { readFile } = await import('node:fs/promises');
  const { renderPrivateWorkflow, WORKFLOW_PATH } = await import('../src/workflow/private-workflow.mjs');
  let wrongSource = false, wrongWorkflow = false;
  const github = { repositoryInfo: async () => ({ default_branch: 'main' }), file: async (path, ref) => {
    assert.equal(ref, path === WORKFLOW_PATH ? 'main' : PROGRAM_COMMIT);
    const content = path === WORKFLOW_PATH ? await renderPrivateWorkflow(PROGRAM_COMMIT) : await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    return { encoding: 'base64', content: Buffer.from(
      wrongSource && path === 'src/installer/installer-admin.mjs' || wrongWorkflow && path === WORKFLOW_PATH ? 'old-pin' : content).toString('base64') };
  } };
  const state = { installation: { programCommit: PROGRAM_COMMIT } };
  await verifyObserverRuntime(github, state);
  wrongSource = true; await assert.rejects(verifyObserverRuntime(github, state), /observer_runtime_not_published/);
  wrongSource = false; wrongWorkflow = true; await assert.rejects(verifyObserverRuntime(github, state), /observer_runtime_not_published/);
});

test('observer-only publication manifest binds exact immutable source hashes and pin', async () => {
  const { verifyObserverRuntime } = await import('../src/account/observer-dispatch.mjs');
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  const { renderPrivateWorkflow, WORKFLOW_PATH } = await import('../src/workflow/private-workflow.mjs');
  const paths = ['src/account/check-observer.mjs','src/session/host-auth-session.mjs','src/installer/installer-admin.mjs',
    'src/workflow/private-cli.mjs','src/installer/installer-report.mjs','src/schedule/schedule-planner.mjs','runtime-lock.json'];
  const sources = Object.fromEntries(await Promise.all(paths.map(async path => [path,await readFile(new URL(`../${path}`,import.meta.url),'utf8')])));
  sources['src/installer/installer-admin.mjs'] += '\n// Reviewed observer-only build over installed base.\n';
  const manifest = {schema:1,programCommit:PROGRAM_COMMIT,sourceHashes:Object.fromEntries(paths.map(path => [path,createHash('sha256').update(sources[path]).digest('hex')]))};
  const github = {repositoryInfo:async()=>({default_branch:'main'}),file:async path=>({encoding:'base64',content:Buffer.from(path === WORKFLOW_PATH ? await renderPrivateWorkflow(PROGRAM_COMMIT) : sources[path]).toString('base64')})};
  await verifyObserverRuntime(github,{installation:{programCommit:PROGRAM_COMMIT}},manifest);
  await assert.rejects(verifyObserverRuntime(github,{installation:{programCommit:'2'.repeat(40)}},manifest),/observer_runtime_not_published/);
  sources['src/installer/installer-admin.mjs'] += '// Foreign edit';
  await assert.rejects(verifyObserverRuntime(github,{installation:{programCommit:PROGRAM_COMMIT}},manifest),/observer_runtime_not_published/);
});
