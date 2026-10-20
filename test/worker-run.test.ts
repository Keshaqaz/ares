import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runWorker, TICK_RETRIES, RETRY_PAUSE_MS } from '../src/worker/run.ts';
import type { RunOptions } from '../src/worker/run.ts';
import { FILES } from '../src/worker/layout.ts';
import { sealState, openState, generateKey, BrokenState } from '../src/worker/state-file.ts';
import type { BrokenStateReason, State } from '../src/worker/state-file.ts';
import type { Summary } from '../src/worker/summary.ts';
import type { Session } from '../src/chatgpt/session.ts';
import type { Fetch } from '../src/chatgpt/http.ts';
import { fakeWorld, credit, window } from './support/fake-world.ts';
import type { FakeWorld } from './support/fake-world.ts';
import { workerRepo } from './support/worker-repo.ts';
import type { WorkerRepo } from './support/worker-repo.ts';

const HOUR = 3600_000, DAY = 24 * HOUR;
const RULES = { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: false };

async function workerWorld({ rules = RULES } = {}) {
  const world = fakeWorld();
  // The shape setup writes: no pending consume, no applications yet.
  const initial: State = { formatVersion: 1, session: world.login(), pending: null, applied: [] };
  const repo = await workerRepo({ state: initial, rules });
  // A pause between retries passes on the world's clock; pauses lists them.
  const pauses: number[] = [];
  const run = (options: Partial<RunOptions> = {}) => runWorker({ dir: repo.dir, key: repo.key, now: world.now, fetch: world.fetch,
    stepSummaryPath: repo.stepSummary, sleep: async ms => { pauses.push(ms); world.advance(ms); }, ...options });
  return { world, repo, initial, run, pauses };
}
const expiry = (session: Session): number => {
  const { exp }: { exp: number } = JSON.parse(Buffer.from(session.accessToken.split('.')[1] ?? '', 'base64url').toString());
  return exp * 1000;
};
const nearExpiry = (world: FakeWorld, session: Session) => world.advance(expiry(session) - world.now - 60_000);

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
  data.writeUInt8(data.readUInt8(0) ^ 1, 0);
  assert.throws(() => openState(JSON.stringify({ ...envelope, data: data.toString('base64') }), key), BrokenState);
  assert.throws(() => openState(sealState({ ...state, formatVersion: 2 }, key), key), { reason: 'state_format_unknown' });
});

test('a first tick commits the read state and summary, a tick that changes nothing commits nothing', async () => {
  const { world, repo, initial, run } = await workerWorld();
  assert.deepEqual(await run(), { outcome: 'idle', exitCode: 0 });
  assert.deepEqual(repo.commits(), ['Set up worker', 'Worker tick: idle']);
  const state = repo.state();
  assert.deepEqual(state.session, initial.session);
  assert.deepEqual(state.observed?.resets, [{ id: 'reset-a', expiresAt: world.now + 5 * DAY }]);

  world.advance(HOUR);
  assert.deepEqual(await run(), { outcome: 'idle', exitCode: 0 });
  assert.deepEqual(repo.commits(), ['Set up worker', 'Worker tick: idle']);

  world.chatgpt.credits.push(credit('reset-b', world.now + 2 * DAY));
  await run();
  assert.equal(repo.commits().length, 3);
  const summary: Summary = JSON.parse(repo.show(FILES.summary) ?? 'null');
  assert.deepEqual(summary.resets.map(r => r.creditId), ['reset-a', 'reset-b']);
});

test('a tick that only sees the quotas move commits nothing', async () => {
  const { world, repo, run } = await workerWorld();
  await run();
  const commits = repo.commits();
  world.advance(HOUR);
  world.chatgpt.primary = window(18000, 75, world.now + 2 * HOUR);
  world.chatgpt.secondary = window(604800, 65, world.now + 3 * DAY);
  assert.deepEqual(await run(), { outcome: 'idle', exitCode: 0 });
  assert.deepEqual(repo.commits(), commits);
});

test('a refreshed session is pushed before the tick reads quotas and resets', async () => {
  const { world, repo, initial, run } = await workerWorld();
  nearExpiry(world, initial.session);
  const pushedBeforeReads: string[] = [];
  const fetch: Fetch = (url, init) => {
    if (new URL(url instanceof Request ? url.url : url).host === 'chatgpt.com') pushedBeforeReads.push(repo.state().session.refreshToken);
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
  assert.equal(repo.state().session.refreshToken, world.auth.current?.refresh);
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
  assert.equal(pending.pending?.creditId, 'reset-a');
  const [call] = world.consumeCalls();
  assert.ok(call && pending.pending);
  assert.equal(call.key, pending.pending.redeemRequestId);
  const final = repo.state();
  assert.equal(final.pending, null);
  assert.equal(final.applied?.at(-1)?.creditId, 'reset-a');
  const summary: Summary = JSON.parse(repo.show(FILES.summary) ?? 'null');
  assert.equal(summary.lastApplied?.creditId, 'reset-a');
  // The list was read before the consume; the applied reset is no longer issued.
  assert.deepEqual(summary.resets, []);
});

test('a transient failure without a refresh commits nothing and does not fail the run', async () => {
  const { world, repo, run, pauses } = await workerWorld();
  world.chatgpt.fail = 'network';
  assert.deepEqual(await run(), { outcome: 'transient_error', exitCode: 0 });
  assert.deepEqual(repo.commits(), ['Set up worker']);
  assert.match(await repo.readStepSummary(), /Temporary error/);
  assert.deepEqual(pauses, [], 'nothing is due, so the next scheduled run checks again');
});

test('a failed read is retried within the run when the last read had a reset due, and the reset is applied', async () => {
  const { world, repo, run, pauses } = await workerWorld();
  world.chatgpt.credits = [credit('reset-a', world.now + 2 * HOUR)];
  world.chatgpt.fail = { status: 503 };
  assert.deepEqual(await run(), { outcome: 'transient_error', exitCode: 0 });
  assert.deepEqual(pauses, [], 'before the first read nothing is known to be due');

  // The next run reads the due reset, then the consume is refused once and goes through on the retry.
  world.chatgpt.fail = null;
  world.chatgpt.consumeFail = { status: 502 };
  const fetch: Fetch = async (url, init) => {
    const reply = await world.fetch(url, init);
    if (String(url).endsWith('/consume')) world.chatgpt.consumeFail = null;
    return reply;
  };
  assert.deepEqual(await run({ fetch }), { outcome: 'applied', exitCode: 0 });
  assert.deepEqual(pauses, [RETRY_PAUSE_MS]);
  assert.deepEqual(world.spent(), ['reset-a']);
  const [first, second] = world.consumeCalls();
  assert.ok(first && second);
  assert.equal(second.key, first.key, 'the retry keeps the redeem_request_id');
  assert.equal(repo.state().applied?.at(-1)?.creditId, 'reset-a');
});

test('a read failure with nothing due by the last read is not retried; a consume in doubt is, with one key, then left to the next run', async () => {
  const { world, repo, run, pauses } = await workerWorld();
  world.chatgpt.credits = [credit('reset-a', world.now + 2 * HOUR)];
  await run();
  assert.deepEqual(world.spent(), ['reset-a']);
  world.chatgpt.credits.push(credit('reset-b', world.now + 3 * HOUR));
  world.chatgpt.fail = 'network';
  const commits = repo.commits().length;
  assert.deepEqual(await run(), { outcome: 'transient_error', exitCode: 0 });
  assert.deepEqual(pauses, [], 'the last read had no other reset due');

  world.chatgpt.fail = null;
  world.chatgpt.lose = 'before';
  assert.deepEqual(await run(), { outcome: 'pending', exitCode: 0 });
  assert.deepEqual(pauses, Array(TICK_RETRIES).fill(RETRY_PAUSE_MS));
  const keys = world.consumeCalls().slice(1).map(call => call.key);
  assert.equal(keys.length, 1 + TICK_RETRIES);
  assert.equal(new Set(keys).size, 1, 'one attempt, one redeem_request_id');
  assert.equal(repo.state().pending?.creditId, 'reset-b');
  assert.ok(repo.commits().length > commits);
});

test('a retry does not take the login secret a second time', async () => {
  const { world, repo, run, pauses } = await workerWorld();
  world.chatgpt.credits = [credit('reset-a', world.now + 2 * HOUR)];
  await run();
  world.chatgpt.credits = [credit('reset-b', world.now + 3 * HOUR)];
  world.chatgpt.lose = 'before';
  const session = world.login();
  assert.equal((await run({ login: JSON.stringify({ id: 'login-1', session }) })).outcome, 'pending');
  assert.equal(pauses.length, TICK_RETRIES);
  assert.deepEqual(repo.state().login?.at, world.now - TICK_RETRIES * RETRY_PAUSE_MS);
  assert.deepEqual(repo.state().session, session);
  assert.deepEqual(world.violations, []);
});

test('apply-now that meets a failed read is retried within the run', async () => {
  const { world, run, pauses } = await workerWorld();
  world.chatgpt.fail = { status: 503 };
  let reads = 0;
  const fetch: Fetch = async (url, init) => {
    if (String(url).endsWith('/usage') && ++reads > 1) world.chatgpt.fail = null;
    return world.fetch(url, init);
  };
  assert.deepEqual(await run({ fetch, applyNow: 'reset-a' }), { outcome: 'applied', exitCode: 0 });
  assert.deepEqual(pauses, [RETRY_PAUSE_MS]);
  assert.deepEqual(world.spent(), ['reset-a']);
});

test('a lost worker session fails the run and asks for a new login', async () => {
  const { world, repo, run } = await workerWorld();
  world.revokeAccess();
  assert.deepEqual(await run(), { outcome: 'reauth_required', exitCode: 1 });
  assert.deepEqual(repo.commits(), ['Set up worker']);
  assert.match(await repo.readStepSummary(), /aures login/);
});

for (const [label, breakRepo, reason] of [
  ['a wrong key', async () => ({ key: generateKey() }), 'state_undecryptable'],
  ['a missing key', async () => ({ key: undefined }), 'key_invalid'],
  ['a key of the wrong length', async () => ({ key: Buffer.alloc(16).toString('base64') }), 'key_invalid'],
  ['a missing state file', async ({ dir }) => { await rm(join(dir, FILES.state)); return {}; }, 'state_missing'],
  ['a garbled state file', async ({ dir }) => { await writeFile(join(dir, FILES.state), 'not json'); return {}; }, 'state_unreadable'],
  ['a state envelope of another version', async ({ dir, key }) => {
    // @ts-expect-error: the state inside does not matter, the envelope is broken.
    await writeFile(join(dir, FILES.state), JSON.stringify({ ...JSON.parse(sealState({}, key)), formatVersion: 2 })); return {};
  }, 'state_unreadable'],
  ['a state envelope of another cipher', async ({ dir, key }) => {
    // @ts-expect-error: the state inside does not matter, the envelope is broken.
    await writeFile(join(dir, FILES.state), JSON.stringify({ ...JSON.parse(sealState({}, key)), cipher: 'aes-128-gcm' })); return {};
  }, 'state_unreadable'],
  ['a state envelope without its nonce', async ({ dir, key }) => {
    // @ts-expect-error: the state inside does not matter, the envelope is broken.
    await writeFile(join(dir, FILES.state), JSON.stringify({ ...JSON.parse(sealState({}, key)), iv: 7 })); return {};
  }, 'state_undecryptable'],
  ['a state without a session', async ({ dir, key }) => {
    // @ts-expect-error: a state without a session, as only a broken repository has.
    await writeFile(join(dir, FILES.state), sealState({ formatVersion: 1, pending: null, applied: [] }, key)); return {};
  }, 'state_without_session'],
  ['a missing rules file', async ({ dir }) => { await rm(join(dir, FILES.rules)); return {}; }, 'rules_missing'],
  ['a garbled rules file', async ({ dir }) => { await writeFile(join(dir, FILES.rules), 'not json'); return {}; }, 'rules_unreadable'],
  ['rules without a rule', async ({ dir }) => {
    await writeFile(join(dir, FILES.rules), JSON.stringify({ formatVersion: 1, beforeExpiry: true })); return {};
  }, 'rules_unreadable'],
  ['rules of format zero', async ({ dir }) => {
    await writeFile(join(dir, FILES.rules), JSON.stringify({ ...RULES, formatVersion: 0 })); return {};
  }, 'rules_format_unknown'],
  ['rules of an unknown format', async ({ dir }) => {
    await writeFile(join(dir, FILES.rules), JSON.stringify({ ...RULES, formatVersion: 2 })); return {};
  }, 'rules_format_unknown'],
] satisfies [string, (repo: WorkerRepo) => Promise<Partial<RunOptions>>, BrokenStateReason][]) {
  test(`${label} fails the run as a broken state without touching the network`, async () => {
    const { world, repo, run } = await workerWorld();
    const options = await breakRepo(repo);
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
  assert.match(await repo.readStepSummary(), /Could not save the data/);
});

test('rules the CLI pushed during the run survive the worker commit', async () => {
  const { world, repo, run } = await workerWorld();
  const changed = { ...RULES, weeklyAutoApply: true };
  let pushed: Promise<void> | null = null;
  const fetch: Fetch = async (url, init) => {
    await (pushed ??= repo.pushRules(changed));
    return world.fetch(url, init);
  };
  assert.equal((await run({ fetch })).outcome, 'idle');
  assert.deepEqual(repo.commits(), ['Set up worker', 'Change rules', 'Worker tick: idle']);
  assert.deepEqual(JSON.parse(repo.show(FILES.rules) ?? 'null'), changed);
  assert.ok(repo.state().observed);
});

test('the summary and Actions Summary carry resets and rules but no secrets', async () => {
  const { world, repo, initial, run } = await workerWorld();
  nearExpiry(world, initial.session);
  world.chatgpt.credits = [credit('reset-a', world.now + 4 * HOUR), credit('reset-b', world.now + 6 * DAY)];
  world.chatgpt.lose = 'before';
  await run();
  const state = repo.state();
  const summary = repo.show(FILES.summary) ?? '';
  const published = `${summary}\n${await repo.readStepSummary()}`;
  const secrets = [initial.session, state.session].flatMap(s => [s.accessToken, s.refreshToken, s.idToken])
    .concat(world.accountId, state.pending?.redeemRequestId ?? '').filter(Boolean);
  assert.ok(secrets.length >= 7);
  for (const secret of secrets) assert.ok(!published.includes(secret), `published ${secret.slice(0, 12)}…`);
  assert.ok(!/account|token|session|redeem/i.test(summary));
  const parsed: Summary = JSON.parse(summary);
  assert.equal(parsed.formatVersion, 1);
  assert.deepEqual(parsed.resets.map(r => r.creditId), ['reset-a', 'reset-b']);
  assert.deepEqual(parsed.rules, { beforeExpiry: true, weeklyAutoApply: false });
  assert.match(published, /reset-b/);
});

test('a login secret replaces the lost session, and the summary tells which login the worker took', async () => {
  const { world, repo, run } = await workerWorld();
  await run();
  world.endSession('refresh_token_invalidated');
  assert.equal((await run()).outcome, 'reauth_required');

  const session = world.login();
  const login = JSON.stringify({ id: 'login-1', session });
  assert.deepEqual(await run({ login }), { outcome: 'idle', exitCode: 0 });
  assert.deepEqual(repo.state().session, session);
  const summary = repo.show(FILES.summary) ?? '';
  const parsed: Summary = JSON.parse(summary);
  assert.deepEqual(parsed.login, { id: 'login-1', result: 'accepted', at: new Date(world.now).toISOString() });
  assert.ok(!summary.includes(session.refreshToken));
  assert.match(await repo.readStepSummary(), /New sign-in accepted/);

  // A secret the CLI did not write is ignored, not a broken state.
  assert.equal((await run({ login: 'not json' })).outcome, 'idle');
  assert.equal((await run({ login: JSON.stringify({ id: 'login-2' }) })).outcome, 'idle');
  for (const broken of [{ id: '', session }, { id: 'login-3', session: { ...session, accountId: 1 } },
    { id: 'login-4', session: { ...session, refreshToken: undefined } }, { id: 'login-5', session: { ...session, accessToken: null } }]) {
    assert.equal((await run({ login: JSON.stringify(broken) })).outcome, 'idle');
  }
  assert.deepEqual(repo.state().session, session);
  const last: Summary = JSON.parse(repo.show(FILES.summary) ?? 'null');
  assert.equal(last.login?.id, 'login-1');
});

test('a revoke run revokes the worker session in OpenAI and commits nothing', async () => {
  const { world, repo, initial, run } = await workerWorld();
  assert.deepEqual(await run({ revoke: true }), { outcome: 'revoked', exitCode: 0 });
  assert.deepEqual(world.auth.revoked, [initial.session.refreshToken]);
  assert.deepEqual(repo.commits(), ['Set up worker']);
  assert.equal(world.requests.filter(r => r.host === 'chatgpt.com').length, 0, 'no tick');
  assert.match(await repo.readStepSummary(), /The worker's ChatGPT sign-in is revoked/);
  nearExpiry(world, initial.session);
  assert.deepEqual(await run(), { outcome: 'reauth_required', exitCode: 1 });
  assert.deepEqual(world.violations, []);
});

test('a revoke OpenAI does not confirm is reported, and the run does not fail', async () => {
  const { world, run } = await workerWorld();
  world.auth.revokeFail = { status: 503 };
  assert.deepEqual(await run({ revoke: true }), { outcome: 'revoke_failed', reason: 'revoke_503', exitCode: 0 });
  world.auth.revokeFail = 'network';
  assert.deepEqual(await run({ revoke: true }), { outcome: 'revoke_failed', reason: 'network', exitCode: 0 });
  assert.deepEqual(world.auth.revoked, []);
});
