import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { authFixture, authBytes, syntheticGrant } from './support/auth-fixture.mjs';
import { AuthFailure, makeBundle, encodeBundle, decodeBundle, tuple, sameTuple } from '../src/session/auth-bundle.mjs';
import { AuthAdmin } from '../src/session/auth-admin.mjs';
import { ManagedAuthRuntime } from '../src/session/managed-auth-runtime.mjs';
import { validateState } from '../src/core/state-store.mjs';

const request = session => session.request('account/read', { refreshToken: true });
const noAuth = events => assert.ok(events.every(e => !e.startsWith('account.') && !e.startsWith('auth.')), events.join(', '));

test('intent → one RPC → barrier → target → Secret → finalize; latest bundle used for next RPC', async t => {
  const w = await authFixture(t);
  const session = w.session();
  await request(session);
  const operations = w.events.filter(e => !['state.read_latest', 'grant.preflight', 'auth.closed'].includes(e));
  assert.deepEqual(operations, ['state.intent_durable', 'auth.process_start', 'account.rpc',
    'auth.rotation_completed_locally', 'auth.barrier', 'state.target_durable', 'secret.put',
    'secret.put_confirmed', 'state.ready_durable']);
  assert.equal((await w.disk.read()).auth.committed.generation, 2);
  await assert.rejects(lstat(w.home), { code: 'ENOENT' });
  await request(session);
  assert.equal((await w.disk.read()).auth.committed.generation, 3);
  const raw = await readFile(w.disk.path, 'utf8');
  assert.ok(!/synthetic-refresh|access_token|id_token|authBase64|synthetic@example|synthetic-PAT/.test(raw));
});

// Original 07's six cuts, now executed against the real implementation/store adapters.
for (const [name, event, oldResult, freshResult] of [
  ['before intent', 'grant.preflight', 'admitted', 'admitted'],
  ['after intent', 'state.intent_durable', 'reconnect_required', 'reconnect_required'],
  ['after rotation', 'auth.rotation_completed_locally', 'reconnect_required', 'reconnect_required'],
  ['after target', 'state.target_durable', 'stale_snapshot', 'stale_snapshot'],
  ['after PUT', 'secret.put_confirmed', 'stale_snapshot', 'admitted'],
  ['after finalize', 'state.ready_durable', 'stale_snapshot', 'admitted'],
]) {
  test(`07 crash cut: ${name}, exact target recovery or reconnect`, async t => {
    const w = await authFixture(t);
    w.hook = async e => { if (e === event) throw new AuthFailure('simulated_crash'); };
    const session = w.session();
    await assert.rejects(request(session), /simulated_crash/);
    w.hook = async () => {};
    const offset = w.events.length;
    const old = w.session(w.initial);
    if (oldResult === 'admitted') await old.admit();
    else await assert.rejects(old.admit(), new RegExp(oldResult));
    noAuth(w.events.slice(offset));
    const fresh = w.session();
    if (freshResult === 'admitted') await fresh.admit();
    else await assert.rejects(fresh.admit(), new RegExp(freshResult));
    noAuth(w.events.slice(offset));
    // Even if finalize completed, a failed caller cannot run another RPC in this job.
    await assert.rejects(request(session), /job_stopped/);
  });
}

for (const accepted of [false, true]) {
  test(`07 ambiguous PUT accepted=${accepted}: snapshot proves target or stop`, async t => {
    const w = await authFixture(t);
    w.putAccepted = accepted; w.putLost = true;
    await assert.rejects(request(w.session()), /storage_unconfirmed/);
    const offset = w.events.length;
    await assert.rejects(w.session(w.initial).admit(), /stale_snapshot/);
    if (accepted) await w.session().admit();
    else await assert.rejects(w.session().admit(), /stale_snapshot/);
    noAuth(w.events.slice(offset));
    assert.equal((await w.disk.read()).auth.phase, accepted ? 'ready' : 'publishing');
  });
}

for (const name of ['grant_before', 'grant_after_rotation', 'target_write_failure', 'finalize_write_failure',
  'auth_revoked', 'disabled', 'snapshot_identity_mismatch']) {
  test(`07 failure: ${name} stops subsequent RPC and preserves journal`, async t => {
    const w = await authFixture(t);
    if (name === 'grant_before') w.grantValid = false;
    if (name === 'auth_revoked') w.authValid = false;
    if (name === 'disabled') await w.disk.update(s => { s.disabled = true; });
    if (name === 'grant_after_rotation') w.hook = async event => {
      if (event === 'auth.rotation_completed_locally') w.grantValid = false;
    };
    if (name === 'target_write_failure') w.hook = async event => {
      if (event === 'auth.barrier') w.stateWritable = false;
    };
    if (name === 'finalize_write_failure') w.hook = async event => {
      if (event === 'secret.put_confirmed') w.stateWritable = false;
    };
    const session = w.session(name === 'snapshot_identity_mismatch' ? makeBundle(authBytes()) : w.initial);
    await assert.rejects(request(session));
    const offset = w.events.length;
    await assert.rejects(session.request('account/rateLimitResetCredit/consume', { creditId: 'selected', idempotencyKey: 'key' }), /job_stopped/);
    noAuth(w.events.slice(offset));
    if (['grant_before', 'disabled', 'snapshot_identity_mismatch'].includes(name)) noAuth(w.events);
    if (name === 'finalize_write_failure') {
      await assert.rejects(w.session().admit(), /state_write_failed/);
      w.stateWritable = true;
      await w.session().admit();
      assert.equal((await w.disk.read()).auth.phase, 'ready');
    }
  });
}

test('unsupported stock runtime refuses activation BEFORE intent and process creation', async t => {
  const w = await authFixture(t);
  await assert.rejects(request(w.session(w.initial, new ManagedAuthRuntime())), /runtime_auth_barrier_unavailable/);
  noAuth(w.events);
  assert.equal((await w.disk.read()).version, 0);
});

for (const field of ['quiescent', 'refreshSettled', 'saveSucceeded', 'forcedRefreshSucceeded']) {
  test(`no publication when lifecycle barrier lacks ${field}`, async t => {
    const w = await authFixture(t); w.barrier[field] = false;
    await assert.rejects(request(w.session()), /runtime_barrier_failed/);
    assert.equal((await w.disk.read()).auth.phase, 'inflight');
    assert.ok(!w.events.includes('secret.put'));
    await assert.rejects(w.session().admit(), /reconnect_required/);
  });
}

test('unchanged file allowed only for a settled non-forced interval; forced unchanged is failure', async t => {
  const w = await authFixture(t); w.rotate = false;
  await w.session().request('account/rateLimits/read', {});
  assert.equal((await w.disk.read()).auth.committed.generation, 1);
  assert.ok(!w.events.includes('secret.put'));
  await assert.rejects(request(w.session()), /runtime_barrier_failed/);
});

test('bundle verifies exact bytes, identity, mode, schema and size; errors contain no plaintext', () => {
  const original = authBytes();
  const bundle = makeBundle(original);
  assert.ok(sameTuple(tuple(bundle), tuple(decodeBundle(encodeBundle(bundle)))));
  const auth = JSON.parse(original);
  for (const bad of [{ ...bundle, digest: 'f'.repeat(64) }, { ...bundle, schema: 2 },
    { ...bundle, authBase64: 'not base64' }, { ...bundle, token: 'leak' }]) {
    assert.throws(() => decodeBundle(JSON.stringify(bad)), /invalid_auth_bundle/);
  }
  auth.tokens.account_id = 'other';
  assert.throws(() => makeBundle(Buffer.from(JSON.stringify(auth))), /invalid_auth_bundle/);
  assert.throws(() => decodeBundle('x'.repeat(48 * 1024 + 1)), /invalid_auth_bundle/);
  auth.auth_mode = 'chatgptAuthTokens';
  assert.throws(() => makeBundle(Buffer.from(JSON.stringify(auth))), /invalid_auth_bundle/);
});

test('state rejects credentials and incompatible auth protocol; old cycle state still migrates', async t => {
  const w = await authFixture(t);
  const state = await w.disk.read();
  state.auth.tokens = { refresh_token: 'synthetic' };
  assert.throws(() => validateState(state), /invalid_state/);
  delete state.auth.tokens;
  state.auth.protocol = 3;
  assert.throws(() => validateState(state), /invalid_state/);
});

test('seed/reconnect and grant rotation stay disabled, retain cycle history, reject old jobs', async t => {
  const w = await authFixture(t);
  const admin = new AuthAdmin({ store: w.store, secrets: w.secrets, owner: 'setup-015' });
  await assert.rejects(admin.seed(authBytes(), syntheticGrant, 0), /durable_disable_required/);
  await admin.disable(0);
  const before = await w.disk.read();
  const newBundle = await admin.seed(authBytes(1), syntheticGrant, before.version);
  const after = await w.disk.read();
  assert.equal(after.disabled, true);
  assert.notEqual(newBundle.sessionId, w.initial.sessionId);
  for (const field of ['cycles', 'groups', 'requests', 'commands']) assert.deepEqual(after[field], before[field]);
  await w.disk.update(s => { s.disabled = false; });
  await assert.rejects(w.session(w.initial).admit(), /stale_snapshot/);
  await w.session(newBundle).admit();
  await admin.disable((await w.disk.read()).version);
  await admin.rotateGrant('synthetic-new-PAT', (await w.disk.read()).version);
  await w.disk.update(s => { s.disabled = false; });
  await assert.rejects(w.session(newBundle).admit(), /stale_grant/);
  await w.session(newBundle, w.runtime, 'synthetic-new-PAT').admit();
});

test('interrupted seed recovers exact target without enabling; durable revoke rejects queued bundle', async t => {
  const w = await authFixture(t);
  const admin = new AuthAdmin({ store: w.store, secrets: w.secrets, owner: 'setup-015' });
  await admin.disable(0);
  w.putLost = true;
  await assert.rejects(admin.seed(authBytes(1), syntheticGrant, 1), /storage_unconfirmed/);
  let state = await w.disk.read();
  assert.equal(state.auth.phase, 'publishing');
  await assert.rejects(admin.adopt(w.initial, syntheticGrant, state.version), /seed_recovery_unconfirmed/);
  await admin.adopt(w.secret, syntheticGrant, state.version);
  state = await w.disk.read();
  assert.equal(state.disabled, true);
  await admin.disable(state.version, { revoke: true });
  await assert.rejects(w.session().admit(), /disabled/);
});

test('lost bundle/state and intent write failure stop before auth; concurrent intervals cannot overlap', async t => {
  const w = await authFixture(t);
  assert.throws(() => w.session({}), /invalid_auth_bundle/);
  w.stateWritable = false;
  await assert.rejects(request(w.session()), /state_write_failed/);
  noAuth(w.events);
  w.stateWritable = true;
  let release;
  w.hook = async event => { if (event === 'auth.process_start') await new Promise(resolve => { release = resolve; }); };
  const session = w.session();
  const first = request(session);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(request(session), /auth_busy/);
  release(); await first;
  await rm(w.disk.path);
  await assert.rejects(request(w.session()), /auth_failed/);
});

for (const cut of ['inflight', 'rotation', 'publishing', 'secret', 'ready']) {
  test(`process killed at auth ${cut}: recovery uses disk journal and exact snapshot`, async t => {
    const w = await authFixture(t);
    await writeFile(join(w.root, 'snapshot.json'), encodeBundle(w.initial), { mode: 0o600 });
    const child = fork(new URL('./support/auth-crash-fixture.mjs', import.meta.url), [w.root, cut], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
      env: { PATH: process.env.PATH },
    });
    let home;
    t.after(async () => { child.kill('SIGKILL'); if (home) await rm(home, { recursive: true, force: true }); });
    const message = once(child, 'message');
    const exited = once(child, 'exit');
    const guard = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const winner = await Promise.race([message, exited.then(() => { throw new Error('child_exited_before_boundary'); })]);
      home = winner[0].home;
      child.kill('SIGKILL');
      await exited;
    } finally { clearTimeout(guard); }
    const state = await w.disk.read(); // Boundary persisted and lock released before SIGKILL.
    if (['inflight', 'rotation'].includes(cut)) {
      assert.equal(state.auth.phase, 'inflight');
      await assert.rejects(w.session().admit(), /reconnect_required/);
    } else if (cut === 'publishing') {
      assert.equal(state.auth.phase, 'publishing');
      await assert.rejects(w.session().admit(), /stale_snapshot/);
    } else {
      w.secret = decodeBundle(await readFile(join(w.root, 'snapshot.json'), 'utf8'));
      await assert.rejects(w.session(w.initial).admit(), /stale_snapshot/);
      await w.session().admit();
      assert.equal((await w.disk.read()).auth.committed.generation, 2);
    }
    noAuth(w.events);
  });
}

test('final dispatch is deferred until startup; runtime barrier requires a closed process', async t => {
  const w = await authFixture(t);
  const session = w.session();
  await assert.rejects(session.request('account/read', {}, { dispatch: () => { throw new AuthFailure('deadline_reached'); } }), /deadline_reached/);
  assert.ok(w.events.includes('auth.process_start'));
  assert.ok(!w.events.includes('account.rpc'));
  assert.equal((await w.disk.read()).auth.phase, 'inflight');
});
