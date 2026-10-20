import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, quiet, watch, DISPATCHES, NEAR_PERCENT, QUIET_MS } from '../src/cli/watch.ts';
import type { PassFiles } from '../src/cli/watch.ts';
import { WatchFiles } from '../src/cli/watch-files.ts';
import type { WatchState } from '../src/cli/watch-files.ts';
import type { Quota } from '../src/chatgpt/client.ts';
import type { Session } from '../src/chatgpt/session.ts';
import { setup } from '../src/cli/setup.ts';
import { status } from '../src/cli/status.ts';
import { shortTime } from '../src/cli/overview.ts';
import { window } from './support/fake-world.ts';
import type { FakeWorld } from './support/fake-world.ts';
import { cliWorld } from './support/cli-world.ts';
import { FILES } from '../src/worker/layout.ts';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const weekly = (usedPercent: number, renewsAt: number): Quota => ({ usedPercent, exhausted: usedPercent >= 100, renewsAt });

test('decide asks for a check per exhausted weekly window, and repeats it while the window stays exhausted', () => {
  const renewsAt = NOW + 2 * DAY;
  assert.equal(decide(weekly(99, renewsAt), {}, NOW).dispatch, null);
  const first = decide(weekly(100, renewsAt), { lastPass: { at: NOW - 2 * MINUTE, outcome: 'idle' } }, NOW);
  assert.equal(first.dispatch, 'first');
  assert.deepEqual(first.nextState, { lastPass: { at: NOW - 2 * MINUTE, outcome: 'idle' }, dispatched: { renewsAt, at: NOW, count: 1 } });

  const asked = first.nextState;
  assert.equal(decide(weekly(100, renewsAt + 3_000), asked, NOW + 2 * MINUTE).dispatch, null, 'the same window read again');
  assert.equal(decide(weekly(100, renewsAt - 3_000), asked, NOW + 14 * MINUTE).dispatch, null);
  const second = decide(weekly(100, renewsAt), asked, NOW + 15 * MINUTE);
  assert.equal(second.dispatch, 'repeat');
  assert.deepEqual(second.nextState.dispatched, { renewsAt, at: NOW + 15 * MINUTE, count: 2 });
  assert.equal(decide(weekly(100, renewsAt), second.nextState, NOW + 74 * MINUTE).dispatch, null);
  const third = decide(weekly(100, renewsAt), second.nextState, NOW + 75 * MINUTE);
  assert.equal(third.dispatch, 'repeat');
  assert.equal(third.nextState.dispatched?.count, DISPATCHES);
  assert.equal(decide(weekly(100, renewsAt), third.nextState, NOW + DAY).dispatch, null, `at most ${DISPATCHES} runs per window`);

  const next = decide(weekly(100, NOW + 7 * DAY), third.nextState, NOW + DAY);
  assert.equal(next.dispatch, 'first', 'a reset renewed the window and it ran out again');
  assert.deepEqual(next.nextState.dispatched, { renewsAt: NOW + 7 * DAY, at: NOW + DAY, count: 1 });
});

test('decide takes a window asked for by an older watch.json, without a count, as asked once', () => {
  const renewsAt = NOW + 2 * DAY;
  const old = { dispatched: { renewsAt, at: NOW } };
  assert.equal(decide(weekly(100, renewsAt), old, NOW + 2 * MINUTE).dispatch, null);
  assert.equal(decide(weekly(100, renewsAt), old, NOW + 15 * MINUTE).nextState.dispatched?.count, 2);
});

test('decide does not ask for a window that has already renewed or a plan without a weekly window', () => {
  assert.deepEqual(decide(weekly(100, NOW - MINUTE), {}, NOW), { dispatch: null, nextState: {} });
  assert.deepEqual(decide(null, {}, NOW), { dispatch: null, nextState: {} });
});

test('quiet leaves the quota unread for ten minutes far from its end and after the last run for a window', () => {
  const renewsAt = NOW + 2 * DAY;
  const read = (usedPercent: number | null, at = NOW) => ({ at, usedPercent, renewsAt: usedPercent === null ? null : renewsAt });
  assert.equal(quiet({}, NOW), false, 'nothing read yet');
  assert.equal(quiet({ read: read(NEAR_PERCENT - 1) }, NOW + QUIET_MS - 1), true);
  assert.equal(quiet({ read: read(NEAR_PERCENT - 1) }, NOW + QUIET_MS), false);
  assert.equal(quiet({ read: read(null) }, NOW + 2 * MINUTE), true, 'a plan without a weekly window');
  assert.equal(quiet({ read: read(NEAR_PERCENT) }, NOW + 2 * MINUTE), false, 'near the end every pass reads');
  assert.equal(quiet({ read: read(100), dispatched: { renewsAt, at: NOW, count: 1 } }, NOW + 2 * MINUTE), false);
  assert.equal(quiet({ read: read(100), dispatched: { renewsAt, at: NOW, count: DISPATCHES } }, NOW + 2 * MINUTE), true);
  assert.equal(quiet({ read: read(100), dispatched: { renewsAt: renewsAt - 7 * DAY, at: NOW, count: DISPATCHES } }, NOW + 2 * MINUTE), false,
    'all runs went to an earlier window');
  assert.equal(quiet({ read: read(10, NOW + HOUR) }, NOW), false, 'a read from the future');
  // @ts-expect-error: watch.json of another shape.
  assert.equal(quiet({ read: { at: NOW, usedPercent: '10' } }, NOW + MINUTE), false);
});

// Watch files in memory; events lists the writes in order. state is watch.json as it is on
// disk, of any shape.
interface MemoryFiles extends PassFiles { session: Session | null; state: WatchState | Record<string, unknown>; events: string[] }
function memoryFiles(session: Session | null = null): MemoryFiles {
  const files: Omit<MemoryFiles, keyof PassFiles> = { session, state: {}, events: [] };
  return Object.assign(files, {
    readSession: async () => files.session,
    writeSession: async (next: Session) => { files.events.push('session'); files.session = next; },
    readState: async () => files.state,
    writeState: async (next: WatchState) => { files.events.push('state'); files.state = next; },
  });
}

// An installed worker whose runs stay queued, and this Mac with its own computer session.
// With weekly, setup turns the weekly rule on and logs this Mac in itself, and the worker's
// runs execute.
async function mac({ session = true, weekly = false } = {}) {
  const env = await cliWorld();
  const { code, io } = await env.run(setup, { answers: weekly ? ['1', '2', ''] : ['1', ''] });
  assert.equal(code, 0, io.output());
  const { world } = env;
  if (!weekly) world.github.runner = () => null;
  const repo = world.github.repo();
  assert.ok(repo);
  // With weekly the passes go through this Mac's own watch files, and files stay unused.
  const files = memoryFiles(session && !weekly ? world.login() : null);
  const lines: string[] = [], trial = repo.runs.length;
  const pass = () => watch({ fetch: world.fetch, keychain: env.keychain, files: weekly ? env.mac.files : files,
    log: line => lines.push(line), now: () => world.now });
  // The runs after setup's trial run.
  const dispatches = () => repo.runs.slice(0, repo.runs.length - trial).filter(run => run.event === 'workflow_dispatch');
  return { ...env, repo, files, lines, pass, dispatches };
}

const exhaust = (world: FakeWorld, renewsAt = world.now + 2 * DAY) => { world.chatgpt.secondary = window(604800, 100, renewsAt); };

test('watch starts one worker run per exhausted window and none while the quota lasts', async () => {
  const { world, files, lines, pass, dispatches } = await mac();
  assert.equal(await pass(), 0);
  assert.equal(dispatches().length, 0);
  assert.deepEqual(files.state.lastPass, { at: world.now, outcome: 'idle' });

  const renewsAt = world.now + 2 * DAY;
  exhaust(world, renewsAt);
  world.advance(2 * MINUTE);
  assert.equal(await pass(), 0);
  assert.equal(dispatches().length, 0, 'far from its end the quota is read every ten minutes');
  world.advance(8 * MINUTE);
  assert.equal(await pass(), 0);
  assert.equal(dispatches().length, 1);
  assert.deepEqual(dispatches()[0]?.inputs, { apply_now: '' });
  assert.deepEqual(files.state.dispatched, { renewsAt, at: world.now, count: 1 });

  world.advance(2 * MINUTE);
  await pass();
  assert.equal(dispatches().length, 1, 'the same window does not start a second run right away');

  // A reset renewed the window, and it ran out again.
  exhaust(world, world.now + 7 * DAY);
  world.advance(2 * MINUTE);
  await pass();
  assert.equal(dispatches().length, 2);
  assert.deepEqual(lines, ['idle', 'quiet', 'dispatched', 'idle', 'dispatched']);
  assert.deepEqual(world.violations, []);
  assert.deepEqual(world.github.violations, []);
});

// ADR-0005, exhaustion condition: a day of the agent's passes every 2 minutes, with
// /wham/usage answering 429 now and then, the weekly quota running out mid-day and the
// worker run applying a reset as on GitHub.
test('a day of passes: the reset lands within minutes of the weekly quota running out, 429s only delay it', async () => {
  const env = await mac({ weekly: true });
  const { world, lines, pass, dispatches } = env;
  const refusedAt = world.now + 9 * HOUR + MINUTE, renewsAt = refusedAt + 2 * DAY;
  const start = world.now, reads = () => world.requests.filter(r => r.path.endsWith('/wham/usage')).length;
  let refusalLine: number | null = null, throttled = 0;
  for (let n = 0; n < 720; n++) {
    world.advance(2 * MINUTE);
    if (refusalLine === null && world.now >= refusedAt) {
      exhaust(world, renewsAt);
      refusalLine = lines.length;
    }
    // The weekly quota climbs through the morning towards its end.
    if (refusalLine === null) world.chatgpt.secondary = window(604800, Math.floor(40 + 59 * (world.now - start) / (refusedAt - start)), renewsAt);
    // Every 7th pass is throttled, and so is the first one after the client was refused.
    const throttle = n % 7 === 0 || lines.length === refusalLine;
    world.chatgpt.fail = throttle ? { status: 429 } : null;
    const before = reads();
    assert.equal(await pass(), 0);
    throttled += Number(throttle && reads() > before);
  }
  world.chatgpt.fail = null;

  assert.equal(dispatches().length, 1, 'one worker run for the day');
  const [run] = dispatches();
  assert.ok(run && refusalLine !== null);
  const startedAt = Date.parse(run.created_at);
  assert.equal(lines[refusalLine], 'transient_error: wham_429');
  assert.equal(lines[refusalLine + 1], 'dispatched');
  assert.ok(startedAt - refusedAt <= 4 * MINUTE, `dispatch ${(startedAt - refusedAt) / MINUTE} min after the refusal`);
  assert.equal(run.conclusion, 'success');
  assert.equal(world.chatgpt.redemptions.length, 1);
  assert.equal(world.chatgpt.secondary?.used_percent, 0, 'the reset renewed the weekly window');
  assert.ok(lines.slice(refusalLine + 2).every(line => ['idle', 'quiet', 'transient_error: wham_429'].includes(line)));
  assert.ok(reads() < 720 / 2, `${reads()} reads in a day`);
  assert.equal(lines.filter(line => line === 'transient_error: wham_429').length, throttled);

  const { code, io } = await env.run(status);
  assert.equal(code, 0);
  assert.ok(io.lines.includes(`  применён reset-b ${shortTime(startedAt, 'UTC')} — кончился недельный лимит`), io.output());
  assert.deepEqual(world.violations, []);
  assert.deepEqual(world.github.violations, []);
});

test('watch without a computer session calls neither ChatGPT nor GitHub', async () => {
  const { world, files, lines, pass } = await mac({ session: false });
  exhaust(world);
  const chatgpt = world.requests.length, github = world.github.requests.length;
  assert.equal(await pass(), 0);
  assert.equal(world.requests.length, chatgpt);
  assert.equal(world.github.requests.length, github);
  assert.deepEqual(lines, ['no_session']);
  assert.equal(files.state.dispatched, undefined);
});

test('watch saves the refreshed session before it reads the quota', async () => {
  const { world, files, pass } = await mac();
  const old = files.session;
  assert.ok(old);
  const { exp }: { exp: number } = JSON.parse(Buffer.from(old.accessToken.split('.')[1] ?? '', 'base64url').toString());
  world.advance(exp * 1000 - world.now - 5 * MINUTE);
  const reads = () => world.requests.filter(r => r.path.endsWith('/wham/usage')).length;
  const before = reads();
  let readsAtSave: number | null = null;
  const write = files.writeSession;
  files.writeSession = async next => { readsAtSave = reads(); await write(next); };
  await pass();
  assert.equal(readsAtSave, before);
  const renewed = files.session;
  assert.ok(renewed);
  assert.notEqual(renewed.refreshToken, old.refreshToken);
  assert.equal(renewed.refreshToken, world.auth.current?.refresh);
  assert.deepEqual(files.events, ['session', 'state']);
  assert.equal(reads(), before + 1);
});

test('a lost computer session is marked, and later passes leave ChatGPT alone', async () => {
  const { world, files, lines, pass } = await mac();
  world.endSession('refresh_token_invalidated');
  exhaust(world);
  await pass();
  assert.equal(files.state.sessionLost, true);
  const requests = world.requests.length;
  world.advance(2 * MINUTE);
  assert.equal(await pass(), 0);
  assert.equal(world.requests.length, requests);
  assert.deepEqual(lines, ['reauth_required: access_rejected', 'reauth_required']);
});

test('a transient ChatGPT failure or a failed dispatch leaves the window unrecorded, and the next pass retries', async () => {
  const { world, files, lines, pass, dispatches } = await mac();
  exhaust(world);
  world.chatgpt.fail = { status: 429 };
  await pass();
  world.chatgpt.fail = null;
  world.github.fail = (method, path) => path.endsWith('/dispatches') ? new Response('{}', { status: 500 }) : null;
  world.advance(2 * MINUTE);
  await pass();
  assert.equal(files.state.dispatched, undefined);
  assert.equal(dispatches().length, 0);

  world.github.fail = null;
  world.advance(2 * MINUTE);
  await pass();
  assert.equal(dispatches().length, 1);
  assert.deepEqual(lines, ['transient_error: wham_429', 'github_error: dispatch_500', 'dispatched']);
});

test('watch without a GitHub token, or with one GitHub refuses, logs in nowhere and skips the pass', async () => {
  const { world, keychain, files, lines, pass, dispatches } = await mac();
  exhaust(world);
  const token = keychain.entries.get('github') ?? '';
  keychain.entries.delete('github');
  const github = world.github.requests.length;
  assert.equal(await pass(), 0);
  assert.equal(world.github.requests.length, github, 'no device login');

  keychain.entries.set('github', 'gho_revoked');
  world.advance(2 * MINUTE);
  assert.equal(await pass(), 0);
  assert.ok(world.github.requests.slice(github).every(r => r.path === '/user'));
  assert.equal(files.state.dispatched, undefined);

  keychain.entries.set('github', token);
  world.advance(2 * MINUTE);
  await pass();
  assert.equal(dispatches().length, 1);
  assert.deepEqual(lines, ['no_github_token', 'github_error: unauthorized', 'dispatched']);
});

test('watch exits with 0 whatever breaks', async () => {
  const { files, lines, pass } = await mac();
  files.readSession = async () => { throw new TypeError('disk'); };
  files.writeState = async () => { throw new Error('read-only'); };
  assert.equal(await pass(), 0);
  assert.deepEqual(lines, ['error: TypeError (watch.json not saved)']);
});

test('watch files keep the session private and read a broken file as empty', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'watch-files-')), 'aures');
  const files = new WatchFiles({ dir });
  assert.equal(await files.readSession(), null);
  assert.deepEqual(await files.readState(), {});

  const session = { accessToken: 'a'.repeat(1900), idToken: 'i'.repeat(1900), refreshToken: 'r'.repeat(211), accountId: 'acc' };
  await files.writeSession(session);
  assert.deepEqual(await files.readSession(), session);
  assert.equal((await stat(join(dir, 'chatgpt-session.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);

  await files.writeState({ sessionLost: true });
  assert.deepEqual(await files.readState(), { sessionLost: true });
  await writeFile(join(dir, 'watch.json'), '{"sessionLost": tr');
  assert.deepEqual(await files.readState(), {});
  await writeFile(join(dir, 'chatgpt-session.json'), JSON.stringify({ accessToken: 'a' }));
  assert.equal(await files.readSession(), null);
});

test('watch files of another shape read as none: no session, an empty watch.json, no language', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'watch-files-')), 'aures');
  const files = new WatchFiles({ dir });
  await files.writeState({});
  for (const text of ['[]', 'null', '"text"', '7']) {
    await writeFile(join(dir, 'watch.json'), text);
    await writeFile(join(dir, 'chatgpt-session.json'), text);
    await writeFile(join(dir, 'settings.json'), text);
    assert.deepEqual(await files.readState(), {}, text);
    assert.equal(await files.readSession(), null, text);
    assert.equal(await files.readLanguage(), null, text);
  }
  const session = { accessToken: 'a', idToken: 'i', refreshToken: 'r', accountId: 'acc' };
  for (const broken of [{ ...session, refreshToken: '' }, { ...session, accountId: 7 }, { ...session, accessToken: null }]) {
    await writeFile(join(dir, 'chatgpt-session.json'), JSON.stringify(broken));
    assert.equal(await files.readSession(), null, JSON.stringify(broken));
  }
});

test('a pass reads a watch.json with fields of another type as no window asked for', async () => {
  const { world, files, lines, pass, dispatches } = await mac();
  const renewsAt = world.now + 2 * DAY;
  exhaust(world, renewsAt);
  files.state = { dispatched: { renewsAt: String(renewsAt) }, sessionLost: 0 };
  await pass();
  assert.deepEqual(lines, ['dispatched']);
  assert.equal(dispatches().length, 1);
  assert.deepEqual(files.state.dispatched, { renewsAt, at: world.now, count: 1 });
});

test('a window the worker run did not renew gets a second and a third run, then none', async () => {
  const { world, files, lines, pass, dispatches } = await mac();
  exhaust(world);
  for (let n = 0; n < 60; n++) {
    await pass();
    world.advance(2 * MINUTE);
  }
  assert.equal(dispatches().length, DISPATCHES);
  assert.deepEqual(lines.filter(line => line.startsWith('dispatched')), ['dispatched', 'dispatched (2 of 3)', 'dispatched (3 of 3)']);
  assert.equal(lines.indexOf('dispatched (2 of 3)'), lines.indexOf('dispatched') + 8, 'fifteen minutes later, on the eighth pass');
  assert.partialDeepStrictEqual(files.state, { dispatched: { count: DISPATCHES } });
  assert.ok(lines.slice(lines.indexOf('dispatched (3 of 3)') + 1).includes('quiet'), 'the last run for the window quiets the reads');
});

test('no repeat run when the worker summary lists no resets, and the window is left alone', async () => {
  const { world, repo, files, lines, pass, dispatches } = await mac();
  exhaust(world);
  await pass();
  assert.equal(dispatches().length, 1);
  world.github.write(repo, FILES.summary, JSON.stringify({ ...JSON.parse(world.github.text(repo, FILES.summary)), resets: [] }));
  for (let n = 0; n < 60; n++) {
    world.advance(2 * MINUTE);
    await pass();
  }
  assert.equal(dispatches().length, 1);
  assert.equal(lines.filter(line => line === 'no_resets').length, 1);
  assert.partialDeepStrictEqual(files.state, { dispatched: { count: DISPATCHES } });
});
