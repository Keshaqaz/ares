import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync, existsSync, readFileSync } from 'node:fs';
import { fakeBackend } from '../testing/fake-backend.mjs';
import { authBytes, syntheticGrant } from '../testing/auth-fixture.mjs';
import { githubFixture } from '../testing/github-fixture.mjs';
import { reserve } from '../testing/consume-reservation-fixture.mjs';
import { bench, syntheticNetworkGuard } from '../testing/bench.mjs';
import { makeBundle, encodeBundle, decodeBundle } from '../src/auth-bundle.mjs';
import { HostOAuth, LocalAuthVault, prepareCiLogin } from '../src/host-oauth.mjs';
import { HostAuthSession } from '../src/host-auth-session.mjs';
import { ExternalAuthRuntime } from '../src/external-auth-runtime.mjs';
import { runCheckObserver } from '../src/check-observer.mjs';
import { parseRateLimits } from '../src/account.mjs';

const real = process.env.AUTO_RESET_CONTRACT_MODE === 'app-server';
// Contract runner uses an installed absolute binary; never source credentials from its home.
const binary = () => {
  if (process.env.AUTO_RESET_CODEX_BIN) return realpathSync(process.env.AUTO_RESET_CODEX_BIN);
  const found = process.env.PATH.split(':').map(dir => join(dir, 'codex')).find(path => existsSync(path));
  if (!found) throw new Error('codex_binary_missing');
  return realpathSync(found);
};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'host-stock-023-'));
  const backend = await fakeBackend(); const events = [], audit = [], launches = [];
  t.after(async () => { await backend.close(); await rm(root, { recursive: true, force: true }); });
  const bundle = makeBundle(authBytes(), { protocol: 2 });
  const github = await githubFixture({ initialBundle: bundle, event: async e => events.push(e) });
  const runtime = new ExternalAuthRuntime({ binary: binary(), syntheticBackend: backend.url,
    networkGuard: await syntheticNetworkGuard(backend.url), audit: e => {
      audit.push(e);
      if (e.direction === 'send' && ['account/read', 'account/rateLimits/read', 'account/rateLimitResetCredit/consume'].includes(e.method)) {
        const current = launches.at(-1);
        assert.equal(existsSync(join(current.codexHome, 'auth.json')), false);
        assert.ok(!/synthetic-refresh|synthetic-PAT|id_token|refresh_token/.test(readFileSync(join(current.codexHome, 'config.toml'), 'utf8')));
      }
    },
    observeLaunch: info => {
      launches.push(info);
      assert.equal(github.state.auth.phase, 'ready');
      assert.equal(github.state.auth.committed.generation, 2);
      assert.equal(decodeBundle(github.secret).digest, github.state.auth.committed.digest);
      assert.ok(events.indexOf('secret.put') < events.lastIndexOf('state.ready'));
      assert.ok(!/synthetic-refresh|synthetic-PAT|authBase64|id_token|refresh_token/.test(JSON.stringify(info.launch)));
      events.push('child.start');
    } });
  const oauth = new HostOAuth({ syntheticEndpoint: `${backend.url}/oauth/token`, fetchImpl: async (url, options) => {
    events.push('host.oauth'); return fetch(url, options);
  } });
  const session = new HostAuthSession({ store: github.storage, secrets: github.storage,
    serialization: github.serialization, oauth, vault: new LocalAuthVault(join(root, 'credentials.json')),
    runtime, snapshot: encodeBundle(bundle), grant: syntheticGrant, owner: 'stock-023' });
  return { root, backend, github, runtime, session, events, audit, launches };
}


const consume = async (b, reserved) => b.session.request('account/rateLimitResetCredit/consume', {
  creditId: reserved.request.creditId, idempotencyKey: reserved.request.idempotencyKey }, {
  requestId: reserved.request.requestId, expectedVersion: reserved.version, reservationProof: reserved.proof,
  dispatch: async (send, context) => {
    assert.equal(context.expectedVersion, (await b.github.storage.read()).version);
    const state = await b.github.storage.read();
    assert.ok(!state.disabled);
    const cycle = state.cycles.find(c => c.cycleId === reserved.request.cycleId);
    assert.ok(Math.floor(Date.now() / 1000) < cycle.deadline);
    return send();
  } });

test('stock host-owned OAuth publication precedes external login/read/selected consume; no child refresh or managed file', { skip: !real }, async t => {
  const b = await fixture(t);
  await b.session.service({ force: true });
  const read = await b.session.request('account/read', { refreshToken: true });
  assert.equal(read.account.type, 'chatgpt'); // selected mode remains explicitly external.
  assert.equal(parseRateLimits(await b.session.request('account/rateLimits/read', {
    excludeResetCreditDetails: false, supportsLunaReserve: false })).kind, 'details');
  let reserved;
  const proof = await b.session.reserveConsume(async () => { reserved = await reserve(b.github.storage); return reserved; });
  reserved.proof = proof;
  assert.deepEqual(await consume(b, reserved), { outcome: 'reset' });
  assert.equal(b.backend.state.refreshes, 1); // Sole host OAuth, before any child exists.
  assert.equal(b.events.filter(e => e === 'host.oauth').length, 1);
  assert.ok(b.events.indexOf('host.oauth') < b.events.indexOf('child.start'));
  assert.deepEqual(b.backend.state.requests.filter(r => r.creditId).map(({ creditId, idempotencyKey }) => ({ creditId, idempotencyKey })),
    [{ creditId: reserved.request.creditId, idempotencyKey: reserved.request.idempotencyKey }]);
  for (const launch of b.launches) await assert.rejects(readFile(join(launch.codexHome, 'auth.json')), { code: 'ENOENT' });
  assert.ok(b.audit.every(e => !/^(thread|turn|model)\//.test(e.method)));
  assert.ok(b.audit.filter(e => e.direction === 'send' && e.method === 'account/login/start')
    .every(e => JSON.stringify(e.paramKeys) === JSON.stringify(['accessToken', 'chatgptAccountId', 'chatgptPlanType', 'type'])));
  assert.deepEqual(b.backend.state.violations, []);
});

test('stock 401 and lost selected consume stop job without host refresh or speculative replay; unknown journal survives', { skip: !real }, async t => {
  for (const kind of ['401', '401-consume', 'loss']) {
    const b = await fixture(t); await b.session.service({ force: true });
    if (kind === '401') {
      b.backend.state.usageStatus = 401;
      await assert.rejects(b.session.request('account/rateLimits/read', { excludeResetCreditDetails: false }));
      assert.equal(b.backend.state.requests.filter(r => r.path === '/api/codex/usage').length, 1);
    } else {
      let reserved;
      const proof = await b.session.reserveConsume(async () => { reserved = await reserve(b.github.storage); return reserved; });
      reserved.proof = proof;
      if (kind === 'loss') b.backend.state.loss = true; else b.backend.state.consumeStatus = 401;
      await assert.rejects(consume(b, reserved));
      assert.equal(b.backend.state.requests.filter(r => r.creditId).length, 1);
      assert.equal((await b.github.storage.read()).requests[0].state, 'unconfirmed');
    }
    await assert.rejects(b.session.service({ force: true }), /job_stopped/);
    await assert.rejects(b.session.request('account/read', {}), /job_stopped/);
    assert.equal(b.backend.state.refreshes, 1); assert.deepEqual(b.backend.state.violations, []);
  }
});

test('trusted login seam imports only new isolated CI home after process exit and discards unrelated API key', { skip: !real }, async () => {
  const plan = await prepareCiLogin({ binary: binary() });
  try {
    assert.equal(plan.args.at(-1), 'login');
    assert.ok(!/synthetic-refresh|synthetic-PAT|OPENAI_API_KEY/.test(JSON.stringify(plan.env)));
    await assert.rejects(plan.complete({ processExited: false }), /login_process_not_closed/);
    const auth = JSON.parse(authBytes()); auth.OPENAI_API_KEY = 'synthetic-unrelated-api-key';
    await writeFile(join(plan.codexHome, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
    const bundle = await plan.complete({ processExited: true });
    assert.equal(bundle.schema, 2);
    assert.equal(JSON.parse(Buffer.from(bundle.authBase64, 'base64')).OPENAI_API_KEY, null);
    await assert.rejects(plan.cleanup({ processExited: false }), /login_process_not_closed/);
  } finally { await plan.cleanup({ processExited: true }); }
});

test('host HTTP timeout after synthetic rotation leaves inflight and never starts stock child', { skip: !real }, async t => {
  const b = await fixture(t); let release;
  b.backend.state.beforeRefreshReply = async () => new Promise(resolve => { release = resolve; });
  b.session.oauth.timeoutMs = 100;
  try {
    await assert.rejects(b.session.service({ force: true }), /oauth_unconfirmed/);
    assert.equal(b.backend.state.refreshes, 1);
    assert.equal(b.github.state.auth.phase, 'inflight');
    assert.equal(b.launches.length, 0);
    await assert.rejects(b.session.request('account/read', {}), /job_stopped/);
  } finally { release?.(); }
});

test('stock external login failure closes owned process before home cleanup with no managed fallback', { skip: !real }, async t => {
  const b = await fixture(t); await b.session.service({ force: true });
  await assert.rejects(b.runtime.open({ accessToken: 'invalid-synthetic-jwt', chatgptAccountId: 'account-synthetic-013' }), /rpc_error/);
  for (const launch of b.launches) await assert.rejects(readFile(join(launch.codexHome, 'config.toml')), { code: 'ENOENT' });
  assert.equal(b.backend.state.refreshes, 1);
  assert.equal(b.audit.filter(e => e.method === 'account/login/start').length, 1);
  assert.ok(!b.audit.some(e => e.method === 'account/read'));
});

test('stock disabled setup reads account/metadata without consume or enable', { skip: !real }, async t => {
  const b = await fixture(t);
  await b.session.service({ force: true });
  await b.github.storage.update(s => { s.disabled = true; });
  const account = await b.session.setupRead(b.github.state.version);
  assert.equal(account.account.type, 'chatgpt');
  const response = await b.session.setupMetadata(b.github.state.version);
  assert.equal(response.ordinaryUsageAllowed, false);
  assert.equal(response.rateLimits.primary.usedPercent, 100);
  assert.equal(response.rateLimitsByLimitId.codex.primary.usedPercent, 100);
  const metadata = parseRateLimits(response);
  assert.equal(metadata.kind, 'details'); assert.equal(b.github.state.disabled, true);
  assert.equal(b.backend.state.requests.filter(r => r.creditId).length, 0);
  assert.deepEqual(b.backend.state.violations, []);
});

test('stock external usage distinguishes denied, allowed, missing permission and identity mismatch without inference', { skip: !real }, async t => {
  const b = await bench({ authMode: 'external', binary: binary() });
  t.after(() => b.close());
  const read = () => b.rpc.request('account/rateLimits/read', {
    excludeResetCreditDetails: false, supportsLunaReserve: false,
  });
  for (const [name, transform, expected, reachedType] of [
    ['denied', value => ({ ...value, rate_limit_reached_type: { type: 'rate_limit_reached' } }), false, 'rate_limit_reached'],
    ['allowed despite rounded full window', value => ({ ...value, rate_limit: { ...value.rate_limit, allowed: true, limit_reached: false } }), true],
    ['workspace spend restriction', value => ({ ...value, rate_limit_reached_type: { type: 'workspace_member_usage_limit_reached' },
      spend_control: { reached: true } }), false, 'workspace_member_usage_limit_reached'],
    ['missing rate limit', value => ({ ...value, rate_limit: undefined }), null],
    ['null rate limit', value => ({ ...value, rate_limit: null }), null],
    ['missing account', value => ({ ...value, account_id: undefined }), null],
    ['missing user', value => ({ ...value, user_id: undefined }), null],
    ['other account', value => ({ ...value, account_id: 'other-synthetic-account' }), null],
    ['other user', value => ({ ...value, user_id: 'other-synthetic-user' }), null],
  ]) {
    b.backend.state.transformUsage = transform;
    const response = await read();
    assert.equal(response.ordinaryUsageAllowed, expected, name);
    if (reachedType) assert.equal(response.rateLimits.rateLimitReachedType, reachedType, name);
    if (name === 'workspace spend restriction') assert.equal(response.rateLimits.spendControlReached, true);
    assert.equal(parseRateLimits(response).kind, 'details', name);
    if (expected !== null) assert.equal(response.rateLimits.primary.usedPercent, 100, name);
    // Metadata is independently available even when inference permission is unknown.
  }
  assert.equal(b.backend.state.refreshes, 0);
  assert.equal(b.backend.state.requests.filter(r => r.creditId).length, 0);
  assert.deepEqual(b.backend.state.violations, []);
  assert.ok(b.audit.every(e => !/^(thread|turn|model)\//.test(e.method)));
});

test('stock external usage HTTP failures and malformed allowance reject instead of reporting zero or reusing metadata', { skip: !real }, async t => {
  const b = await bench({ authMode: 'external', binary: binary() });
  t.after(() => b.close());
  await b.account.read();
  for (const status of [401, 403, 429, 503]) {
    b.backend.state.usageStatus = status;
    const before = b.backend.state.requests.filter(r => r.path === '/api/codex/usage').length;
    await assert.rejects(b.account.read(), /rpc_error/);
    assert.equal(b.account.snapshot, null);
    assert.equal(b.backend.state.requests.filter(r => r.path === '/api/codex/usage').length, before + 1);
  }
  b.backend.state.usageStatus = 200;
  b.backend.state.transformUsage = value => ({ ...value, rate_limit: { ...value.rate_limit, allowed: 'invalid' } });
  await assert.rejects(b.account.read(), /rpc_error/);
  assert.equal(b.account.snapshot, null);
  assert.equal(b.backend.state.refreshes, 0);
  assert.equal(b.backend.state.requests.filter(r => r.creditId).length, 0);
  assert.deepEqual(b.backend.state.violations, []);
  assert.ok(b.audit.every(e => !/^(thread|turn|model)\//.test(e.method)));
});


test('stock check observer captures sanitized zero/details and stops without refresh, model or consume', { skip: !real }, async t => {
  const b = await fixture(t);
  await b.session.service({ force: true }); // Synthetic prerequisite; outside observer.
  await b.github.storage.update(s => { s.disabled = true; });
  const history = structuredClone(b.github.state.requests);
  b.backend.state.transformUsage = v => ({ ...v, rate_limit_reached_type: { type: 'rate_limit_reached' }, spend_control: { reached: false } });
  const now = () => Math.floor(Date.now() / 1000);
  let providers = 0;
  const refreshes = b.backend.state.refreshes;
  const result = await runCheckObserver({ session: b.session, storage: b.github.storage,
    workflow: { read: async () => ({ expressions: [] }) }, futureMinutes: 288, now,
    quotaProvider: async () => { providers++; return { observedAt: now(),
      quota: { periods: [{ start: now() - 100, end: now() + 86400, usedMinutes: 72,
        providerRemainingMinutes: 1928, paidUsageBlocked: true }], queuedJobs: 0, cleanupDelaySeconds: 600 },
      evidence: { outstandingMinutes: 10 } }; } });
  assert.equal(result.errorKind, null);
  assert.equal(result.account.state, 'received'); assert.equal(result.usage.identityMatches, true);
  assert.equal(result.usage.ordinaryUsageAllowed, false);
  assert.equal(result.zeroReadConfirmed, true); assert.equal(result.details.kind, 'details');
  assert.equal(providers, 4); assert.equal(b.backend.state.refreshes, refreshes);
  assert.deepEqual(b.github.state.requests, history); assert.equal(b.github.state.disabled, true);
  assert.deepEqual(b.backend.state.violations, []);
  assert.equal(b.backend.state.requests.filter(r => r.creditId).length, 0);
  assert.ok(b.audit.every(e => !/^(thread|turn|model)\//.test(e.method)));
  assert.ok(!/synthetic-account|synthetic-refresh|authBase64|bundleId|sessionId|accountId|email/.test(JSON.stringify(result)));
});
