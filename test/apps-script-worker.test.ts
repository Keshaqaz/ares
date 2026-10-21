import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAppsScript } from '../scripts/build-worker.ts';
import { MANIFEST, TICK_FUNCTION } from '../src/apps-script/layout.ts';
import { JOURNAL_SIZE } from '../src/apps-script/worker.ts';
import { fakeWorld, credit, window } from './support/fake-world.ts';
import type { FakeWorld } from './support/fake-world.ts';
import { fakeAppsScript, bundle, PROPERTY_VALUE_LIMIT } from './support/fake-apps-script.ts';
import type { FakeAppsScript, Reply } from './support/fake-apps-script.ts';
import type { Session } from '../src/chatgpt/session.ts';

const MINUTE = 60_000, HOUR = 3600_000, DAY = 24 * HOUR;
const SECRET = 'fake-secret-0123456789';
const RULES = { beforeExpiry: true, weeklyAutoApply: false };

const post = (gas: FakeAppsScript, action: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const { json } = gas.doPost({ secret: SECRET, action, ...extra });
  assert.ok(json, `${action} answers JSON`);
  return json;
};
const journal = (gas: FakeAppsScript): { kind: string; outcome: string; at: string; durationMs: number }[] =>
  JSON.parse(gas.properties.get('journal') ?? '[]');
const state = (gas: FakeAppsScript) => JSON.parse(gas.properties.get('state') ?? 'null');
const expiry = (session: Session): number =>
  JSON.parse(Buffer.from(session.accessToken.split('.')[1] ?? '', 'base64url').toString()).exp * 1000;

// A project the CLI has set up: rules, then the first worker session through login.
async function installed(options: Parameters<typeof fakeWorld>[0] = {}) {
  const world = fakeWorld(options);
  const gas = await fakeAppsScript({ world });
  assert.equal(post(gas, 'rules', { rules: RULES }).ok, true);
  const session = world.login();
  const login = post(gas, 'login', { login: { id: 'login-1', session } });
  assert.equal(login.outcome, 'idle');
  return { world, gas, session };
}
const noViolations = (world: FakeWorld, gas: FakeAppsScript) => {
  assert.deepEqual(world.violations, []);
  assert.deepEqual(gas.violations, []);
  assert.equal(gas.lockHeld, false, 'every run releases the lock');
};

test('the bundle is one plain script with global tick, doGet and doPost, and the manifest makes it an anonymous web app', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'apps-script-build-'));
  const text = await readFile(await buildAppsScript(join(dir, 'worker.js')), 'utf8');
  assert.equal(text, await bundle());
  assert.doesNotMatch(text, /^\s*(import|export)\s/m);
  assert.doesNotMatch(text, /\brequire\(|["']node:|\basync\b|\bawait\b/);
  for (const name of ['tick', 'doGet', 'doPost']) assert.match(text, new RegExp(`^function ${name}\\(`, 'm'));
  assert.deepEqual(MANIFEST.webapp, { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' });
  assert.deepEqual(MANIFEST.oauthScopes, ['https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.scriptapp']);
});

test('doGet only confirms the consent: it schedules nothing', async () => {
  const gas = await fakeAppsScript({ world: fakeWorld() });
  const page = gas.doGet();
  assert.match(page.text, /вернитесь в терминал/);
  assert.deepEqual(gas.triggers, []);
});

test('the first login brings the worker session; status shows the summary and the journal, never the tokens', async () => {
  const { world, gas, session } = await installed();
  assert.equal(state(gas).session.refreshToken, session.refreshToken);
  const status = post(gas, 'status');
  assert.equal(status.ok, true);
  assert.equal(status.schedule, false);
  assert.match(String(status.version), /^\d+\.\d+\.\d+$/);
  assert.deepEqual((status.summary as { resets: unknown }).resets,
    [{ creditId: 'reset-a', expiresAt: new Date(world.now + 5 * DAY).toISOString() }]);
  assert.deepEqual((status.summary as { login: unknown }).login,
    { id: 'login-1', result: 'accepted', at: new Date(world.now).toISOString() });
  assert.deepEqual(journal(gas).map(e => [e.kind, e.outcome]), [['login', 'idle']]);
  assert.deepEqual(status.journal, journal(gas));
  noViolations(world, gas);
});

test('schedule on keeps one tick trigger every 5 minutes, schedule off removes it', async () => {
  const { gas } = await installed();
  assert.deepEqual(post(gas, 'schedule', { on: true }), { ok: true, schedule: true });
  post(gas, 'schedule', { on: true });
  assert.deepEqual(gas.triggers, [{ handler: TICK_FUNCTION, minutes: 5 }]);
  assert.equal(post(gas, 'status').schedule, true);
  assert.deepEqual(post(gas, 'schedule', { on: false }), { ok: true, schedule: false });
  assert.deepEqual(gas.triggers, []);
  assert.deepEqual(post(gas, 'schedule', { on: 'yes' }), { ok: false, error: 'bad_request' });
});

test('the scheduled tick applies a reset in the last hour before its deadline, not earlier', async () => {
  const { world, gas } = await installed();
  world.chatgpt.credits = [credit('reset-a', world.now + HOUR + 2 * MINUTE)];
  gas.tick();
  assert.deepEqual(world.spent(), []);
  world.advance(5 * MINUTE);
  gas.tick();
  assert.deepEqual(world.spent(), ['reset-a']);
  assert.deepEqual(journal(gas).map(e => [e.kind, e.outcome]), [['login', 'idle'], ['scheduled', 'idle'], ['scheduled', 'applied']]);
  noViolations(world, gas);
});

test('a second tick in the same minute spends no second reset and makes no second refresh', async () => {
  const { world, gas, session } = await installed();
  world.chatgpt.credits = [credit('reset-a', world.now + 30 * MINUTE), credit('reset-b', world.now + 50 * MINUTE)];
  world.advance(expiry(session) - world.now - MINUTE);
  world.chatgpt.credits = [credit('reset-a', world.now + 30 * MINUTE), credit('reset-b', world.now + 30 * MINUTE)];
  // One more execution starts while the first holds the lock, and one right after it.
  let overlapped = false;
  gas.onFetch = () => { gas.tick(); overlapped = true; };
  gas.tick();
  assert.ok(overlapped);
  gas.tick();
  assert.equal(world.refreshCalls().length, 1);
  assert.deepEqual(world.spent(), ['reset-a'], 'one reset per group of matching deadlines');
  assert.equal(world.consumeCalls().length, 1);
  assert.deepEqual(journal(gas).slice(1).map(e => e.outcome), ['applied', 'idle']);
  noViolations(world, gas);
});

test('a lost worker session makes the tick throw, so that Google mails the user', async () => {
  const { world, gas } = await installed();
  world.endSession('refresh_token_invalidated');
  assert.throws(() => gas.tick(), /lost its ChatGPT sign-in.*aures login/);
  assert.equal(journal(gas).at(-1)?.outcome, 'reauth_required');
  assert.equal(gas.lockHeld, false);
});

test('a temporary failure does not throw: the next tick checks again', async () => {
  const { world, gas } = await installed();
  world.chatgpt.fail = { status: 503 };
  gas.tick();
  world.chatgpt.fail = 'network';
  gas.tick();
  world.chatgpt.fail = null;
  gas.tick();
  assert.deepEqual(journal(gas).slice(1).map(e => e.outcome), ['transient_error', 'transient_error', 'idle']);
  noViolations(world, gas);
});

test('a project without state makes the tick throw with a pointer to status', async () => {
  const gas = await fakeAppsScript({ world: fakeWorld() });
  assert.throws(() => gas.tick(), /does not read.*aures status.*state_missing/);
  assert.deepEqual(journal(gas).map(e => [e.outcome, (e as { reason?: string }).reason]), [['broken_state', 'state_missing']]);
});

test(`the journal keeps the latest ${JOURNAL_SIZE} runs with time, outcome, duration and kind`, async () => {
  const { world, gas } = await installed();
  for (let i = 0; i < JOURNAL_SIZE + 5; i++) {
    world.advance(5 * MINUTE);
    if (i % 2) gas.tick(); else post(gas, 'wake');
  }
  const entries = journal(gas);
  assert.equal(entries.length, JOURNAL_SIZE);
  assert.equal(entries.at(-1)?.at, new Date(world.now).toISOString());
  assert.deepEqual(new Set(entries.map(e => e.kind)), new Set(['scheduled', 'mac']));
  for (const entry of entries) assert.ok(Number.isInteger(entry.durationMs) && entry.durationMs >= 0);
});

test('trial names the reset the rules would apply and applies nothing', async () => {
  const { world, gas } = await installed();
  world.chatgpt.credits = [credit('reset-a', world.now + 20 * MINUTE)];
  const trial = post(gas, 'trial');
  assert.equal(trial.outcome, 'would_apply');
  assert.deepEqual(trial.wouldApply, { creditId: 'reset-a', reason: 'before_expiry' });
  assert.equal(world.consumeCalls().length, 0);
  assert.equal(journal(gas).at(-1)?.kind, 'trial');
  world.chatgpt.credits = [credit('reset-a', world.now + 3 * DAY)];
  assert.deepEqual([post(gas, 'trial').outcome, post(gas, 'trial').wouldApply], ['idle', null]);
  noViolations(world, gas);
});

test('apply_now applies the named reset regardless of the rules', async () => {
  const { world, gas } = await installed();
  world.chatgpt.credits = [credit('reset-a', world.now + 5 * DAY), credit('reset-b', world.now + 6 * DAY)];
  const reply = post(gas, 'apply_now', { creditId: 'reset-b' });
  assert.equal(reply.outcome, 'applied');
  assert.deepEqual(world.spent(), ['reset-b']);
  assert.equal(journal(gas).at(-1)?.kind, 'apply_now');
  assert.deepEqual(post(gas, 'apply_now', {}), { ok: false, error: 'bad_request' });
  noViolations(world, gas);
});

test('rules replaces the rules the tick follows', async () => {
  const { world, gas } = await installed();
  world.chatgpt.credits = [credit('reset-a', world.now + 5 * DAY)];
  world.chatgpt.secondary = window(604800, 100, world.now + 2 * DAY);
  gas.tick();
  assert.deepEqual(world.spent(), []);
  assert.deepEqual(post(gas, 'rules', { rules: { beforeExpiry: false, weeklyAutoApply: true } }),
    { ok: true, rules: { beforeExpiry: false, weeklyAutoApply: true } });
  gas.tick();
  assert.deepEqual(world.spent(), ['reset-a']);
  assert.deepEqual(post(gas, 'rules', { rules: { beforeExpiry: 'yes', weeklyAutoApply: true } }), { ok: false, error: 'bad_request' });
  assert.deepEqual(post(gas, 'rules', {}), { ok: false, error: 'bad_request' });
});

test('login takes a new session of the same ChatGPT account and rejects another account', async () => {
  const { world, gas, session } = await installed();
  const ours = world.login();
  const accepted = post(gas, 'login', { login: { id: 'login-2', session: ours } });
  assert.equal((accepted.summary as { login: { result: string } }).login.result, 'accepted');
  assert.equal(state(gas).session.refreshToken, ours.refreshToken);

  world.accountId = 'account-other';
  const theirs = world.login();
  world.accountId = 'account-fake';
  const rejected = post(gas, 'login', { login: { id: 'login-3', session: theirs } });
  assert.equal((rejected.summary as { login: { id: string; result: string } }).login.result, 'rejected');
  assert.equal(rejected.outcome, 'idle', 'the worker goes on with its own session');
  assert.equal(state(gas).session.accountId, 'account-fake');
  assert.notEqual(state(gas).session.refreshToken, session.refreshToken);
  assert.deepEqual(post(gas, 'login', { login: { id: 'login-4' } }), { ok: false, error: 'bad_request' });
  noViolations(world, gas);
});

test('a login without a schedule spends nothing: the worker is not the active one yet', async () => {
  const { world, gas } = await installed();
  world.chatgpt.credits = [credit('reset-due', world.now + 10 * MINUTE)];
  const idle = post(gas, 'login', { login: { id: 'login-2', session: world.login() } });
  assert.equal(idle.outcome, 'would_apply');
  assert.deepEqual(idle.wouldApply, { creditId: 'reset-due', reason: 'before_expiry' });
  assert.deepEqual(world.consumeCalls(), []);
  assert.equal(state(gas).pending ?? null, null);

  post(gas, 'schedule', { on: true });
  const active = post(gas, 'login', { login: { id: 'login-3', session: world.login() } });
  assert.equal(active.outcome, 'applied');
  assert.equal(world.consumeCalls().length, 1);
  noViolations(world, gas);
});

test('status names the rules apart from the summary, so setup knows what is missing', async () => {
  const gas = await fakeAppsScript({ world: fakeWorld() });
  assert.deepEqual([post(gas, 'status').rules, post(gas, 'status').summary], [null, null]);
  post(gas, 'rules', { rules: RULES });
  assert.deepEqual([post(gas, 'status').rules, post(gas, 'status').summary], [RULES, null]);
});

test('wake runs an ordinary tick for the Mac', async () => {
  const { world, gas } = await installed();
  world.chatgpt.credits = [credit('reset-a', world.now + 10 * MINUTE)];
  assert.equal(post(gas, 'wake').outcome, 'applied');
  assert.equal(journal(gas).at(-1)?.kind, 'mac');
});

test('revoke ends the worker session in OpenAI; the next tick finds it lost', async () => {
  const { world, gas, session } = await installed();
  assert.deepEqual(post(gas, 'revoke'), { ok: true, outcome: 'revoked' });
  assert.deepEqual(world.auth.revoked, [session.refreshToken]);
  world.advance(expiry(session) - world.now);
  assert.throws(() => gas.tick(), /lost its ChatGPT sign-in/);
  world.auth.revokeFail = { status: 503 };
  assert.deepEqual(post(gas, 'revoke'), { ok: true, outcome: 'revoke_failed', reason: 'revoke_503' });
});

test('uninstall removes the triggers, revokes the session, forgets the properties and the script authorization', async () => {
  const { world, gas, session } = await installed();
  post(gas, 'schedule', { on: true });
  assert.deepEqual(post(gas, 'uninstall'), { ok: true, outcome: 'revoked' });
  assert.deepEqual(gas.triggers, []);
  assert.deepEqual(world.auth.revoked, [session.refreshToken]);
  assert.equal(gas.properties.size, 0);
  assert.equal(gas.authInvalidated, true);
  assert.equal(post(gas, 'status').summary, null);
  noViolations(world, gas);
});

test('uninstall keeps the state when OpenAI does not confirm the revocation, and a repeat retries it', async () => {
  const { world, gas, session } = await installed();
  post(gas, 'schedule', { on: true });
  world.auth.revokeFail = { status: 503 };
  assert.deepEqual(post(gas, 'uninstall'), { ok: true, outcome: 'revoke_failed', reason: 'revoke_503' });
  assert.deepEqual(gas.triggers, []);
  assert.equal(gas.authInvalidated, false);
  world.auth.revokeFail = null;
  assert.deepEqual(post(gas, 'uninstall'), { ok: true, outcome: 'revoked' });
  assert.deepEqual(world.auth.revoked, [session.refreshToken]);
  assert.equal(gas.properties.size, 0);
  assert.equal(gas.authInvalidated, true);
});

test('a wrong or missing secret gets one faceless reply and changes nothing', async () => {
  const { world, gas } = await installed();
  post(gas, 'schedule', { on: true });
  const before = { properties: new Map(gas.properties), requests: world.requests.length, triggers: [...gas.triggers] };
  const replies: Reply[] = [];
  for (const action of ['status', 'trial', 'apply_now', 'rules', 'login', 'schedule', 'wake', 'revoke', 'uninstall', 'nope']) {
    replies.push(gas.doPost({ secret: 'fake-secret-0123456788', action, on: false, creditId: 'reset-a' }));
    replies.push(gas.doPost({ action }));
  }
  replies.push(gas.doPost('not json'), gas.doPost(''), gas.doPost([SECRET, 'status']));
  for (const reply of replies) assert.deepEqual(reply, replies[0]);
  assert.deepEqual(replies[0]?.json, { ok: false, error: 'forbidden' });
  assert.deepEqual(gas.properties, before.properties);
  assert.deepEqual(gas.triggers, before.triggers);
  assert.equal(world.requests.length, before.requests);
  assert.equal(gas.authInvalidated, false);

  // A project without its secret file answers every request the same way.
  const bare = await fakeAppsScript({ world, secret: null });
  assert.deepEqual(bare.doPost({ secret: '', action: 'status' }), replies[0]);
  assert.deepEqual(bare.doPost({ action: 'status' }), replies[0]);
  assert.deepEqual(post(gas, 'nope'), { ok: false, error: 'unknown_action' });
});

test('no reply carries a token or the state', async () => {
  const { world, gas } = await installed();
  world.chatgpt.credits = [credit('reset-a', world.now + 20 * MINUTE), credit('reset-b', world.now + 3 * DAY)];
  const texts = [
    post(gas, 'status'), post(gas, 'trial'), post(gas, 'wake'), post(gas, 'apply_now', { creditId: 'reset-b' }),
    post(gas, 'login', { login: { id: 'login-2', session: world.login() } }), post(gas, 'rules', { rules: RULES }),
    post(gas, 'schedule', { on: true }), post(gas, 'status'), post(gas, 'revoke'), post(gas, 'uninstall'),
  ].map(reply => JSON.stringify(reply));
  const secrets = world.auth.sessions.flatMap(s => [s.refresh, s.access ?? '']).filter(Boolean);
  for (const text of texts) {
    for (const secret of secrets) assert.ok(!text.includes(secret), 'no token');
    assert.doesNotMatch(text, /refreshToken|accessToken|idToken|session|redeemRequestId|accountId|account-fake/);
  }
});

test('status names a pending application by its reset only, and drops it once it is settled', async () => {
  const { world, gas } = await installed();
  world.chatgpt.credits = [credit('reset-a', world.now + 20 * MINUTE)];
  post(gas, 'schedule', { on: true });
  world.chatgpt.lose = 'after';
  gas.tick();
  const pending = state(gas).pending;
  assert.ok(pending?.redeemRequestId);
  const status = post(gas, 'status');
  assert.deepEqual((status.summary as { pending: unknown }).pending,
    { creditId: 'reset-a', reason: 'before_expiry', at: new Date(pending.at).toISOString() });
  assert.ok(!JSON.stringify(status).includes(pending.redeemRequestId), 'no redeem_request_id');

  world.chatgpt.lose = null;
  world.advance(5 * MINUTE);
  gas.tick();
  assert.equal((post(gas, 'status').summary as { pending: unknown }).pending, null);
  noViolations(world, gas);
});

test('a changing action while another run holds the lock answers busy; status still answers', async () => {
  const { world, gas } = await installed();
  let during: Record<string, unknown>[] = [];
  gas.onFetch = () => { during = [post(gas, 'apply_now', { creditId: 'reset-a' }), post(gas, 'status')]; };
  gas.tick();
  assert.deepEqual(during[0], { ok: false, error: 'busy' });
  assert.equal(during[1]?.ok, true);
  assert.deepEqual(world.spent(), []);
});

test('the state of a worker with history and several resets fits in one Script Properties value', async () => {
  // Real access and id tokens are about 2 KB each.
  const { world, gas } = await installed({ tokenPadding: 2000 });
  post(gas, 'rules', { rules: { beforeExpiry: true, weeklyAutoApply: true } });
  world.chatgpt.credits = Array.from({ length: 12 }, (_, i) => credit(`reset-${String(i).padStart(2, '0')}-${'x'.repeat(24)}`,
    world.now + (i + 1) * 22 * HOUR));
  for (let day = 0; day < 11; day++) {
    world.chatgpt.secondary = window(604800, 100, world.now + 2 * DAY);
    for (let i = 0; i < 24 * 12; i++) {
      world.advance(5 * MINUTE);
      gas.tick();
    }
  }
  post(gas, 'apply_now', { creditId: 'missing' });
  post(gas, 'login', { login: { id: 'login-2', session: world.login() } });
  assert.ok(world.spent().length >= 6, `applied ${world.spent().length}`);
  assert.ok(world.refreshCalls().length >= 1);
  const size = Buffer.byteLength(gas.properties.get('state') ?? '');
  assert.ok(size < PROPERTY_VALUE_LIMIT * 0.8, `state is ${size} bytes`);
  assert.ok(gas.largestValue <= PROPERTY_VALUE_LIMIT);
  noViolations(world, gas);
});
