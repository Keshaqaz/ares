import test from 'node:test';
import assert from 'node:assert/strict';
import { githubFixture } from '../testing/github-fixture.mjs';
import { GitHubStorage } from '../src/github-storage.mjs';
import { encodeBundle, AuthFailure } from '../src/auth-bundle.mjs';
import { syntheticGrant } from '../testing/auth-fixture.mjs';

const fixture = () => githubFixture();

test('single selected private repository PAT; LibSodium round trip; only encrypted Secret PUT', async () => {
  const w = await fixture();
  await w.storage.preflight();
  await w.storage.publish(w.bundle);
  assert.equal(w.secret, encodeBundle(w.bundle));
  assert.equal(w.requests.filter(r => r.path.includes('AUTO_RESET_AUTH_BUNDLE')).length, 1);
  w.createSecret = true;
  await w.storage.publish(w.bundle); // 201 also has an empty body.
  assert.equal(w.secret, encodeBundle(w.bundle));
});

test('Contents CAS reads authoritative branch before and after write and preserves the document', async () => {
  const w = await fixture();
  const authBefore = structuredClone(w.state.auth);
  await w.storage.update(state => { state.disabled = true; });
  assert.equal(w.state.version, 1);
  assert.deepEqual(w.state.auth, authBefore);
  assert.deepEqual(w.requests.map(({ method, path }) => `${method} ${path}`),
    ['GET /contents/state.json', 'PUT /contents/state.json', 'GET /contents/state.json']);
  assert.ok(w.requests.filter(r => r.method === 'GET').every(r => r.query === '?ref=auto-reset-state'));
});

test('lost state PUT response recovers by exact document read; stale read/conflict never replays mutation', async () => {
  const w = await fixture();
  w.fail = 'lost_state';
  await w.storage.update(s => { s.disabled = true; });
  assert.equal(w.state.version, 1);
  const conflict = await fixture(); conflict.fail = 'conflict';
  let calls = 0;
  await assert.rejects(conflict.storage.update(s => { calls++; s.disabled = true; }), /state_conflict/);
  assert.equal(calls, 1);
  assert.equal(conflict.requests.filter(r => r.method === 'PUT').length, 1);
  const stale = await fixture(); stale.staleRead = true;
  await assert.rejects(stale.storage.update(s => { s.disabled = true; }), /state_write_unconfirmed/);
});

test('serialization, public repo, grant expiry and missing state fail without exposing raw errors', async () => {
  const w = await fixture(); w.serialized = false;
  await assert.rejects(w.storage.preflight(), { message: 'serialized_writer_required', kind: 'serialized_writer_required' });
  assert.equal(w.requests.length, 0);
  w.serialized = true; w.repoPrivate = false;
  await assert.rejects(w.storage.preflight(), /private_repository_required/);
  w.fail = 'grant';
  await assert.rejects(w.storage.preflight(), { message: 'stop_grant', kind: 'stop_grant' });
  w.fail = 'missing';
  await assert.rejects(w.storage.read(), /storage_missing/);
  assert.ok(w.requests.every(r => r.method !== 'PUT'));
});

test('Secret PUT ambiguous response is never confirmed by GET metadata; disable/revoke before deletion', async () => {
  const w = await fixture(); w.fail = 'lost_secret';
  await assert.rejects(w.storage.publish(w.bundle), { message: 'storage_unconfirmed', kind: 'storage_unconfirmed' });
  assert.equal(w.secret, encodeBundle(w.bundle));
  assert.ok(w.requests.every(r => r.method !== 'GET' || !r.path.endsWith('AUTO_RESET_AUTH_BUNDLE')));
  w.fail = null;
  await assert.rejects(w.storage.deleteBundle(), /durable_revoke_required/);
  await w.storage.update(s => { s.disabled = true; s.revoked = true; });
  await w.storage.deleteBundle();
  assert.equal(w.secret, null);
});

test('state schema rejects credential fields before the GitHub write', async () => {
  const w = await fixture();
  await assert.rejects(w.storage.update(s => { s.auth.refresh_token = 'synthetic-refresh'; }), /invalid_state/);
  assert.ok(w.requests.every(r => r.method === 'GET'));
  assert.throws(() => new GitHubStorage({ repository: 'other/repo?injection', token: syntheticGrant }), AuthFailure);
});

test('temporarily old Contents readback confirms the same write without repeating mutation or PUT', async () => {
  const w = await fixture(); w.staleRead = true;
  const original = w.storage.fetch;
  w.storage.fetch = async (url, options) => {
    const response = await original(url, options);
    if (w.changed && options.method === 'GET' && new URL(url).pathname.endsWith('/contents/state.json')) w.staleRead = false;
    return response;
  };
  let mutations = 0;
  await w.storage.update(s => { mutations++; s.disabled = true; });
  assert.equal(mutations, 1);
  assert.equal(w.requests.filter(r => r.method === 'PUT').length, 1);
  assert.equal(w.state.disabled, true);
});
