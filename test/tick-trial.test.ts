import test from 'node:test';
import assert from 'node:assert/strict';
import { tick } from '../src/worker/tick.ts';
import type { TickOptions, Ticked } from '../src/worker/tick.ts';
import type { Rules, State } from '../src/worker/state-file.ts';
import { fakeWorld, credit, window } from './support/fake-world.ts';

const HOUR = 3600_000, DAY = 24 * HOUR;
const DEFAULT_RULES = { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: false };
const WEEKLY_ONLY = { formatVersion: 1, beforeExpiry: false, weeklyAutoApply: true };

function setup({ rules = DEFAULT_RULES }: { rules?: Rules } = {}) {
  const world = fakeWorld();
  world.chatgpt.credits = [];
  const run = (state: State, extra: Partial<TickOptions> = {}) =>
    tick({ state, rules, now: world.now, fetch: world.fetch, beforeExpiryMs: 8 * HOUR, ...extra });
  const state: State = { formatVersion: 1, session: world.login() };
  return { world, state, run };
}

test('a trial run names the reset the before-expiry rule would apply and sends no consume', async () => {
  const { world, state, run } = setup();
  world.chatgpt.credits = [credit('reset-a', world.now + HOUR), credit('reset-b', world.now + 3 * DAY)];
  const persisted: Ticked[] = [];
  const result = await run(state, { trial: true, persist: async next => { persisted.push(next); } });
  assert.equal(result.outcome, 'would_apply');
  assert.deepEqual(result.wouldApply, { creditId: 'reset-a', reason: 'before_expiry' });
  assert.equal(world.consumeCalls().length, 0);
  assert.equal(result.state.pending, null);
  assert.deepEqual(persisted, [], 'no pending to persist');
  assert.deepEqual(result.state.observed?.resets.map(r => r.id), ['reset-a', 'reset-b']);
  // The same state on a regular tick applies it.
  assert.equal((await run(result.state)).outcome, 'applied');
  assert.deepEqual(world.spent(), ['reset-a']);
});

test('a trial run names the reset the weekly rule would apply', async () => {
  const { world, state, run } = setup({ rules: WEEKLY_ONLY });
  world.chatgpt.credits = [credit('reset-late', world.now + 6 * DAY), credit('reset-near', world.now + 4 * DAY)];
  world.chatgpt.secondary = window(604800, 100, world.now + 3 * DAY);
  const result = await run(state, { trial: true });
  assert.equal(result.outcome, 'would_apply');
  assert.deepEqual(result.wouldApply, { creditId: 'reset-near', reason: 'weekly' });
  assert.equal(world.consumeCalls().length, 0);
});

test('a trial run with nothing due is idle', async () => {
  const { world, state, run } = setup();
  world.chatgpt.credits = [credit('reset-a', world.now + 3 * DAY)];
  const result = await run(state, { trial: true });
  assert.equal(result.outcome, 'idle');
  assert.equal(result.wouldApply, undefined);
  assert.equal(world.consumeCalls().length, 0);
});

test('a trial run does not repeat the consume of a pending reset that is still listed', async () => {
  const { world, state, run } = setup();
  world.chatgpt.credits = [credit('reset-a', world.now + HOUR)];
  world.chatgpt.lose = 'before';
  const lost = await run(state);
  assert.equal(lost.outcome, 'pending');
  world.chatgpt.lose = null;
  world.advance(HOUR / 4);
  const result = await run(lost.state, { trial: true });
  assert.equal(result.outcome, 'would_apply');
  assert.deepEqual(result.wouldApply, { creditId: 'reset-a', reason: 'before_expiry' });
  assert.equal(world.consumeCalls().length, 1, 'only the lost one');
  assert.deepEqual(result.state.pending, lost.state.pending, 'the same redeem_request_id waits for a regular tick');
  assert.equal((await run(result.state)).outcome, 'applied');
  assert.deepEqual(world.spent(), ['reset-a']);
});

test('a trial run settles a pending reset gone from the list as applied and says what the rules would do next', async () => {
  const { world, state, run } = setup();
  world.chatgpt.credits = [credit('reset-a', world.now + HOUR), credit('reset-b', world.now + 2 * HOUR)];
  world.chatgpt.lose = 'after';
  const lost = await run(state);
  assert.equal(lost.outcome, 'pending');
  world.chatgpt.lose = null;
  const result = await run(lost.state, { trial: true });
  assert.equal(result.state.pending, null);
  assert.deepEqual(result.state.applied.map(a => a.creditId), ['reset-a']);
  assert.equal(result.outcome, 'would_apply');
  assert.deepEqual(result.wouldApply, { creditId: 'reset-b', reason: 'before_expiry' });
  assert.equal(world.consumeCalls().length, 1);
});

test('a trial run for a reset named by apply-now applies nothing and records no attempt', async () => {
  const { world, state, run } = setup({ rules: { formatVersion: 1, beforeExpiry: false, weeklyAutoApply: false } });
  world.chatgpt.credits = [credit('reset-a', world.now + 3 * DAY)];
  const result = await run(state, { trial: true, applyNow: 'reset-a' });
  assert.equal(result.outcome, 'would_apply');
  assert.deepEqual(result.wouldApply, { creditId: 'reset-a', reason: 'apply_now' });
  assert.equal(world.consumeCalls().length, 0);
  const gone = await run(state, { trial: true, applyNow: 'reset-gone' });
  assert.equal(gone.outcome, 'idle');
  assert.equal(gone.state.lastAttempt, undefined);
});

test('a trial run still refreshes a session about to expire', async () => {
  const { world, state, run } = setup();
  const { exp }: { exp: number } = JSON.parse(Buffer.from(state.session.accessToken.split('.')[1] ?? '', 'base64url').toString());
  world.advance(exp * 1000 - world.now - 60_000);
  const persisted: Ticked[] = [];
  const result = await run(state, { trial: true, persist: async next => { persisted.push(next); } });
  assert.equal(result.outcome, 'idle');
  assert.equal(world.refreshCalls().length, 1);
  assert.notEqual(result.state.session.refreshToken, state.session.refreshToken);
  assert.deepEqual(persisted.map(s => s.session), [result.state.session]);
});
