import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runWorker } from '../src/worker/run.mjs';
import { FILES } from '../src/worker/layout.mjs';
import { sealState, openState, generateKey, BrokenState } from '../src/worker/state-file.mjs';
import { fakeWorld, credit } from './support/fake-world.mjs';
import { workerRepo } from './support/worker-repo.mjs';

const HOUR = 3600_000, DAY = 24 * HOUR;
const RULES = { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: false };

async function workerWorld({ rules = RULES } = {}) {
  const world = fakeWorld();
  // The shape setup writes: no pending consume, no applications yet.
  const initial = { formatVersion: 1, session: world.login(), pending: null, applied: [] };
  const repo = await workerRepo({ state: initial, rules });
  const run = (options = {}) => runWorker({ dir: repo.dir, key: repo.key, now: world.now, fetch: world.fetch,
    stepSummaryPath: repo.stepSummary, ...options });
  return { world, repo, initial, run };
}
const expiry = session => JSON.parse(Buffer.from(session.accessToken.split('.')[1], 'base64url')).exp * 1000;
const nearExpiry = (world, session) => world.advance(expiry(session) - world.now - 60_000);

test('state seals and opens with the same key, and nothing else opens it', () => {
  const key = generateKey();
  const state = { formatVersion: 1, session: { accessToken: 'a', refreshToken: 'r', idToken: 'i', accountId: 'acc' } };
  const sealed = sealState(state, key);
  assert.deepEqual(openState(sealed, key), state);
  assert.ok(!sealed.includes('acc') && !sealed.includes('"r"'));
  assert.notEqual(sealState(state, key), sealed, 'a fresh nonce on every seal');
  assert.throws(() => openState(sealed, generateKey()), BrokenState);
  const envelope = JSON.parse(sealed);
  const data = Buffer.from(envelope.data, 'base64');
  data[0] ^= 1;
  assert.throws(() => openState(JSON.stringify({ ...envelope, data: data.toString('base64') }), key), BrokenState);
  assert.throws(() => openState(sealState({ ...state, formatVersion: 2 }, key), key), { reason: 'state_format_unknown' });
});

test('a first tick commits the read state and summary, a tick that changes nothing commits nothing', async () => {
  const { world, repo, initial, run } = await workerWorld();
  assert.deepEqual(await run(), { outcome: 'idle', exitCode: 0 });
  assert.deepEqual(repo.commits(), ['Set up worker', 'Worker tick: idle']);
  const state = repo.state();
  assert.deepEqual(state.session, initial.session);
  assert.deepEqual(state.observed.resets, [{ id: 'reset-a', expiresAt: world.now + 5 * DAY }]);

  world.advance(HOUR);
  assert.deepEqual(await run(), { outcome: 'idle', exitCode: 0 });
  assert.deepEqual(repo.commits(), ['Set up worker', 'Worker tick: idle']);

  world.chatgpt.credits.push(credit('reset-b', world.now + 2 * DAY));
  await run();
  assert.equal(repo.commits().length, 3);
  assert.deepEqual(JSON.parse(repo.show(FILES.summary)).resets.map(r => r.creditId), ['reset-a', 'reset-b']);
});

test('a refreshed session is pushed before the tick reads quotas and resets', async () => {
  const { world, repo, initial, run } = await workerWorld();
  nearExpiry(world, initial.session);
  const pushedBeforeReads = [];
  const fetch = (url, init) => {
    if (new URL(url).host === 'chatgpt.com') pushedBeforeReads.push(repo.state().session.refreshToken);
    return world.fetch(url, init);
  };
  assert.equal((await run({ fetch })).outcome, 'idle');
  assert.deepEqual(repo.commits(), ['Set up worker', 'Save worker state', 'Worker tick: idle']);
  const rotated = repo.state().session.refreshToken;
  assert.notEqual(rotated, initial.session.refreshToken);
  assert.deepEqual(pushedBeforeReads, [rotated, rotated]);
});

test('a refresh followed by a failing read keeps the pushed session and commits nothing more', async () => {
  const { world, repo, initial, run } = await workerWorld();
  nearExpiry(world, initial.session);
  world.chatgpt.fail = { status: 503 };
  assert.deepEqual(await run(), { outcome: 'transient_error', exitCode: 0 });
  assert.deepEqual(repo.commits(), ['Set up worker', 'Save worker state']);
  assert.equal(repo.state().session.refreshToken, world.auth.current.refresh);
  // The next tick works from the pushed session, not a reused refresh token.
  world.chatgpt.fail = null;
  world.advance(HOUR);
  const next = await runWorker({ dir: repo.checkout(), key: repo.key, now: world.now, fetch: world.fetch });
  assert.equal(next.outcome, 'idle');
  assert.equal(world.refreshCalls().length, 1);
});

test('a consume is preceded by a pushed pending state and followed by a pushed result', async () => {
  const { world, repo, run } = await workerWorld();
  world.chatgpt.credits = [credit('reset-a', world.now + 4 * HOUR)];
  const result = await run();
  assert.equal(result.outcome, 'applied');
  assert.deepEqual(world.spent(), ['reset-a']);
  const commits = repo.commits();
  assert.deepEqual(commits, ['Set up worker', 'Save worker state', 'Worker tick: applied']);
  const pending = repo.state('main~1');
  assert.equal(pending.pending.creditId, 'reset-a');
  assert.equal(world.consumeCalls()[0].key, pending.pending.redeemRequestId);
  const final = repo.state();
  assert.equal(final.pending, null);
  assert.equal(final.applied.at(-1).creditId, 'reset-a');
  assert.equal(JSON.parse(repo.show(FILES.summary)).lastApplied.creditId, 'reset-a');
});

test('a transient failure without a refresh commits nothing and does not fail the run', async () => {
  const { world, repo, run } = await workerWorld();
  world.chatgpt.fail = 'network';
  assert.deepEqual(await run(), { outcome: 'transient_error', exitCode: 0 });
  assert.deepEqual(repo.commits(), ['Set up worker']);
  assert.match(await repo.readStepSummary(), /Временная ошибка/);
});

test('a lost worker session fails the run and asks for a new login', async () => {
  const { world, repo, run } = await workerWorld();
  world.revokeAccess();
  assert.deepEqual(await run(), { outcome: 'reauth_required', exitCode: 1 });
  assert.deepEqual(repo.commits(), ['Set up worker']);
  assert.match(await repo.readStepSummary(), /codex-auto-resets login/);
});

for (const [label, breakRepo, reason] of [
  ['a wrong key', async () => ({ key: generateKey() }), 'state_undecryptable'],
  ['a missing key', async () => ({ key: undefined }), 'key_invalid'],
  ['a garbled state file', async dir => { await writeFile(join(dir, FILES.state), 'not json'); return {}; }, 'state_unreadable'],
  ['rules of an unknown format', async dir => {
    await writeFile(join(dir, FILES.rules), JSON.stringify({ ...RULES, formatVersion: 2 })); return {};
  }, 'rules_format_unknown'],
]) {
  test(`${label} fails the run as a broken state without touching the network`, async () => {
    const { world, repo, run } = await workerWorld();
    const options = await breakRepo(repo.dir);
    assert.deepEqual(await run(options), { outcome: 'broken_state', reason, exitCode: 1 });
    assert.deepEqual(world.requests, []);
    assert.deepEqual(repo.commits(), ['Set up worker']);
    assert.match(await repo.readStepSummary(), new RegExp(reason));
  });
}

test('a refreshed session that cannot be pushed fails the run and says so', async () => {
  const { world, repo, initial, run } = await workerWorld();
  execFileSync('git', ['remote', 'set-url', 'origin', `file://${join(repo.root, 'gone.git')}`], { cwd: repo.dir });
  nearExpiry(world, initial.session);
  assert.deepEqual(await run(), { outcome: 'commit_failed', reason: 'push_failed', exitCode: 1 });
  assert.equal(world.requests.filter(r => r.host === 'chatgpt.com').length, 0);
  assert.match(await repo.readStepSummary(), /не удалось сохранить/);
});

test('rules the CLI pushed during the run survive the worker commit', async () => {
  const { world, repo, run } = await workerWorld();
  const changed = { ...RULES, weeklyAutoApply: true };
  let pushed = null;
  const fetch = async (url, init) => {
    await (pushed ??= repo.pushRules(changed));
    return world.fetch(url, init);
  };
  assert.equal((await run({ fetch })).outcome, 'idle');
  assert.deepEqual(repo.commits(), ['Set up worker', 'Change rules', 'Worker tick: idle']);
  assert.deepEqual(JSON.parse(repo.show(FILES.rules)), changed);
  assert.ok(repo.state().observed);
});

test('the summary and Actions Summary carry resets and rules but no secrets', async () => {
  const { world, repo, initial, run } = await workerWorld();
  nearExpiry(world, initial.session);
  world.chatgpt.credits = [credit('reset-a', world.now + 4 * HOUR), credit('reset-b', world.now + 6 * DAY)];
  world.chatgpt.lose = 'before';
  await run();
  const state = repo.state();
  const summary = repo.show(FILES.summary);
  const published = `${summary}\n${await repo.readStepSummary()}`;
  const secrets = [initial.session, state.session].flatMap(s => [s.accessToken, s.refreshToken, s.idToken])
    .concat(world.accountId, state.pending?.redeemRequestId).filter(Boolean);
  assert.ok(secrets.length >= 7);
  for (const secret of secrets) assert.ok(!published.includes(secret), `published ${secret.slice(0, 12)}…`);
  assert.ok(!/account|token|session|redeem/i.test(summary));
  const parsed = JSON.parse(summary);
  assert.equal(parsed.formatVersion, 1);
  assert.deepEqual(parsed.resets.map(r => r.creditId), ['reset-a', 'reset-b']);
  assert.deepEqual(parsed.rules, { beforeExpiry: true, weeklyAutoApply: false });
  assert.match(published, /reset-b/);
});
