import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../src/cli/setup.ts';
import { applyNow } from '../src/cli/apply-now.ts';
import { openWorker } from '../src/cli/active-worker.ts';
import type { Worker } from '../src/cli/active-worker.ts';
import { readJournal } from '../src/cli/journal.ts';
import type { JournalEntry } from '../src/cli/journal.ts';
import { cliWorld } from './support/cli-world.ts';
import type { CliWorld } from './support/cli-world.ts';
import type { CliFakeWorld } from './support/cli-world.ts';
import type { FakeRun } from './support/fake-github.ts';

const HOUR = 3600_000, MINUTE = 60_000;

// The worker of an install the user made, opened the way the commands open it.
async function opened(env: CliWorld): Promise<Worker> {
  let worker: Worker | null = null;
  const { code } = await env.run(async options => {
    worker = await openWorker(options, null);
    return 0;
  });
  assert.equal(code, 0);
  assert.ok(worker);
  return worker;
}

// A worker installed on the platform the user picked: GitHub with its trial run, Google with
// its login and its trial run.
async function installed(platform: 'github' | 'google'): Promise<CliWorld & { worker: Worker }> {
  const env = await cliWorld();
  const { code, io } = await env.run(setup, { answers: [platform === 'github' ? '1' : '2', ''] });
  assert.equal(code, 0, io.output());
  return { ...env, worker: await opened(env) };
}

// A run the workflow has already made, as GitHub lists it: the journal reads it back.
const made = (world: CliFakeWorld, id: number, over: Partial<FakeRun>): FakeRun => {
  const at = new Date(world.now).toISOString();
  return { id, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: at,
    run_started_at: at, updated_at: at, html_url: `https://github.com/octo-fake/codex-auto-resets-worker/actions/runs/${id}`,
    display_title: 'Check from this Mac', inputs: {}, log: `${at} idle\n`, ...over };
};

// How many job log reads the journal has made of GitHub so far: every read of a run's log asks
// for the run's jobs first.
const logReads = (world: CliFakeWorld): number =>
  world.github.requests.filter(r => /\/actions\/runs\/\d+\/jobs$/.test(r.path)).length;

// The shape of one entry, as both platforms must give it: the fields, their kinds and the run kind.
const shape = ({ at, kind, outcome, durationMs }: JournalEntry): unknown =>
  ({ at: typeof at, kind, outcome, durationMs: typeof durationMs });

test('the journal gives entries of one shape on both platforms, oldest first', async () => {
  // Google: setup left a login and a trial run, the schedule ran once more before the poll.
  const google = await cliWorld();
  const setupDone = await google.run(setup, { answers: ['2', ''] });
  assert.equal(setupDone.code, 0, setupDone.io.output());
  const gas = google.world.google.project()?.gas;
  assert.ok(gas, 'setup on Google deploys the worker');
  google.world.advance(5 * MINUTE);
  gas.tick();
  const googleWorker = await opened(google);

  const onGoogle = await readJournal(googleWorker, { now: () => google.world.now });
  assert.deepEqual(onGoogle.entries.map(entry => entry.kind), ['login', 'trial', 'scheduled']);

  const github = await installed('github');
  github.world.advance(3 * HOUR);
  await github.world.github.schedule();
  const onGitHub = await readJournal(github.worker, { now: () => github.world.now });
  assert.deepEqual(onGitHub.entries.map(entry => entry.kind), ['trial', 'scheduled']);

  // The trial runs and the scheduled ones of the two platforms are entries of one shape.
  assert.deepEqual(shape(onGoogle.entries[1] ?? fail()), shape(onGitHub.entries[0] ?? fail()));
  assert.deepEqual(shape(onGoogle.entries[2] ?? fail()), shape(onGitHub.entries[1] ?? fail()));
  assert.deepEqual(onGoogle.entries.map(entry => entry.outcome), ['idle', 'idle', 'idle']);
  assert.deepEqual(onGitHub.entries.map(entry => entry.outcome), ['idle', 'idle']);
  for (const entries of [onGoogle.entries, onGitHub.entries]) {
    assert.ok(entries.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0));
    assert.ok(entries.every((entry, i, all) => i === 0 || Date.parse(all[i - 1]?.at ?? '') <= Date.parse(entry.at)),
      'the entries read oldest first, as the ring buffer on Google');
  }
  assert.deepEqual(google.world.google.violations, []);
  assert.deepEqual(github.world.github.violations, []);
});

function fail(): never { throw new Error('no entry'); }

test('GitHub: the journal tells a scheduled run, the Mac, a trial run and «Применить сейчас» apart', async () => {
  const github = await installed('github');
  const { world, worker } = github;
  world.advance(3 * HOUR);
  await world.github.schedule();
  world.advance(2 * HOUR);
  await world.github.dispatch();
  world.advance(2 * HOUR);
  const { code, io } = await github.run(applyNow, { answers: ['1', 'y'] });
  assert.equal(code, 0, io.output());

  const journal = await readJournal(worker, { now: () => world.now });
  assert.deepEqual(journal.entries.map(entry => entry.kind), ['trial', 'scheduled', 'mac', 'apply_now']);
  assert.deepEqual(journal.entries.map(entry => entry.outcome), ['idle', 'idle', 'idle', 'applied']);
  assert.deepEqual(world.github.violations, []);
  assert.deepEqual(world.violations, []);
});

test('GitHub: a run of an older workflow reads as the Mac\'s, a revoke run is no worker run', async () => {
  const github = await installed('github');
  const { world, worker } = github;
  const repo = world.github.repo();
  assert.ok(repo);
  const started = new Date(world.now - 10 * MINUTE).toISOString();
  // The workflow before run-name: GitHub titled the run with the commit message.
  repo.runs.unshift(made(world, 9501, { display_title: 'Worker tick: idle', run_started_at: started,
    created_at: started, updated_at: new Date(world.now - 10 * MINUTE + 42_000).toISOString() }));
  // `uninstall` dispatches a revoke run; the worker on Google journals no revoke either.
  repo.runs.unshift(made(world, 9502, { display_title: 'Revoke session', log: `${new Date(world.now).toISOString()} revoked\n` }));

  const journal = await readJournal(worker, { now: () => world.now });
  assert.deepEqual(journal.entries.map(entry => [entry.kind, entry.outcome]), [['trial', 'idle'], ['mac', 'idle']]);
  assert.equal(journal.entries[1]?.durationMs, 42_000);
});

test('the time the platform took to answer comes back with the entries', async () => {
  const github = await installed('github');
  const before = github.world.fetch;
  github.world.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (/\/actions\/workflows\/[^/]+\/runs/.test(url)) github.world.advance(2100);
    return before(input, init);
  };
  const worker = await opened(github);
  const read = await readJournal(worker, { now: () => github.world.now });
  assert.equal(read.responseMs, 2100);
  assert.equal(read.readAt, github.world.now - 2100);
  assert.ok(read.entries.length);

  const google = await installed('google');
  const gas = google.world.google.project()?.gas;
  assert.ok(gas);
  const earlier = google.world.fetch;
  google.world.fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://script.google.com/macros/') && (init.method ?? 'GET') === 'POST') google.world.advance(1500);
    return earlier(input, init);
  };
  const woken = await opened(google);
  await readJournal(woken, { now: () => google.world.now }); // the opening status, not a poll yet
  const polled = await readJournal(woken, { now: () => google.world.now });
  assert.equal(polled.responseMs, 1500);
  assert.equal(polled.readAt, google.world.now - 1500);
  assert.deepEqual(polled.entries.map(entry => entry.kind), ['login', 'trial']);
});

test('GitHub: the journal reads the latest 30 runs and their logs, not the whole history', async () => {
  const github = await installed('github');
  const { world, worker } = github;
  const repo = world.github.repo();
  assert.ok(repo);
  // 35 runs of the workflow, an hour apart, older than the trial run of setup.
  for (let i = 35; i >= 1; i--) {
    const at = new Date(world.now - i * HOUR).toISOString();
    repo.runs.unshift(made(world, 9600 + i, { display_title: 'Check from this Mac',
      created_at: at, run_started_at: at, updated_at: at }));
  }
  const jobs = world.github.requests.filter(r => /\/actions\/runs\/\d+\/jobs$/.test(r.path)).length;
  const journal = await readJournal(worker, { now: () => world.now });
  assert.equal(journal.entries.length, 30);
  assert.equal(journal.entries.filter(entry => entry.kind === 'mac').length, 30);
  assert.equal(world.github.requests.filter(r => /\/actions\/runs\/\d+\/jobs$/.test(r.path)).length - jobs, 30);
});

test('GitHub: the log of a completed run is read once while the worker stays open, a new run\'s once', async () => {
  const github = await installed('github');
  const { world, worker } = github;
  const repo = world.github.repo();
  assert.ok(repo);
  repo.runs.unshift(made(world, 9701, {}));

  let before = logReads(world);
  const first = await readJournal(worker, { now: () => world.now });
  assert.equal(logReads(world) - before, 2); // the trial run of setup and the made one, once each
  assert.deepEqual(first.entries.map(entry => [entry.kind, entry.outcome]), [['trial', 'idle'], ['mac', 'idle']]);

  // The same completed runs again: not one job log read.
  before = logReads(world);
  const second = await readJournal(worker, { now: () => world.now });
  assert.equal(logReads(world) - before, 0);
  assert.deepEqual(second.entries, first.entries);

  // A new completed run: exactly one read, its own.
  repo.runs.unshift(made(world, 9702, {}));
  before = logReads(world);
  const third = await readJournal(worker, { now: () => world.now });
  assert.equal(logReads(world) - before, 1);
  assert.deepEqual(third.entries.map(entry => [entry.kind, entry.outcome]),
    [['trial', 'idle'], ['mac', 'idle'], ['mac', 'idle']]);
});

test('GitHub: a log that did not read is kept out of the cache and read again on the next poll', async () => {
  const github = await installed('github');
  const { world, worker } = github;
  // The first job log read after the run completed answers 404, as before the log is ready.
  world.github.logDelay = 1;

  let before = logReads(world);
  const failed = await readJournal(worker, { now: () => world.now });
  assert.equal(logReads(world) - before, 1);
  assert.deepEqual(failed.entries.map(entry => entry.outcome), [null]); // the log did not read

  before = logReads(world);
  const read = await readJournal(worker, { now: () => world.now });
  assert.equal(logReads(world) - before, 1); // the read that failed is repeated
  assert.deepEqual(read.entries.map(entry => entry.outcome), ['idle']);

  before = logReads(world);
  const again = await readJournal(worker, { now: () => world.now });
  assert.equal(logReads(world) - before, 0); // the read that answered is kept
  assert.deepEqual(again.entries, read.entries);
});

test('GitHub: a run still going is read on every poll until it completes, with the entries of no cache', async () => {
  const github = await installed('github');
  const { world, worker } = github;
  const repo = world.github.repo();
  assert.ok(repo);
  const started = new Date(world.now - 5 * MINUTE).toISOString();
  const going = made(world, 9703, { status: 'in_progress', conclusion: null, log: '',
    run_started_at: started, created_at: started });
  repo.runs.unshift(going);

  let before = logReads(world);
  const first = await readJournal(worker, { now: () => world.now });
  assert.equal(logReads(world) - before, 1); // the completed trial run of setup only
  assert.deepEqual(first.entries.map(entry => entry.outcome), ['idle', null]);

  // The run completes; its log is read once, and no more after that.
  world.advance(2 * MINUTE);
  Object.assign(going, { status: 'completed', conclusion: 'success',
    log: `${new Date(world.now).toISOString()} applied\n`, updated_at: new Date(world.now).toISOString() });
  before = logReads(world);
  const second = await readJournal(worker, { now: () => world.now });
  assert.equal(logReads(world) - before, 1);
  assert.deepEqual(second.entries.map(entry => entry.outcome), ['idle', 'applied']);
  before = logReads(world);
  const third = await readJournal(worker, { now: () => world.now });
  assert.equal(logReads(world) - before, 0);
  assert.deepEqual(third.entries, second.entries);

  // A worker opened just now reads with no cache; the entries are the same.
  const fresh = await readJournal(await opened(github), { now: () => world.now });
  assert.deepEqual(fresh.entries, third.entries);
});
