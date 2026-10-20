import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceLogin, LoginFailed } from '../src/chatgpt/session.ts';
import { tick } from '../src/worker/tick.ts';
import type { DeviceCode } from '../src/chatgpt/session.ts';
import type { Fetch } from '../src/chatgpt/http.ts';
import { fakeWorld } from './support/fake-world.ts';
import type { FakeWorld } from './support/fake-world.ts';

// The user enters the code after a few polls; sleeping moves the fake world's clock.
function login(world: FakeWorld, { approveAfterPolls = 3 } = {}) {
  const shown: DeviceCode[] = [];
  let slept = 0;
  const session = deviceLogin({ fetch: world.fetch, now: () => world.now,
    onCode: code => { shown.push(code); },
    sleep: async ms => {
      world.advance(ms); slept++;
      if (slept === approveAfterPolls) world.approve(shown[0]?.userCode ?? '');
    } });
  return { session, shown };
}

test('device login shows a code, waits for the user and opens a worker session', async () => {
  const world = fakeWorld();
  const { session, shown } = login(world);
  const result = await session;
  assert.deepEqual(shown, [{ userCode: 'FAKE-1000', verificationUrl: 'https://auth.openai.com/codex/device' }]);
  assert.equal(result.accountId, 'account-fake');
  assert.deepEqual(Object.keys(result).sort(), ['accessToken', 'accountId', 'idToken', 'refreshToken']);
  const polls = world.requests.filter(r => r.path === '/api/accounts/deviceauth/token');
  assert.equal(polls.length, 3);
  // @ts-expect-error: no rules at all, so the tick only reads.
  const { outcome } = await tick({ state: { formatVersion: 1, session: result }, rules: {}, now: world.now, fetch: world.fetch, beforeExpiryMs: 8 * 3600_000 });
  assert.equal(outcome, 'idle');
  assert.deepEqual(world.violations, []);
});

test('device login gives up after 15 minutes without the code', async () => {
  const world = fakeWorld();
  const start = world.now;
  const { session } = login(world, { approveAfterPolls: Infinity });
  await assert.rejects(session, error => error instanceof LoginFailed && error.reason === 'timeout');
  assert.ok(world.now - start >= 15 * 60_000 && world.now - start < 16 * 60_000);
});

test('device login fails when the code request is refused', async () => {
  const world = fakeWorld();
  const fetch: Fetch = (url, init) => String(url).endsWith('/usercode') ?
    Promise.resolve(new Response('{}', { status: 404 })) : world.fetch(url, init);
  await assert.rejects(deviceLogin({ fetch, onCode: () => {}, sleep: async () => {}, now: () => world.now }),
    error => error instanceof LoginFailed && error.reason === 'usercode_404');
});
