import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { hostFixture, hostBytes, addHistory, NOW } from '../testing/host-auth-fixture.mjs';
import { syntheticGrant } from '../testing/auth-fixture.mjs';
import { AuthFailure, makeBundle, readyAuth, tuple, encodeBundle, bundleBytes } from '../src/auth-bundle.mjs';
import { HostAuthAdmin, AuthAdmin } from '../src/auth-admin.mjs';
import { AuthSession } from '../src/auth-session.mjs';
import { FileStateStore } from '../src/state-store.mjs';

const request = session => session.request('account/read', { refreshToken: true });
const noNetwork = w => assert.ok(!w.events.some(e => ['oauth.rotation', 'child.login', 'account.rpc'].includes(e)), w.events.join(','));
const admin = w => new HostAuthAdmin({ store: w.store, secrets: w.secrets, serialization: w.serialization, owner: 'setup-023' });
const history = state => Object.fromEntries(['cycles', 'groups', 'requests', 'commands'].map(key => [key, state[key]]));

test('host intent/readback → OAuth → atomic local save → target/readback → Secret → finalize/readback → external login → RPC', async t => {
  const w = await hostFixture(t); const session = w.host();
  await request(session);
  assert.deepEqual(w.events.filter(e => !['state.read_latest', 'grant.preflight'].includes(e)),
    ['state.intent_durable', 'oauth.rotation', 'local.before_save', 'local.saved', 'state.target_durable',
      'secret.put', 'secret.put_confirmed', 'state.ready_durable', 'child.login', 'account.rpc', 'child.closed']);
  assert.equal((await w.disk.read()).auth.committed.generation, 2);
  assert.deepEqual(w.childTokens, { accessToken: JSON.parse(bundleBytes(w.secret)).tokens.access_token,
    chatgptAccountId: 'account-synthetic-013', chatgptPlanType: 'pro' });
  assert.equal((await lstat(w.localVault.path)).mode & 0o777, 0o600);
  await request(session); assert.equal(w.refreshes, 1);
  await session.service({ force: true }); assert.equal(w.refreshes, 2);
  assert.ok(!/synthetic-refresh|access_token|authBase64|synthetic-PAT|example.invalid/.test(await readFile(w.disk.path, 'utf8')));
});

for (const cut of ['state.intent_durable', 'oauth.rotation', 'local.before_save', 'local.saved',
  'state.target_durable', 'secret.put', 'secret.put_confirmed', 'state.ready_durable']) {
  test(`host crash at ${cut}: old grant never reused; exact local or Secret recovery`, async t => {
    const w = await hostFixture(t); const session = w.host();
    w.hook = async e => { if (e === cut) throw new AuthFailure('crash'); };
    await assert.rejects(request(session), /crash/);
    await assert.rejects(request(session), /job_stopped/);
    assert.ok(!w.events.includes('child.login'));
    w.hook = async () => {}; const count = w.refreshes; w.events = [];
    const state = await w.disk.read();
    if (state.auth.phase === 'ready') {
      await assert.rejects(w.host(w.initial).admit(), /stale_snapshot/);
      await w.host().admit();
    } else if (['local.saved', 'state.target_durable', 'secret.put', 'secret.put_confirmed'].includes(cut)) {
      await w.host(w.initial).recoverLocal();
      assert.equal((await w.disk.read()).auth.committed.generation, 2);
    } else {
      await assert.rejects(w.host().admit(), /reconnect_required/);
      await assert.rejects(w.host().recoverLocal(), /local_auth_unconfirmed/);
    }
    assert.equal(w.refreshes, count); noNetwork(w);
  });
}

for (const accepted of [false, true]) {
  test(`lost Secret PUT accepted=${accepted}: exact target persistence retry, no OAuth`, async t => {
    const w = await hostFixture(t); w.putAccepted = accepted; w.putLost = true;
    await assert.rejects(request(w.host()), /storage_unconfirmed/);
    const record = await w.localVault.read();
    w.putLost = false; w.putAccepted = true;
    await w.host(w.initial).recoverLocal();
    assert.deepEqual(tuple(w.secret), tuple(record.bundle)); assert.equal(w.refreshes, 1);
    assert.ok(!w.events.includes('child.login'));
    await assert.rejects(w.host(w.initial).admit(), /stale_snapshot/);
    await w.host().admit();
  });
}

for (const [name, prepare, reason] of [
  ['malformed', w => { w.malformed = true; }, 'oauth_unconfirmed'],
  ['empty', w => { w.oauthBody = {}; }, 'oauth_invalid_response'],
  ['bad optional', w => { w.oauthBody = { access_token: 5 }; }, 'oauth_invalid_response'],
  ['identity', w => { w.identity = { accountId: 'other-workspace' }; }, 'invalid_auth_bundle'],
  ['user identity', w => { w.identity = { userId: 'another-user' }; }, 'identity_changed'],
  ['revoked', w => { w.oauthStatus = 401; w.oauthBody = { error: 'refresh_token_invalidated' }; }, 'oauth_revoked'],
  ['expired', w => { w.oauthStatus = 400; w.oauthBody = { error: 'refresh_token_expired' }; }, 'oauth_expired'],
  ['reused', w => { w.oauthStatus = 400; w.oauthBody = { error: 'refresh_token_reused' }; }, 'oauth_reused'],
  ['invalid grant', w => { w.oauthStatus = 400; w.oauthBody = { error: 'invalid_grant' }; }, 'oauth_invalid_grant'],
  ['lost response', w => { w.responseLost = true; }, 'oauth_unconfirmed'],
  ['local failure', w => { w.localFailed = true; }, 'local_auth_save_failed'],
  ['target failure', w => { w.hook = async e => { if (e === 'local.saved') w.stateWritable = false; }; }, 'state_write_failed'],
  ['finalize failure', w => { w.hook = async e => { if (e === 'secret.put_confirmed') w.stateWritable = false; }; }, 'state_write_failed'],
  ['grant after rotation', w => { w.hook = async e => { if (e === 'local.saved') w.grantValid = false; }; }, 'stop_grant'],
]) {
  test(`host ${name} stops before child and prevents subsequent refresh/read/consume`, async t => {
    const w = await hostFixture(t); prepare(w); const session = w.host();
    await assert.rejects(request(session), new RegExp(reason));
    assert.ok(!w.events.includes('child.login'));
    await assert.rejects(session.service({ force: true }), /job_stopped/);
    await assert.rejects(request(session), /job_stopped/);
    assert.equal(w.refreshes, 1);
    assert.ok(['inflight', 'publishing'].includes((await w.disk.read()).auth.phase));
  });
}

test('optional omitted/null ID and refresh fields retain values; fresh access is checked against identity', async t => {
  const w = await hostFixture(t);
  const old = JSON.parse(bundleBytes(w.initial));
  w.oauthBody = { access_token: JSON.parse(hostBytes(1)).tokens.access_token, id_token: null };
  await request(w.host());
  const next = JSON.parse(bundleBytes(w.secret));
  assert.equal(next.tokens.id_token, old.tokens.id_token);
  assert.equal(next.tokens.refresh_token, old.tokens.refresh_token);
});

test('unknown access expiry triggers maintenance and remains blocked if the new expiry is unknown', async t => {
  const w = await hostFixture(t);
  const bytes = JSON.parse(hostBytes());
  const parts = bytes.tokens.access_token.split('.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url')); delete claims.exp;
  parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url'); bytes.tokens.access_token = parts.join('.');
  w.initial = w.secret = makeBundle(Buffer.from(JSON.stringify(bytes)), { protocol: 2 });
  await w.disk.update(s => { s.auth = readyAuth(w.initial, syntheticGrant); });
  w.oauthBody = { refresh_token: 'synthetic-refresh-1' };
  await assert.rejects(request(w.host()), /access_expiry_unknown/);
  assert.equal(w.refreshes, 1); assert.ok(!w.events.includes('child.login'));
});

for (const flag of ['disabled', 'revoked', 'stale', 'grant', 'writer', 'protocol', 'intent write', 'intent readback']) {
  test(`host admission ${flag} stops before OAuth or child`, async t => {
    const w = await hostFixture(t);
    if (flag === 'disabled') await w.disk.update(s => { s.disabled = true; });
    if (flag === 'revoked') await w.disk.update(s => { s.revoked = true; });
    if (flag === 'stale') await w.disk.update(s => { s.auth = readyAuth(makeBundle(hostBytes(), { protocol: 2 }), syntheticGrant); });
    if (flag === 'grant') await w.disk.update(s => { s.auth.grantFingerprint = 'f'.repeat(64); });
    if (flag === 'writer') w.writerLost = true;
    if (flag === 'protocol') await w.disk.update(s => { s.auth.protocol = 1; });
    if (flag === 'intent write') w.stateWritable = false;
    if (flag === 'intent readback') {
      const read = w.store.read;
      w.store.read = async () => { const state = await read(); if (state.auth.phase === 'inflight') state.version--; return state; };
    }
    await assert.rejects(request(w.host())); noNetwork(w);
  });
}

test('reconnect same identity preserves applied groups, unknown requests, command journals and original boundaries', async t => {
  const w = await hostFixture(t); await addHistory(w);
  await admin(w).disable((await w.disk.read()).version);
  const before = await w.disk.read();
  assert.ok(before.requests.some(r => r.state === 'applied'));
  assert.ok(before.requests.some(r => r.state === 'unconfirmed'));
  const bundle = await admin(w).seed(hostBytes(1), syntheticGrant, before.version);
  const after = await w.disk.read();
  assert.notEqual(bundle.sessionId, w.initial.sessionId); assert.equal(after.disabled, true);
  assert.deepEqual(history(after), history(before));
  await w.host(bundle).setupRead(after.version);
  assert.deepEqual(history(await w.disk.read()), history(before));
  await assert.rejects(request(w.host(bundle)), /disabled/);
  await w.disk.update(s => { s.disabled = false; });
  await assert.rejects(request(w.host(bundle)), /consume_outcome_unknown/);
});

for (const identity of [{ accountId: 'other-workspace' }, { userId: 'other-user' }]) {
  test(`reconnect rejects different identity ${JSON.stringify(identity)} BEFORE target or Secret`, async t => {
    const w = await hostFixture(t); await addHistory(w); await admin(w).disable((await w.disk.read()).version);
    const before = await w.disk.read(), secret = w.secret; w.events = [];
    await assert.rejects(admin(w).seed(hostBytes(1, identity), syntheticGrant, before.version), /identity_changed/);
    assert.deepEqual(await w.disk.read(), before); assert.deepEqual(w.secret, secret);
    assert.ok(!w.events.includes('secret.put'));
  });
}

test('disabled setup restricts auth/read only; stale/revoked/grant/version/protocol never bypass admission', async t => {
  const w = await hostFixture(t); await admin(w).disable((await w.disk.read()).version);
  const version = (await w.disk.read()).version;
  await assert.rejects(w.host().request('account/rateLimitResetCredit/consume', {}, { setup: true }), /method_forbidden/);
  await assert.rejects(w.host().request('enable', {}, { setup: true }), /method_forbidden/);
  await assert.rejects(w.host().setupRead(version - 1), /state_conflict/);
  await assert.rejects(w.host(makeBundle(hostBytes(1), { protocol: 2 })).setupRead(version), /stale_snapshot/);
  await assert.rejects(w.host(w.secret, { grant: 'other-grant' }).setupRead(version), /stale_grant/);
  await w.host().setupRead(version);
  assert.equal((await w.disk.read()).disabled, true);
  await admin(w).disable((await w.disk.read()).version, { revoke: true });
  await assert.rejects(w.host().setupRead((await w.disk.read()).version), /reconnect_required/);
});

test('explicit disabled protocol migration binds exact old bundle and preserves existing history; rollback is denied', async t => {
  const w = await hostFixture(t); await addHistory(w);
  const old = makeBundle(hostBytes());
  await w.disk.update(s => { s.disabled = true; s.auth = readyAuth(old, syntheticGrant); });
  const before = await w.disk.read();
  await assert.rejects(admin(w).seed(hostBytes(1), syntheticGrant, before.version), /invalid_auth_bundle/);
  const migrated = await admin(w).seed(hostBytes(1), syntheticGrant, before.version, { previousSnapshot: encodeBundle(old) });
  assert.equal((await w.disk.read()).auth.protocol, 2);
  assert.deepEqual(history(await w.disk.read()), history(before));
  const legacy = new AuthAdmin({ store: w.store, secrets: w.secrets, owner: 'old-015' });
  await assert.rejects(legacy.seed(hostBytes(), syntheticGrant, (await w.disk.read()).version), /incompatible_auth_protocol/);
  await w.disk.update(s => { s.disabled = false; });
  const rollback = new AuthSession({ store: w.store, secrets: w.secrets, runtime: w.runtime,
    snapshot: encodeBundle(migrated), grant: syntheticGrant, owner: 'old-015' });
  await assert.rejects(rollback.admit(), /incompatible_auth_protocol/);
});

test('dispatch after publication/startup sees own versions; foreign command, disable and elapsed expiry stop send', async t => {
  for (const action of ['version', 'disabled', 'time']) {
    const w = await hostFixture(t);
    await assert.rejects(w.host().request('account/read', {}, { dispatch: async (send, context) => {
      assert.deepEqual(context.authVersions, [context.baseVersion + 1, context.baseVersion + 2, context.baseVersion + 3]);
      assert.ok(w.events.includes('child.login'));
      if (action === 'time') w.clock = NOW + 3600;
      else await w.disk.update(s => { if (action === 'disabled') s.disabled = true; else s.settings.deltaSeconds++; });
      return send();
    } }), /state_conflict|disabled|access_expired/);
    assert.ok(!w.events.includes('account.rpc')); assert.ok(w.events.includes('child.closed'));
  }
});

test('failed RPC or cleanup stops future auth intervals, raw errors are sanitized', async t => {
  for (const flag of ['rpcFailed', 'cleanupFailed']) {
    const w = await hostFixture(t); w[flag] = true; const session = w.host();
    await assert.rejects(request(session), /auth_failed|runtime_cleanup_failed/);
    await assert.rejects(session.service({ force: true }), /job_stopped/);
    assert.equal(w.refreshes, 1);
  }
});

test('local recovery rejects tampered operation, target, version and changed command history', async t => {
  const w = await hostFixture(t);
  w.hook = async e => { if (e === 'local.saved') throw new AuthFailure('crash'); };
  await assert.rejects(request(w.host())); w.hook = async () => {};
  const saved = await w.localVault.read();
  await writeFile(w.localVault.path, JSON.stringify({ ...saved, operationId: 'wrong' }), { mode: 0o600 });
  await assert.rejects(w.host().recoverLocal(), /local_auth_unconfirmed/);
  await w.localVault.save(saved);
  await w.disk.update(s => { s.settings.deltaSeconds++; });
  await assert.rejects(w.host().recoverLocal(), /state_conflict/);
  assert.equal(w.refreshes, 1); assert.ok(!w.events.includes('child.login'));
});

test('explicit external owner survives missing account type; account/read(true) never claims host OAuth refresh', async t => {
  const w = await hostFixture(t);
  w.external.open = async () => { const handle = { closed: false, request: async () => ({ account: {} }),
    close: async () => { handle.closed = true; } }; return handle; };
  const { AccountAdapter } = await import('../src/account.mjs');
  const account = new AccountAdapter(w.host());
  assert.deepEqual(await account.refresh(), { kind: 'accountRead', authType: 'chatgptAuthTokens', tokenRefresh: 'externalOwnerRequired' });
});

test('foreign credentials/params cannot cross the external account RPC boundary', async t => {
  const w = await hostFixture(t);
  await assert.rejects(w.host().request('account/read', { refresh_token: 'synthetic-secret' }), /invalid_account_params/);
  await assert.rejects(w.host().request('account/read', { refreshToken: 'synthetic-secret' }), /invalid_account_params/);
  noNetwork(w);
});

for (const cut of ['inflight', 'rotation', 'local', 'publishing', 'secret', 'ready']) {
  test(`host SIGKILL at ${cut}: disk recovery cannot initiate another OAuth`, async t => {
    const { fork } = await import('node:child_process');
    const { once } = await import('node:events');
    const w = await hostFixture(t);
    await writeFile(join(w.root, 'snapshot.json'), encodeBundle(w.initial), { mode: 0o600 });
    const child = fork(new URL('../testing/host-auth-crash-fixture.mjs', import.meta.url), [w.root, cut], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [], env: { PATH: process.env.PATH } });
    t.after(() => child.kill('SIGKILL'));
    const exited = once(child, 'exit'), message = once(child, 'message');
    const guard = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await Promise.race([message, exited.then(() => { throw new Error('missed_crash_boundary'); })]);
      child.kill('SIGKILL'); await exited;
    } finally { clearTimeout(guard); }
    const { decodeBundle } = await import('../src/auth-bundle.mjs');
    w.secret = decodeBundle(await readFile(join(w.root, 'snapshot.json'), 'utf8'));
    if (['inflight', 'rotation'].includes(cut)) {
      await assert.rejects(w.host().admit(), /reconnect_required/);
      await assert.rejects(w.host().recoverLocal(), /local_auth_unconfirmed/);
    } else if (['local', 'publishing'].includes(cut)) {
      await w.host().recoverLocal();
    } else {
      await w.host().admit();
    }
    assert.equal(w.refreshes, 0); noNetwork(w);
  });
}

test('consume requires current-job reservation proof; a prior unknown request or forged proof never permits replay', async t => {
  const { reserve } = await import('../testing/consume-reservation-fixture.mjs');
  const w = await hostFixture(t); const session = w.host();
  let reserved;
  const proof = await session.reserveConsume(async () => { reserved = await reserve(w.disk, 'selected-013', NOW); return reserved; });
  const params = { creditId: reserved.request.creditId, idempotencyKey: reserved.request.idempotencyKey };
  const options = { requestId: reserved.request.requestId, expectedVersion: reserved.version,
    reservationProof: proof, dispatch: (send, context) => { assert.equal(context.baseVersion, reserved.version); return send(); } };
  await assert.rejects(w.host().request('account/rateLimitResetCredit/consume', params, options), /consume_reservation_required/);
  await assert.rejects(session.request('account/rateLimitResetCredit/consume', params, { ...options, reservationProof: { ...proof } }), /consume_reservation_required/);
  await session.request('account/rateLimitResetCredit/consume', params, options);
  await assert.rejects(session.request('account/rateLimitResetCredit/consume', params, options), /consume_reservation_required/);
  assert.equal(w.events.filter(e => e === 'account.rpc').length, 1);
  await assert.rejects(w.host().reserveConsume(() => reserve(w.disk, 'other', NOW)), /consume_outcome_unknown/);
  assert.equal((await w.disk.read()).requests[0].state, 'unconfirmed');
});

test('explicit fresh reconnect after lost target keeps history and identity while old publication cannot recover', async t => {
  const w = await hostFixture(t);
  w.hook = async e => { if (e === 'state.target_durable') throw new AuthFailure('crash'); };
  await assert.rejects(request(w.host())); w.hook = async () => {};
  await addHistory(w); await admin(w).disable((await w.disk.read()).version);
  const before = await w.disk.read();
  await assert.rejects(admin(w).seed(hostBytes(3, { accountId: 'other' }), syntheticGrant, before.version), /identity_changed/);
  const fresh = await admin(w).seed(hostBytes(3), syntheticGrant, before.version);
  assert.deepEqual(history(await w.disk.read()), history(before));
  assert.notEqual(fresh.sessionId, w.initial.sessionId);
  await assert.rejects(w.host(w.initial).recoverLocal({ setup: true }), /local_auth_unconfirmed/);
});

test('remote revoke seam requires exact durable disabled/revoked session; server acceptance does not prove propagation', async t => {
  const w = await hostFixture(t); const calls = [];
  const { HostOAuth } = await import('../src/host-oauth.mjs');
  const oauth = new HostOAuth({ fetchImpl: async (url, options) => {
    calls.push({ url, ...JSON.parse(options.body) }); return { status: 200 };
  } });
  const a = admin(w);
  await assert.rejects(a.revokeSession(encodeBundle(w.secret), syntheticGrant, (await w.disk.read()).version, oauth), /durable_revoke_required/);
  assert.equal(calls.length, 0);
  await a.disable((await w.disk.read()).version, { revoke: true });
  const result = await a.revokeSession(encodeBundle(w.secret), syntheticGrant, (await w.disk.read()).version, oauth);
  assert.deepEqual(result, { kind: 'revokeAccepted', propagation: 'unverified' });
  assert.deepEqual(calls, [{ url: 'https://auth.openai.com/oauth/revoke', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    token_type_hint: 'refresh_token', token: 'synthetic-refresh-0' }]);
  await assert.rejects(w.host().setupRead((await w.disk.read()).version), /reconnect_required/);
});

for (const outcome of ['accepted', 'rejected', 'lost-response']) {
  test(`remote revoke ${outcome}: durable stop and exact history survive fresh readers; no auth/read/consume recovery`, async t => {
    const w = await hostFixture(t); await addHistory(w);
    const before = await w.disk.read();
    await admin(w).disable(before.version, { revoke: true });
    const stopped = await new FileStateStore(w.disk.path).read();
    assert.equal(stopped.disabled, true); assert.equal(stopped.revoked, true);
    assert.equal(stopped.auth.reconnectReason, 'revoked');
    assert.deepEqual(history(stopped), history(before));
    const { HostOAuth } = await import('../src/host-oauth.mjs');
    let calls = 0;
    const oauth = new HostOAuth({ fetchImpl: async () => {
      calls++;
      if (outcome === 'lost-response') throw new Error('synthetic-refresh-secret');
      return { status: outcome === 'accepted' ? 200 : 401 };
    } });
    const revoke = admin(w).revokeSession(encodeBundle(w.secret), syntheticGrant, stopped.version, oauth);
    if (outcome === 'accepted') assert.deepEqual(await revoke, { kind: 'revokeAccepted', propagation: 'unverified' });
    else await assert.rejects(revoke, { message: `oauth_revoke_${outcome === 'rejected' ? 'rejected' : 'unconfirmed'}` });
    assert.equal(calls, 1);
    assert.deepEqual(await new FileStateStore(w.disk.path).read(), stopped);
    w.events = [];
    for (const operation of [
      s => request(s), s => s.setupRead(stopped.version), s => s.setupMetadata(stopped.version),
      s => s.service({ force: true }), s => s.service({ force: true, setup: true, expectedVersion: stopped.version }),
      s => s.recoverLocal({ setup: true }), s => s.reserveConsume(() => { throw new Error('reservation must not run'); }),
    ]) await assert.rejects(operation(w.host()), /reconnect_required/);
    assert.deepEqual(await new FileStateStore(w.disk.path).read(), stopped);
    noNetwork(w); assert.equal(w.refreshes, 0); assert.equal(calls, 1);
  });
}

test('remote revoke rejects stale session/grant/version, lost writer and unconfirmed readback before HTTP', async t => {
  const w = await hostFixture(t); const a = admin(w);
  await a.disable((await w.disk.read()).version, { revoke: true });
  const stopped = await w.disk.read(); let calls = 0;
  const oauth = { revoke: async () => { calls++; } };
  await assert.rejects(a.revokeSession(encodeBundle(makeBundle(hostBytes(1), { protocol: 2 })), syntheticGrant, stopped.version, oauth), /durable_revoke_required/);
  await assert.rejects(a.revokeSession(encodeBundle(w.secret), 'other-grant', stopped.version, oauth), /durable_revoke_required/);
  await assert.rejects(a.revokeSession(encodeBundle(w.secret), syntheticGrant, stopped.version - 1, oauth), /durable_revoke_required/);
  w.writerLost = true;
  await assert.rejects(a.revokeSession(encodeBundle(w.secret), syntheticGrant, stopped.version, oauth), /serialized_writer_required/);
  w.writerLost = false;
  const read = w.store.read; let reads = 0;
  w.store.read = async () => { const state = await read(); if (++reads === 2) state.version--; return state; };
  await assert.rejects(a.revokeSession(encodeBundle(w.secret), syntheticGrant, stopped.version, oauth), /state_readback_failed/);
  assert.equal(calls, 0); assert.deepEqual(await w.disk.read(), stopped);
});
