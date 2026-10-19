import test from 'node:test';
import assert from 'node:assert/strict';
import { usage, issuedResets, consume } from '../src/chatgpt/client.ts';
import { refresh } from '../src/chatgpt/session.ts';
import { TransientFailure } from '../src/chatgpt/http.ts';
import type { TransientReason } from '../src/chatgpt/http.ts';
import { tick } from '../src/worker/tick.ts';
import { fakeWorld, credit } from './support/fake-world.ts';
import type { FakeWorld, WhamFailure } from './support/fake-world.ts';

const RULES = { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: true };

// A reply of a changed shape stops the tick with a TransientFailure instead of reaching the rules.
const failsWith = (reason: TransientReason | `consume_${number}` | 'refresh_invalid_reply') => (error: unknown) => error instanceof TransientFailure && error.reason === reason;

// A world with a reset the rules would apply on this tick, broken by change.
type Change = (world: FakeWorld) => void;
function broken(change: Change) {
  const world = fakeWorld();
  world.chatgpt.credits = [credit('reset-a', world.now + 3600_000)];
  change(world);
  const session = world.login();
  // The tick sees the failure and spends nothing.
  const ticks = async () => {
    const result = await tick({ state: { formatVersion: 1, session }, rules: RULES, now: world.now, fetch: world.fetch });
    assert.equal(result.outcome, 'transient_error');
    assert.deepEqual(world.consumeCalls(), []);
  };
  return { world, session, ticks };
}

for (const [label, fail] of [['null', { status: 200, body: null }], ['an array', { status: 200, body: [] }],
  ['a page that is not JSON', { status: 200, text: '<html>maintenance</html>' }]] satisfies [string, WhamFailure][]) {
  test(`a wham read answered 200 with ${label} is a transient failure`, async () => {
    const { world, session, ticks } = broken(w => { w.chatgpt.fail = fail; });
    await assert.rejects(usage(world.fetch, session), failsWith('wham_200'));
    await assert.rejects(issuedResets(world.fetch, session), failsWith('wham_200'));
    await ticks();
  });
}

for (const [label, change] of [
  ['no rate_limit object', w => { w.chatgpt.fail = { status: 200, body: { rate_limit: null, credits: w.chatgpt.credits } }; }],
  ['a used_percent that is not a number', w => { w.chatgpt.secondary = w.chatgpt.secondary && { ...w.chatgpt.secondary, used_percent: '40' }; }],
  ['a reset_at that is not whole seconds', w => { w.chatgpt.primary = w.chatgpt.primary && { ...w.chatgpt.primary, reset_at: 1.5 }; }],
] satisfies [string, Change][]) {
  test(`usage with ${label} is a transient failure`, async () => {
    const { world, session, ticks } = broken(change);
    await assert.rejects(usage(world.fetch, session), failsWith('wham_invalid_usage'));
    await ticks();
  });
}

for (const [label, change] of [
  ['no credits list', w => { w.chatgpt.fail = { status: 200, body: { credits: {} } }; }],
  ['a reset whose id is not a string', w => { w.chatgpt.credits = [credit(42, w.now + 3600_000)]; }],
  ['a reset with an empty id', w => { w.chatgpt.credits = [credit('', w.now + 3600_000)]; }],
  ['a deadline that is not a date', w => { w.chatgpt.credits = [credit('reset-a', null, { expires_at: 'not a date' })]; }],
] satisfies [string, Change][]) {
  test(`issued resets with ${label} are a transient failure`, async () => {
    const { world, session, ticks } = broken(change);
    await assert.rejects(issuedResets(world.fetch, session), failsWith('wham_invalid_credits'));
    await ticks();
  });
}

for (const [label, change] of [['an unknown code', w => { w.chatgpt.outcome = 'reset_later'; }],
  ['no code', w => { w.chatgpt.consumeFail = { status: 200 }; }]] satisfies [string, Change][]) {
  test(`consume answered with ${label} leaves the result unknown`, async () => {
    const { world, session } = broken(change);
    await assert.rejects(consume(world.fetch, session, { creditId: 'reset-a', redeemRequestId: 'key-1' }), failsWith('consume_200'));
  });
}

test('a refresh reply with a token that is not a string is a transient failure', async () => {
  const world = fakeWorld();
  const session = world.login();
  world.auth.fail = { status: 200, body: { access_token: 42 } };
  await assert.rejects(refresh(world.fetch, session), failsWith('refresh_invalid_reply'));
});
