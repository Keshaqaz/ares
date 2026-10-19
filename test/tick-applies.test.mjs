import test from 'node:test';
import assert from 'node:assert/strict';
import { tick } from '../src/worker/tick.ts';
import { fakeWorld, credit, window } from './support/fake-world.mjs';

const MINUTE = 60_000, HOUR = 3600_000, DAY = 24 * HOUR;
const DEFAULT_RULES = { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: false };
const WEEKLY_ONLY = { formatVersion: 1, beforeExpiry: false, weeklyAutoApply: true };
const RULES_OFF = { formatVersion: 1, beforeExpiry: false, weeklyAutoApply: false };
const BOTH_RULES = { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: true };
const START = Date.parse('2026-10-20T12:00:00Z'), DEADLINE_MINUTE = Date.parse('2026-10-20T15:00:00Z');

const dueReset = world => { world.chatgpt.credits = [credit('reset-a', world.now + HOUR)]; };
function setup({ rules = DEFAULT_RULES, ...options } = {}) {
  const world = fakeWorld(options);
  world.chatgpt.credits = [];
  // run(state, { rules }) overrides the rules for one tick.
  const run = (state, extra) => tick({ state, rules, now: world.now, fetch: world.fetch, ...extra });
  return { world, state: { formatVersion: 1, session: world.login() }, run };
}

test('the before-expiry rule waits until the last 8 hours of the activation deadline', async () => {
  const { world, state, run } = setup();
  world.chatgpt.credits = [credit('reset-a', world.now + 8 * HOUR + MINUTE)];
  const early = await run(state);
  assert.equal(early.outcome, 'idle');
  assert.equal(world.consumeCalls().length, 0);
  world.advance(MINUTE);
  const due = await run(early.state);
  assert.equal(due.outcome, 'applied');
  assert.deepEqual(world.spent(), ['reset-a']);
  assert.equal(due.state.pending, null);
  assert.deepEqual(due.state.applied, [{ creditId: 'reset-a', expiresAt: START + 8 * HOUR + MINUTE,
    reason: 'before_expiry', at: world.now, recovers: null }]);
  assert.deepEqual(world.violations, []);
});

test('exhausting only the five-hour quota applies nothing', async () => {
  const { world, state, run } = setup({ rules: WEEKLY_ONLY });
  world.chatgpt.credits = [credit('reset-a', world.now + 5 * DAY)];
  world.chatgpt.primary = window(18000, 100, world.now + 2 * HOUR);
  world.chatgpt.secondary = window(604800, 99.9, world.now + 3 * DAY);
  const result = await run(state);
  assert.equal(result.outcome, 'idle');
  assert.equal(world.consumeCalls().length, 0);
});

test('the first tick that sees the weekly quota exhausted applies the reset with the nearest deadline', async () => {
  const { world, state, run } = setup({ rules: WEEKLY_ONLY });
  world.chatgpt.credits = [credit('reset-late', world.now + 6 * DAY), credit('reset-none', null),
    credit('reset-near', world.now + 4 * DAY)];
  world.chatgpt.secondary = window(604800, 100, world.now + 3 * DAY);
  const result = await run(state);
  assert.equal(result.outcome, 'applied');
  assert.deepEqual(world.spent(), ['reset-near']);
  assert.deepEqual(result.state.applied.map(a => [a.creditId, a.reason, a.recovers]),
    [['reset-near', 'weekly', START + 3 * DAY]]);
  world.advance(HOUR);
  assert.equal((await run(result.state)).outcome, 'idle');
  assert.deepEqual(world.spent(), ['reset-near']);
});

test('a weekly read still showing the same exhaustion after an application spends no second reset', async () => {
  const { world, state, run } = setup({ rules: WEEKLY_ONLY });
  world.chatgpt.credits = [credit('reset-a', world.now + 4 * DAY), credit('reset-b', world.now + 5 * DAY)];
  world.chatgpt.secondary = window(604800, 100, world.now + 3 * DAY);
  world.chatgpt.renewsWindows = false;
  const first = await run(state);
  assert.equal(first.outcome, 'applied');
  world.advance(HOUR);
  assert.equal((await run(first.state)).outcome, 'idle');
  assert.deepEqual(world.spent(), ['reset-a']);
});

test('the weekly rule applies a reset without a deadline when it is the only one', async () => {
  const { world, state, run } = setup({ rules: WEEKLY_ONLY });
  world.chatgpt.credits = [credit('reset-none', null)];
  world.chatgpt.primary = window(604800, 100, world.now + DAY);
  assert.equal((await run(state)).outcome, 'applied');
  assert.deepEqual(world.spent(), ['reset-none']);
});

test('with both rules off nothing is applied, even near the deadline and with the weekly quota exhausted', async () => {
  const { world, state, run } = setup({ rules: RULES_OFF });
  world.chatgpt.credits = [credit('reset-a', world.now + HOUR)];
  world.chatgpt.secondary = window(604800, 100, world.now + DAY);
  assert.equal((await run(state)).outcome, 'idle');
  assert.equal(world.consumeCalls().length, 0);
});

test('only one reset of a group of matching deadlines is applied; another minute is a separate group', async () => {
  const { world, state, run } = setup();
  world.chatgpt.credits = [credit('reset-b', DEADLINE_MINUTE + 40_000), credit('reset-a', DEADLINE_MINUTE + 10_000),
    credit('reset-next-minute', DEADLINE_MINUTE + MINUTE)];
  let current = state;
  for (let hour = 0; hour < 3; hour++) {
    current = (await run(current)).state;
    world.advance(HOUR / 2);
  }
  assert.deepEqual(world.spent(), ['reset-a', 'reset-next-minute']);
  assert.deepEqual(world.violations, []);
});

test('the weekly rule skips a group that already had a reset applied', async () => {
  const { world, state, run } = setup({ rules: BOTH_RULES });
  world.chatgpt.credits = [credit('reset-a', DEADLINE_MINUTE), credit('reset-b', DEADLINE_MINUTE + 30_000), credit('reset-c', world.now + 2 * DAY)];
  const first = await run(state);
  assert.deepEqual(world.spent(), ['reset-a']);
  world.chatgpt.secondary = window(604800, 100, world.now + 3 * DAY);
  world.advance(HOUR);
  const second = await run(first.state);
  assert.equal(second.outcome, 'applied');
  assert.deepEqual(world.spent(), ['reset-a', 'reset-c']);
});

test('the chosen reset and its redeem_request_id are persisted before the consume POST', async () => {
  const { world, state, run } = setup();
  dueReset(world);
  const persisted = [];
  const result = await run(state, { persist: async next => {
    persisted.push({ pending: next.pending, consumesBefore: world.consumeCalls().length });
  } });
  assert.equal(result.outcome, 'applied');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].consumesBefore, 0);
  assert.equal(persisted[0].pending.creditId, 'reset-a');
  assert.equal(world.consumeCalls()[0].key, persisted[0].pending.redeemRequestId);
});

test('a failed persist sends no consume', async () => {
  const { world, state, run } = setup();
  dueReset(world);
  await assert.rejects(run(state, { persist: async () => { throw new Error('commit failed'); } }), /commit failed/);
  assert.equal(world.consumeCalls().length, 0);
});

test('a lost reply after the server applied the reset is reconciled as applied on the next tick', async () => {
  const { world, state, run } = setup();
  world.chatgpt.credits = [credit('reset-a', world.now + HOUR), credit('reset-b', world.now + 2 * HOUR)];
  world.chatgpt.lose = 'after';
  const lost = await run(state);
  assert.equal(lost.outcome, 'pending');
  assert.equal(lost.state.pending.creditId, 'reset-a');
  world.chatgpt.lose = null;
  world.advance(HOUR / 2);
  const next = await run(lost.state);
  assert.equal(next.outcome, 'applied');
  assert.equal(next.state.pending, null);
  assert.equal(world.consumeCalls().length, 1);
  assert.deepEqual(next.state.applied.map(a => [a.creditId, a.at]), [['reset-a', world.now]]);
  assert.deepEqual(world.spent(), ['reset-a']);
});

test('a lost reply with the reset still listed is retried with the same redeem_request_id', async () => {
  const { world, state, run } = setup();
  dueReset(world);
  world.chatgpt.lose = 'before';
  const lost = await run(state);
  assert.equal(lost.outcome, 'pending');
  world.chatgpt.lose = null;
  world.advance(HOUR / 4);
  const retried = await run(lost.state);
  assert.equal(retried.outcome, 'applied');
  const [first, second] = world.consumeCalls();
  assert.equal(second.key, first.key);
  assert.equal(second.creditId, 'reset-a');
  assert.deepEqual(world.spent(), ['reset-a']);
});

for (const [label, change] of [['a 5xx', w => { w.chatgpt.consumeFail = { status: 502 }; }],
  ['already_redeemed', w => { w.chatgpt.redemptions.push({ creditId: 'reset-a', key: 'other', outcome: 'already_redeemed' }); w.chatgpt.outcome = 'already_redeemed'; }]]) {
  test(`consume answered with ${label} leaves the result unknown and keeps the key`, async () => {
    const { world, state, run } = setup();
    dueReset(world);
    change(world);
    const result = await run(state);
    assert.equal(result.outcome, 'pending');
    assert.equal(result.state.pending.redeemRequestId, world.consumeCalls()[0].key);
  });
}

test('a rejected session on consume keeps the pending attempt for after the next login', async () => {
  const { world, state, run } = setup();
  dueReset(world);
  world.chatgpt.consumeFail = { status: 401 };
  const result = await run(state);
  assert.equal(result.outcome, 'reauth_required');
  assert.equal(result.state.pending.creditId, 'reset-a');
});

test('a pending attempt is retried even after the rules are turned off', async () => {
  const { world, state, run } = setup();
  dueReset(world);
  world.chatgpt.lose = 'before';
  const lost = await run(state);
  world.chatgpt.lose = null;
  const retried = await run(lost.state, { rules: RULES_OFF });
  assert.equal(retried.outcome, 'applied');
  assert.deepEqual(world.spent(), ['reset-a']);
});

for (const outcome of ['nothing_to_reset', 'no_credit']) {
  test(`consume answered with ${outcome} keeps nothing pending and tries again on a later tick`, async () => {
    const { world, state, run } = setup();
    dueReset(world);
    world.chatgpt.outcome = outcome;
    const first = await run(state);
    assert.equal(first.outcome, 'idle');
    assert.equal(first.state.pending, null);
    assert.deepEqual(first.state.lastAttempt, { creditId: 'reset-a', reason: 'before_expiry', at: world.now, result: outcome });
    world.chatgpt.outcome = 'reset';
    world.advance(HOUR / 4);
    assert.equal((await run(first.state)).outcome, 'applied');
    const [a, b] = world.consumeCalls();
    assert.notEqual(a.key, b.key);
  });
}

test('apply-now applies the chosen reset regardless of the rules and quotas', async () => {
  const { world, state, run } = setup({ rules: RULES_OFF });
  world.chatgpt.credits = [credit('reset-near', world.now + 2 * DAY), credit('reset-far', world.now + 6 * DAY)];
  const result = await run(state, { applyNow: 'reset-far' });
  assert.equal(result.outcome, 'applied');
  assert.deepEqual(world.spent(), ['reset-far']);
  assert.deepEqual(result.state.lastAttempt, { creditId: 'reset-far', reason: 'apply_now', at: world.now, result: 'reset' });
});

test('apply-now may pick a reset whose deadline group already had one applied', async () => {
  const { world, state, run } = setup();
  world.chatgpt.credits = [credit('reset-a', DEADLINE_MINUTE), credit('reset-b', DEADLINE_MINUTE + 1000)];
  const first = await run(state);
  const second = await run(first.state, { applyNow: 'reset-b' });
  assert.equal(second.outcome, 'applied');
  assert.deepEqual(world.spent(), ['reset-a', 'reset-b']);
});

test('apply-now for a reset that is not listed sends nothing and says so', async () => {
  const { world, state, run } = setup({ rules: RULES_OFF });
  world.chatgpt.credits = [credit('reset-a', world.now + DAY)];
  const result = await run(state, { applyNow: 'reset-gone' });
  assert.equal(result.outcome, 'idle');
  assert.equal(world.consumeCalls().length, 0);
  assert.deepEqual(result.state.lastAttempt, { creditId: 'reset-gone', reason: 'apply_now', at: world.now, result: 'missing' });
});

test('apply-now waits for an unknown result to settle instead of spending another reset', async () => {
  const { world, state, run } = setup();
  world.chatgpt.credits = [credit('reset-a', world.now + HOUR), credit('reset-b', world.now + DAY)];
  world.chatgpt.lose = 'after';
  const lost = await run(state);
  world.chatgpt.lose = null;
  const result = await run(lost.state, { applyNow: 'reset-b' });
  assert.equal(result.outcome, 'applied');
  assert.deepEqual(world.spent(), ['reset-a']);
  assert.equal(world.consumeCalls().length, 1);
});

test('a pending reset that left the list past its deadline is not counted as applied', async () => {
  const { world, state, run } = setup();
  dueReset(world);
  world.chatgpt.lose = 'before';
  const lost = await run(state);
  world.chatgpt.lose = null;
  world.chatgpt.credits = [credit('reset-b', DEADLINE_MINUTE + 2 * HOUR)];
  world.advance(2 * HOUR);
  const next = await run(lost.state);
  assert.equal(next.outcome, 'idle');
  assert.equal(next.state.pending, null);
  assert.deepEqual(next.state.applied, []);
  assert.deepEqual(next.state.lastAttempt, { creditId: 'reset-a', reason: 'before_expiry', at: world.now, result: 'unknown' });
  world.advance(HOUR);
  assert.equal((await run(next.state)).outcome, 'applied');
  assert.deepEqual(world.spent(), ['reset-b']);
});

test('apply-now for a reset that is not listed still lets the rules act on the tick', async () => {
  const { world, state, run } = setup();
  dueReset(world);
  const result = await run(state, { applyNow: 'reset-gone' });
  assert.equal(result.outcome, 'applied');
  assert.deepEqual(world.spent(), ['reset-a']);
  assert.equal(result.state.lastAttempt.creditId, 'reset-a');
});

test('a weekly renewsAt that drifts by seconds between reads is still the same exhaustion', async () => {
  const { world, state, run } = setup({ rules: WEEKLY_ONLY });
  world.chatgpt.credits = [credit('reset-a', world.now + 4 * DAY), credit('reset-b', world.now + 5 * DAY)];
  world.chatgpt.secondary = window(604800, 100, world.now + 3 * DAY);
  world.chatgpt.renewsWindows = false;
  const first = await run(state);
  world.chatgpt.secondary = window(604800, 100, world.now + 3 * DAY + 2000);
  world.advance(HOUR);
  assert.equal((await run(first.state)).outcome, 'idle');
  assert.deepEqual(world.spent(), ['reset-a']);
});
