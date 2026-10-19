import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, watch } from '../src/cli/watch.mjs';
import { WatchFiles } from '../src/cli/watch-files.mjs';
import { setup } from '../src/cli/setup.mjs';
import { window } from './support/fake-world.mjs';
import { cliWorld } from './support/cli-world.mjs';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const weekly = (usedPercent, renewsAt) => ({ usedPercent, exhausted: usedPercent >= 100, renewsAt });

test('decide asks for one check per exhausted weekly window', () => {
  const renewsAt = NOW + 2 * DAY;
  assert.equal(decide(weekly(99, renewsAt), {}, NOW).dispatch, false);
  const first = decide(weekly(100, renewsAt), { lastPass: { at: NOW - 2 * MINUTE, outcome: 'idle' } }, NOW);
  assert.equal(first.dispatch, true);
  assert.deepEqual(first.nextState, { lastPass: { at: NOW - 2 * MINUTE, outcome: 'idle' }, dispatched: { renewsAt, at: NOW } });

  const asked = first.nextState;
  assert.equal(decide(weekly(100, renewsAt + 3_000), asked, NOW + 2 * MINUTE).dispatch, false, 'the same window read again');
  assert.equal(decide(weekly(100, renewsAt - 3_000), asked, NOW + 2 * MINUTE).dispatch, false);
  const next = decide(weekly(100, NOW + 7 * DAY), asked, NOW + HOUR);
  assert.equal(next.dispatch, true, 'a reset renewed the window and it ran out again');
  assert.equal(next.nextState.dispatched.renewsAt, NOW + 7 * DAY);
});

test('decide does not ask for a window that has already renewed or a plan without a weekly window', () => {
  assert.deepEqual(decide(weekly(100, NOW - MINUTE), {}, NOW), { dispatch: false, nextState: {} });
  assert.deepEqual(decide(null, {}, NOW), { dispatch: false, nextState: {} });
});

// Watch files in memory; events lists the writes in order.
function memoryFiles(session = null) {
  const files = { session, state: {}, events: [] };
  return Object.assign(files, {
    readSession: async () => files.session,
    writeSession: async next => { files.events.push('session'); files.session = next; },
    readState: async () => files.state,
    writeState: async next => { files.events.push('state'); files.state = next; },
  });
}

// An installed worker whose runs stay queued, and this Mac with its own computer session.
async function mac({ session = true } = {}) {
  const env = await cliWorld();
  const { code, io } = await env.run(setup, { answers: [''] });
  assert.equal(code, 0, io.output());
  const { world } = env;
  world.github.runner = () => null;
  const repo = world.github.repo();
  const files = memoryFiles(session ? world.login() : null);
  const lines = [], trial = repo.runs.length;
  const pass = () => watch({ fetch: world.fetch, keychain: env.keychain, files, log: line => lines.push(line), now: () => world.now });
  // The runs after setup's trial run.
  const dispatches = () => repo.runs.slice(0, repo.runs.length - trial).filter(run => run.event === 'workflow_dispatch');
  return { ...env, repo, files, lines, pass, dispatches };
}

const exhaust = (world, renewsAt = world.now + 2 * DAY) => { world.chatgpt.secondary = window(604800, 100, renewsAt); };

test('watch starts one worker run per exhausted window and none while the quota lasts', async () => {
  const { world, files, lines, pass, dispatches } = await mac();
  assert.equal(await pass(), 0);
  assert.equal(dispatches().length, 0);
  assert.deepEqual(files.state.lastPass, { at: world.now, outcome: 'idle' });

  const renewsAt = world.now + 2 * DAY;
  exhaust(world, renewsAt);
  world.advance(2 * MINUTE);
  assert.equal(await pass(), 0);
  assert.equal(dispatches().length, 1);
  assert.deepEqual(dispatches()[0].inputs, { apply_now: '' });
  assert.deepEqual(files.state.dispatched, { renewsAt, at: world.now });

  world.advance(2 * MINUTE);
  await pass();
  assert.equal(dispatches().length, 1, 'the same window does not start a second run');

  // A reset renewed the window, and it ran out again.
  exhaust(world, world.now + 7 * DAY);
  world.advance(2 * MINUTE);
  await pass();
  assert.equal(dispatches().length, 2);
  assert.deepEqual(lines, ['idle', 'dispatched', 'idle', 'dispatched']);
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
  const exp = JSON.parse(Buffer.from(old.accessToken.split('.')[1], 'base64url')).exp * 1000;
  world.advance(exp - world.now - 5 * MINUTE);
  const reads = () => world.requests.filter(r => r.path.endsWith('/wham/usage')).length;
  const before = reads();
  let readsAtSave = null;
  const write = files.writeSession;
  files.writeSession = async next => { readsAtSave = reads(); await write(next); };
  await pass();
  assert.equal(readsAtSave, before);
  assert.notEqual(files.session.refreshToken, old.refreshToken);
  assert.equal(files.session.refreshToken, world.auth.current.refresh);
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
  const token = keychain.entries.get('github');
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
  const dir = join(await mkdtemp(join(tmpdir(), 'watch-files-')), 'codex-auto-resets');
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
