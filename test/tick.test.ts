import test from 'node:test';
import assert from 'node:assert/strict';
import { tick } from '../src/worker/tick.ts';
import type { TickOptions, Ticked } from '../src/worker/tick.ts';
import type { Migration, State } from '../src/worker/state-file.ts';
import type { Session } from '../src/chatgpt/session.ts';
import { fakeWorld, credit, window, REUSE_GRACE_MS } from './support/fake-world.ts';
import type { AuthFailure, FakeWorld, WhamFailure } from './support/fake-world.ts';

const HOUR = 3600_000, DAY = 24 * HOUR;
const RULES = { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: false };
function setup(options?: Parameters<typeof fakeWorld>[0]) {
  const world = fakeWorld(options);
  const state: State = { formatVersion: 1, session: world.login() };
  const run = (s: State, options: Partial<TickOptions> = {}) => tick({ state: s, rules: RULES, now: world.now, fetch: world.fetch, ...options });
  return { world, state, run };
}

test('tick reads quotas and issued resets with the worker session and stays idle', async () => {
  const { world, state, run } = setup();
  world.chatgpt.primary = window(18000, 100, world.now + 2 * HOUR);
  world.chatgpt.secondary = window(604800, 63.5, world.now + 4 * DAY);
  world.chatgpt.credits = [credit('reset-a', world.now + 5 * DAY), credit('reset-b', null),
    credit('reset-used', world.now + DAY, { status: 'redeemed' }),
    credit('reset-other-plan', world.now + DAY, { is_supported_by_plan: false })];
  const result = await run(state);
  assert.equal(result.outcome, 'idle');
  assert.deepEqual(result.state.observed, {
    at: world.now,
    weeklyQuota: { usedPercent: 63.5, exhausted: false, renewsAt: Math.floor((world.now + 4 * DAY) / 1000) * 1000 },
    fiveHourQuota: { usedPercent: 100, exhausted: true, renewsAt: Math.floor((world.now + 2 * HOUR) / 1000) * 1000 },
    resets: [{ id: 'reset-a', expiresAt: world.now + 5 * DAY }, { id: 'reset-b', expiresAt: null }],
  });
  assert.deepEqual(result.state.session, state.session);
  assert.equal(world.refreshCalls().length, 0);
  assert.deepEqual(world.violations, []);
});

const expiry = (session: Session): number => {
  const { exp }: { exp: number } = JSON.parse(Buffer.from(session.accessToken.split('.')[1] ?? '', 'base64url').toString());
  return exp * 1000;
};
const nearExpiry = (world: FakeWorld, state: State) => world.advance(expiry(state.session) - world.now - 60_000);

test('tick refreshes the worker session just before the access token expires and keeps the new tokens', async () => {
  const { world, state, run } = setup();
  world.advance(expiry(state.session) - world.now - 2 * 60_000);
  const result = await run(state);
  assert.equal(result.outcome, 'idle');
  assert.equal(world.refreshCalls().length, 1);
  assert.notEqual(result.state.session.refreshToken, state.session.refreshToken);
  assert.notEqual(result.state.session.accessToken, state.session.accessToken);
  assert.equal(result.state.session.accountId, state.session.accountId);
  assert.ok(expiry(result.state.session) > world.now + 9 * DAY);
  assert.equal(result.state.observed?.resets.length, 1);
  assert.deepEqual(world.violations, []);
});

test('tick leaves a session that is far from expiry alone', async () => {
  const { world, state, run } = setup();
  world.advance(expiry(state.session) - world.now - HOUR);
  const result = await run(state);
  assert.equal(result.outcome, 'idle');
  assert.equal(world.refreshCalls().length, 0);
  assert.deepEqual(result.state.session, state.session);
});

test('a refresh reply without some tokens keeps their previous values', async () => {
  const { world, state, run } = setup();
  world.auth.omit = ['id_token', 'refresh_token'];
  nearExpiry(world, state);
  const result = await run(state);
  assert.equal(result.outcome, 'idle');
  assert.notEqual(result.state.session.accessToken, state.session.accessToken);
  assert.equal(result.state.session.idToken, state.session.idToken);
  assert.equal(result.state.session.refreshToken, state.session.refreshToken);
});

for (const code of ['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated']) {
  test(`refresh rejected with ${code} means the worker session is lost`, async () => {
    const { world, state, run } = setup();
    world.endSession(code);
    nearExpiry(world, state);
    const result = await run(state);
    assert.equal(result.outcome, 'reauth_required');
    assert.deepEqual(result.state.session, state.session);
  });
}

for (const [label, fail] of [['a bare 401', { status: 401, body: { detail: 'Unauthorized' } }],
  ['400 invalid_grant', { status: 400, body: { error: 'invalid_grant' } }]] satisfies [string, AuthFailure][]) {
  test(`refresh rejected with ${label} means the worker session is lost`, async () => {
    const { world, state, run } = setup();
    world.auth.fail = fail;
    nearExpiry(world, state);
    assert.equal((await run(state)).outcome, 'reauth_required');
  });
}

for (const [label, fail] of [['503', { status: 503, body: { detail: 'down' } }], ['429', { status: 429 }],
  ['an unrelated 400', { status: 400, body: { error: 'invalid_request' } }], ['a network error', { status: 'network' }]] satisfies [string, AuthFailure][]) {
  test(`refresh failing with ${label} is a transient error`, async () => {
    const { world, state, run } = setup();
    world.auth.fail = fail;
    nearExpiry(world, state);
    const result = await run(state);
    assert.equal(result.outcome, 'transient_error');
    assert.deepEqual(result.state.session, state.session);
  });
}

for (const [label, fail] of [['502', { status: 502 }], ['a network error', 'network']] satisfies [string, WhamFailure][]) {
  test(`reads failing with ${label} are a transient error`, async () => {
    const { world, state, run } = setup();
    world.chatgpt.fail = fail;
    const result = await run(state);
    assert.equal(result.outcome, 'transient_error');
    assert.equal(result.state.observed, undefined);
  });
}

test('a transient read failure after a refresh still returns the rotated session', async () => {
  const { world, state, run } = setup();
  world.chatgpt.fail = { status: 500 };
  nearExpiry(world, state);
  const result = await run(state);
  assert.equal(result.outcome, 'transient_error');
  assert.notEqual(result.state.session.refreshToken, state.session.refreshToken);
});

test('a rejected access token means the worker session is lost, without a refresh far from exp', async () => {
  const { world, state, run } = setup();
  world.revokeAccess();
  const result = await run(state);
  assert.equal(result.outcome, 'reauth_required');
  assert.equal(world.refreshCalls().length, 0);
  assert.deepEqual(result.state.session, state.session);
});

test('a refresh hands the rotated state to persist before any read', async () => {
  const { world, state, run } = setup();
  nearExpiry(world, state);
  const handed: { next: Ticked; readsBefore: number }[] = [];
  const result = await run(state, { persist: async next => {
    handed.push({ next, readsBefore: world.requests.filter(r => r.host === 'chatgpt.com').length });
  } });
  assert.equal(result.outcome, 'idle');
  assert.equal(handed.length, 1);
  assert.equal(handed[0]?.readsBefore, 0);
  assert.deepEqual(handed[0]?.next.session, result.state.session);
  assert.notEqual(handed[0]?.next.session.refreshToken, state.session.refreshToken);
});

test('persist is not called when the session is far from expiry', async () => {
  const { state, run } = setup();
  let calls = 0;
  await run(state, { persist: async () => { calls++; } });
  assert.equal(calls, 0);
});

test('a tick from a stale state reuses a rotated refresh token and loses the session once the grace passes', async () => {
  const { world, state, run } = setup();
  nearExpiry(world, state);
  assert.equal((await run(state)).outcome, 'idle');
  // Live check 01: the server accepts a reused refresh token for a few seconds after rotation.
  world.advance(REUSE_GRACE_MS / 2);
  assert.equal((await run(state)).outcome, 'idle');
  world.advance(REUSE_GRACE_MS);
  const stale = await run(state);
  assert.equal(stale.outcome, 'reauth_required');
  assert.equal(world.refreshCalls().length, 3);
});

test('the weekly quota is recognised by its window length, not its position', async () => {
  const { world, state, run } = setup();
  world.chatgpt.primary = window(604800, 100, world.now + DAY);
  world.chatgpt.secondary = null;
  world.chatgpt.credits = [];
  const { state: next } = await run(state);
  assert.deepEqual(next.observed?.weeklyQuota, { usedPercent: 100, exhausted: true, renewsAt: Math.floor((world.now + DAY) / 1000) * 1000 });
  assert.equal(next.observed?.fiveHourQuota, null);
  assert.deepEqual(next.observed?.resets, []);
});

test('a malformed reset list is a transient error, not an empty one', async () => {
  const { world, state, run } = setup();
  world.chatgpt.credits = [credit('reset-a', null, { expires_at: 'not a date' })];
  assert.equal((await run(state)).outcome, 'transient_error');
});

test('tick takes the session of a new login for the same account once and keeps the history', async () => {
  const { world, state, run } = setup();
  const history: State = { ...state, applied: [{ creditId: 'reset-old', expiresAt: world.now - DAY, reason: 'before_expiry', at: world.now - 2 * DAY, recovers: null }] };
  world.endSession('refresh_token_invalidated');
  assert.equal((await run(history)).outcome, 'reauth_required');

  const login = { id: 'login-1', session: world.login() };
  const saved: Ticked[] = [];
  const result = await run(history, { login, persist: async s => { saved.push(s); } });
  assert.equal(result.outcome, 'idle');
  assert.deepEqual(result.state.session, login.session);
  assert.deepEqual(result.state.login, { id: 'login-1', result: 'accepted', at: world.now });
  assert.deepEqual(result.state.applied, history.applied);
  // The new refresh token reaches the repository before anything can rotate it.
  assert.deepEqual(saved[0]?.session, login.session);

  // The secret stays until the CLI deletes it; a later tick never goes back to its tokens.
  world.advance(expiry(login.session) - world.now - 60_000);
  const refreshed = await run(result.state, { login });
  assert.equal(refreshed.outcome, 'idle');
  assert.notEqual(refreshed.state.session.refreshToken, login.session.refreshToken);
  const later = await run(refreshed.state, { login });
  assert.equal(later.state.session.refreshToken, refreshed.state.session.refreshToken);
});

test('tick rejects a login into another ChatGPT account and keeps the old session', async () => {
  const { world, state, run } = setup();
  world.accountId = 'account-other';
  const login = { id: 'login-2', session: world.login() };
  const result = await run(state, { login });
  assert.deepEqual(result.state.session, state.session);
  assert.deepEqual(result.state.login, { id: 'login-2', result: 'rejected', at: world.now });
  // The old session belongs to the old account, which this world no longer serves.
  assert.equal(result.outcome, 'reauth_required');
  assert.equal(world.consumeCalls().length, 0);
});

test('tick brings a state of an older formatVersion to the current one before it acts on it', async () => {
  const { world, state, run } = setup();
  // A format step as a format change adds it: version 1 kept the history as `history`, 2 calls it `applied`.
  const migrations: Migration[] = [({ history, ...old }) => ({ ...old, applied: history })];
  world.chatgpt.credits = [credit('reset-a', world.now + 3 * HOUR), credit('reset-b', world.now + 3 * HOUR)];
  const old = { ...state, history: [{ creditId: 'reset-old', expiresAt: world.now + 3 * HOUR, reason: 'apply_now', at: world.now - HOUR, recovers: null }] };
  const result = await run(old, { migrations });
  assert.equal(result.state.formatVersion, 2);
  // @ts-expect-error: the field of the older format is gone.
  assert.equal(result.state.history, undefined);
  // The migrated history counts: the group of matching deadlines already had its reset.
  assert.equal(result.outcome, 'idle');
  assert.deepEqual(world.consumeCalls(), []);
  assert.deepEqual((await run(result.state, { migrations })).state.applied, old.history, 'a current state passes as it is');
});

test('tick refuses a state newer than its formats', async () => {
  const { state, run } = setup();
  await assert.rejects(run({ ...state, formatVersion: 2 }), { reason: 'state_format_unknown' });
  // @ts-expect-error: a state without a session is refused at run time.
  await assert.rejects(run({ ...state, session: null }), { reason: 'state_without_session' });
});
