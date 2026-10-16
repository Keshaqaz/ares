import test from 'node:test';
import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { makeBundle, encodeBundle, decodeBundle, bundleBytes, hostCredentials, AuthFailure, readyAuth } from '../src/session/auth-bundle.mjs';
import { HostAuthAdmin } from '../src/session/auth-admin.mjs';
import { HostOAuth } from '../src/session/host-oauth.mjs';
import { ExternalAuthRuntime } from '../src/session/external-auth-runtime.mjs';
import { runInstallerAdmin, sealAdmin } from '../src/installer/installer-admin.mjs';
import { runRevokeValidation, createRevokeVerifier, validateRevokePlan } from '../src/session/revoke-verifier.mjs';
import { githubFixture } from './support/github-fixture.mjs';
import { authBytes, syntheticGrant } from './support/auth-fixture.mjs';
import { fakeBackend } from './support/fake-backend.mjs';
import { syntheticNetworkGuard } from './support/bench.mjs';
import { addHistory } from './support/host-auth-fixture.mjs';
const plan = { schema: 1, futureMinutes: 286, oldRefresh: false };
const usage = id => ({ accountId: id, ordinaryUsageAllowed: true,
  rateLimits: { limitId: 'codex' }, rateLimitResetCredits: { availableCount: 0, credits: [] } });
async function fixture() {
  const bundle = makeBundle(authBytes(), { protocol: 2 });
  const g = await githubFixture({ initialBundle: bundle }); g.state.disabled = true;
  let time = 1000, revokes = 0, refreshes = 0, reads = 0, closes = 0, providers = 0;
  const id = hostCredentials(bundleBytes(bundle)).accountId;
  const w = { g, bundle, beforeSend: async () => {}, value: () => usage(id), failRevoke: false,
    failRuntime: false, failQuota: false, opens: [], raw: [], states: [] };
  w.args = { storage: g.storage, workflow: { read: async () => ({ expressions: [] }) }, serialization: g.serialization,
    snapshot: encodeBundle(bundle), grant: syntheticGrant, expectedVersion: g.state.version,
    admin: new HostAuthAdmin({ store: g.storage, secrets: g.storage, serialization: g.serialization, owner: 'revoke-test' }),
    oauth: { revoke: async () => { revokes++; w.states.push(structuredClone(g.state));
      if (w.failRevoke) throw new AuthFailure('oauth_revoke_unconfirmed'); return { kind: 'revokeAccepted', propagation: 'unverified' }; },
      refresh: async () => { refreshes++; return makeBundle(authBytes(1), { previous: bundle }); } },
    runtime: { open: async tokens => { w.opens.push(tokens); return { request: async method => {
      assert.equal(method, 'account/rateLimits/read'); reads++; await w.beforeSend();
      if (w.failRuntime && g.state.revoked) throw new AuthFailure('rpc_error'); return w.value(); },
      close: async () => { closes++; } }; } },
    quotaProvider: async () => { providers++; if (w.failQuota) throw new AuthFailure('quota_unavailable');
      return { observedAt: time, quota: { periods: [{ start: 0, end: 86400, usedMinutes: 76,
        providerRemainingMinutes: 1924, paidUsageBlocked: true }], queuedJobs: 0, cleanupDelaySeconds: 600 },
      evidence: { outstandingMinutes: 10 } }; },
    plan, now: () => time, sleep: async seconds => { time += seconds; },
    fetchImpl: async (url, options) => { w.raw.push({ url, method: options.method }); return new Response(null, { status: w.status ?? 401 }); } };
  w.counts = () => ({ revokes, refreshes, reads, closes, providers });
  w.advance = seconds => { time += seconds; };
  return w;
}

test('finite validation keeps same A, stops durably, preserves exact applied/unknown journals and never publishes', async () => {
  const w = await fixture();
  w.g.state.disabled = false;
  await addHistory({ disk: w.g.storage });
  await w.g.storage.update(s => { s.disabled = true; });
  w.args.expectedVersion = w.g.state.version;
  assert.deepEqual(w.g.state.requests.map(r => r.state), ['applied', 'unconfirmed']);
  const requests = structuredClone(w.g.state.requests), cycles = structuredClone(w.g.state.cycles);
  const r = await runRevokeValidation(w.args);
  assert.equal(r.revoke, 'revokeAccepted'); assert.equal(r.localStopped, true);
  assert.deepEqual(r.probes.map(p => [p.offset, p.state]), [[0, 'success'], [60, 'success'], [300, 'success']]);
  assert.equal(w.counts().revokes, 1); assert.equal(w.counts().refreshes, 0);
  assert.equal(w.counts().reads, 4); assert.equal(w.counts().closes, 4);
  assert.ok(w.opens.every(t => t.accessToken === w.opens[0].accessToken));
  assert.equal(w.g.state.revoked, true); assert.equal(w.g.state.disabled, true);
  assert.deepEqual(w.g.state.requests, requests); assert.deepEqual(w.g.state.cycles, cycles);
  assert.equal(w.g.secret, null); assert.equal(w.raw.length, 0);
  assert.ok(!/synthetic-refresh|synthetic-PAT|authBase64|accountId/.test(JSON.stringify(r)));
});

test('stale version/tuple/grant/writer/cron/readback stop before revoke HTTP', async () => {
  for (const kind of ['version', 'tuple', 'grant', 'writer', 'cron', 'readback']) {
    const w = await fixture();
    if (kind === 'version') w.args.expectedVersion++;
    if (kind === 'tuple') w.args.snapshot = encodeBundle(makeBundle(authBytes(), { protocol: 2 }));
    if (kind === 'grant') w.args.grant = 'other-grant';
    if (kind === 'writer') w.g.serialized = false;
    if (kind === 'cron') w.args.workflow.read = async () => ({ expressions: ['* * * * *'] });
    if (kind === 'readback') w.args.admin.confirm = async () => { throw new AuthFailure('state_readback_failed'); };
    const r = await runRevokeValidation(w.args).catch(e => ({ errorKind: e.kind }));
    assert.ok(r.errorKind, kind); assert.equal(w.counts().revokes, 0, kind); assert.equal(w.counts().refreshes, 0);
  }
});

test('lost revoke response leaves durable stop and cannot retry the same or a new job', async () => {
  const w = await fixture(); w.failRevoke = true;
  const r = await runRevokeValidation(w.args);
  assert.equal(r.revoke, 'unconfirmed'); assert.equal(r.localStopped, true); assert.equal(r.probes.length, 0);
  w.args.expectedVersion = w.g.state.version;
  const again = await runRevokeValidation(w.args);
  assert.equal(again.errorKind, 'durable_revoke_required'); assert.equal(w.counts().revokes, 1);
  assert.equal(w.g.state.revoked, true);
});

test('accepted revoke is separate from A success and corroborated pre-expiry 401; 403/429/5xx/network unknown', async () => {
  for (const status of [401, 403, 429, 503, null]) {
    const w = await fixture(); w.failRuntime = true; w.status = status;
    if (status === null) w.args.fetchImpl = async () => { throw new Error('secret-network-body'); };
    const r = await runRevokeValidation(w.args);
    assert.equal(r.revoke, 'revokeAccepted');
    assert.equal(r.probes[0].state, status === 401 ? 'authDeniedBeforeExpiry' : 'unknown');
    assert.equal(r.probes.length, 1); assert.equal(w.counts().refreshes, 0);
    assert.ok(!JSON.stringify(r).includes('secret-network-body'));
  }
});

test('baseline countOnly/identity mismatch and late A expiry never trigger revoke or refresh', async () => {
  for (const kind of ['countOnly', 'identity', 'expiry']) {
    const w = await fixture();
    if (kind === 'countOnly') w.value = () => ({ ...usage('account-synthetic-013'), rateLimitResetCredits: { availableCount: 1 } });
    if (kind === 'identity') w.value = () => usage('wrong');
    if (kind === 'expiry') w.advance(4102444800);
    if (kind === 'expiry') await assert.rejects(runRevokeValidation(w.args), /access_expired/);
    else assert.equal((await runRevokeValidation(w.args)).errorKind, 'baseline_unconfirmed');
    assert.equal(w.counts().revokes, 0); assert.equal(w.counts().refreshes, 0);
  }
});

test('natural expiry skips network; verifier cleanup prevents reuse', async () => {
  let sent = 0;
  const verifier = createRevokeVerifier({ runtime: { open: () => { sent++; } }, tokens: { accessToken: 'A' },
    expiresAt: 1000, now: () => 1000, admit: () => { sent++; } });
  assert.equal((await verifier.probe()).state, 'naturalExpiry'); assert.equal(sent, 0);
  verifier.close(); await assert.rejects(verifier.probe(), /verifier_closed/);
});

test('refresh success is once, sealed quarantine decrypts exactly, never published or given to runtime', async () => {
  await sodium.ready; const key = sodium.crypto_box_keypair();
  const w = await fixture(); w.args.plan = { ...plan, oldRefresh: true, quarantinePublicKey: Buffer.from(key.publicKey).toString('base64') };
  const r = await runRevokeValidation(w.args);
  assert.equal(r.refresh, 'successQuarantined'); assert.equal(w.counts().refreshes, 1);
  assert.equal(w.g.secret, null); assert.equal(w.opens.length, 4);
  const plain = sodium.crypto_box_seal_open(Buffer.from(r.quarantine.ciphertext, 'base64'), key.publicKey, key.privateKey);
  assert.equal(decodeBundle(Buffer.from(plain).toString()).generation, 2);
  assert.ok(!/synthetic-refresh|authBase64/.test(JSON.stringify(r)));
});

test('refresh denial reasons remain distinct; generic invalid_grant never becomes revoke evidence', async () => {
  await sodium.ready; const key = sodium.crypto_box_keypair();
  for (const kind of ['oauth_revoked', 'oauth_expired', 'oauth_reused', 'oauth_invalid_grant', 'oauth_unconfirmed']) {
    const w = await fixture(); w.args.plan = { ...plan, oldRefresh: true, quarantinePublicKey: Buffer.from(key.publicKey).toString('base64') };
    let calls = 0; w.args.oauth.refresh = async () => { calls++; throw new AuthFailure(kind); };
    const r = await runRevokeValidation(w.args); assert.equal(r.refresh, kind); assert.equal(calls, 1);
    assert.equal(r.quarantine, undefined);
  }
});

test('fresh provider after startup/queue and at each probe; expiry during provider forbids HTTP', async () => {
  const w = await fixture();
  const original = w.args.quotaProvider;
  w.args.quotaProvider = async () => { const receipt = await original(); w.advance(302); return receipt; };
  const r = await runRevokeValidation(w.args); assert.equal(r.errorKind, 'quota_unavailable');
  assert.equal(w.opens.length, 0); assert.equal(w.counts().revokes, 0);
  const q = await fixture(); q.args.runtime.open = async () => { q.failQuota = true; return { request: () => assert.fail('no RPC'), close: async () => {} }; };
  const result = await runRevokeValidation(q.args); assert.equal(result.errorKind, 'quota_unavailable'); assert.equal(q.counts().revokes, 0);
});

test('encrypted admin delivery supports bounded revoke and exact duplicate never repeats HTTP', async () => {
  const w = await fixture(), pin = 'a'.repeat(40);
  const c = sealAdmin('synthetic/private', syntheticGrant, { action: 'revoke-session', commandId: 'revoke21', expectedVersion: w.g.state.version }, plan);
  const options = { ...w.args, command: c, programCommit: pin, verifierRuntime: w.args.runtime,
    verifierOptions: { sleep: w.args.sleep, fetchImpl: w.args.fetchImpl } };
  const r = await runInstallerAdmin(options); assert.equal(r.revokeValidation.revoke, 'revokeAccepted');
  const repeated = await runInstallerAdmin(options); assert.equal(repeated.duplicate, true);
  assert.equal(w.counts().revokes, 1); assert.equal(w.g.state.installation.operation.phase, 'done');
});

test('plan is finite and refresh permission/key cannot be silently inferred', () => {
  for (const p of [{ ...plan, offsets: [0, 600] }, { ...plan, oldRefresh: true }, { ...plan, oldRefresh: undefined }]) {
    assert.throws(() => validateRevokePlan(p));
  }
});

const real = process.env.AUTO_RESET_CONTRACT_MODE === 'app-server';
test('stock independent verifier passes on same A while production state revoked; owned homes removed and no refresh/consume/model', { skip: !real }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'revoke-stock-')); const backend = await fakeBackend();
  t.after(async () => { await backend.close(); await rm(root, { recursive: true, force: true }); });
  const w = await fixture(); const launches = [], audit = [];
  w.args.runtime = new ExternalAuthRuntime({ binary: realpathSync(process.env.AUTO_RESET_CODEX_BIN),
    syntheticBackend: backend.url, networkGuard: await syntheticNetworkGuard(backend.url),
    audit: e => audit.push(e), observeLaunch: i => launches.push(i) });
  w.args.syntheticBackend = backend.url;
  w.args.fetchImpl = fetch;
  const r = await runRevokeValidation(w.args);
  assert.equal(r.revoke, 'revokeAccepted'); assert.equal(r.probes.length, 3);
  assert.ok(r.probes.every(p => p.state === 'success'));
  assert.equal(backend.state.refreshes, 0); assert.deepEqual(backend.state.violations, []);
  assert.equal(backend.state.requests.filter(r => r.path === '/api/codex/usage').length, 4);
  assert.ok(!backend.state.requests.some(r => r.creditId));
  assert.ok(audit.every(e => !/^(thread|turn|model)\//.test(e.method)));
  for (const l of launches) { assert.equal(existsSync(l.root), false); assert.ok(!/refresh_token|synthetic-refresh|synthetic-PAT/.test(JSON.stringify(l.launch))); }
  // Direct status corroboration on a stock rpc_error is independent of its erased error text.
  backend.state.usageStatus = 401; backend.state.detailsStatus = 401;
  const c = hostCredentials(bundleBytes(w.bundle));
  const verifier = createRevokeVerifier({ runtime: w.args.runtime, tokens: { accessToken: c.auth.tokens.access_token, chatgptAccountId: c.accountId },
    expiresAt: c.expiresAt, now: w.args.now, admit: async () => {}, syntheticBackend: backend.url });
  assert.equal((await verifier.probe()).state, 'authDeniedBeforeExpiry'); verifier.close();
  assert.equal(backend.state.refreshes, 0); assert.deepEqual(backend.state.violations, []);
});

test('probe deadline and stale tuple after child startup stop network; refresh 5xx is unknown, not invalid_grant', async () => {
  const late = await fixture(); late.args.sleep = async seconds => { late.advance(seconds + 31); };
  const r = await runRevokeValidation(late.args);
  assert.equal(r.errorKind, 'probe_window_missed'); assert.equal(late.counts().revokes, 1); assert.equal(late.counts().refreshes, 0);
  const stale = await fixture(); const open = stale.args.runtime.open;
  stale.args.runtime.open = async tokens => { const handle = await open(tokens); stale.g.state.version++; return handle; };
  const s = await runRevokeValidation(stale.args); assert.equal(s.errorKind, 'verifier_state_changed');
  assert.equal(stale.counts().reads, 0); assert.equal(stale.raw.length, 0);
  await sodium.ready; const keys = sodium.crypto_box_keypair();
  const failed = await fixture(); failed.args.plan = { ...plan, oldRefresh: true, quarantinePublicKey: Buffer.from(keys.publicKey).toString('base64') };
  let refreshes = 0;
  failed.args.oauth = new HostOAuth({ now: failed.args.now, fetchImpl: async url => {
    if (url.endsWith('/revoke')) return new Response(null, { status: 200 });
    refreshes++; return Response.json({ error: 'invalid_grant' }, { status: 503 });
  } });
  const f = await runRevokeValidation(failed.args);
  assert.equal(f.refresh, 'oauth_unconfirmed'); assert.equal(f.refreshHttpStatus, 503); assert.equal(refreshes, 1);
});

test('revoke runtime publication checks all new immutable files and rejects old deployment before dispatch', async () => {
  const { readFile } = await import('node:fs/promises');
  const { verifyRevokeRuntime } = await import('../src/account/observer-dispatch.mjs');
  const { renderPrivateWorkflow } = await import('../src/workflow/private-workflow.mjs');
  let wrong = false; const pin = 'a'.repeat(40);
  const github = { repositoryInfo: async () => ({ default_branch: 'main' }), file: async (path, ref) => {
    const bytes = path === '.github/workflows/auto-reset.yml' ? await renderPrivateWorkflow(pin) :
      wrong && path === 'src/session/revoke-verifier.mjs' ? 'old-source' : await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.equal(ref, path === '.github/workflows/auto-reset.yml' ? 'main' : pin);
    return { encoding: 'base64', content: Buffer.from(bytes).toString('base64') };
  } };
  await verifyRevokeRuntime(github, { installation: { programCommit: pin } });
  wrong = true; await assert.rejects(verifyRevokeRuntime(github, { installation: { programCommit: pin } }), /observer_runtime_not_published/);
});

test('dispatch is closed without explicit scope and offline quarantine key never overwrites existing files', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { readFile, stat } = await import('node:fs/promises');
  const run = promisify(execFile);
  await assert.rejects(run(process.execPath, ['scripts/revoke-session.mjs'], { env: {} }), e =>
    e.stdout.trim() === '{"error":"explicit_revoke_scope_required"}');
  const root = await mkdtemp(join(tmpdir(), 'quarantine-key-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'keys');
  await run(process.execPath, ['scripts/revoke-quarantine-key.mjs', path], { env: {} });
  const original = await readFile(join(path, 'private.key'));
  assert.equal((await stat(join(path, 'private.key'))).mode & 0o777, 0o600);
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  assert.equal(Buffer.from(original.toString(), 'base64').length, 32);
  await assert.rejects(run(process.execPath, ['scripts/revoke-quarantine-key.mjs', path], { env: {} }));
  assert.deepEqual(await readFile(join(path, 'private.key')), original);
});
