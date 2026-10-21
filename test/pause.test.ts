// Пауза воркера (issue 12, ADR-0007): the schedule goes off and comes back on both platforms,
// the session and the state stay, install.json keeps the pause in `paused`, and every command
// that runs the worker leaves the schedule off while the pause holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../src/cli/setup.ts';
import { status } from '../src/cli/status.ts';
import { applyNow } from '../src/cli/apply-now.ts';
import { upgrade } from '../src/cli/upgrade.ts';
import { pauseWorker, unpauseWorker } from '../src/cli/pause.ts';
import { FILES, STATE_KEY_SECRET, TRIAL_INPUT } from '../src/worker/layout.ts';
import { openState } from '../src/worker/state-file.ts';
import { cliWorld } from './support/cli-world.ts';
import { bundle } from './support/fake-apps-script.ts';

const NEW_WORKER = '// fake worker bundle, next version\n';
// The email of the ChatGPT account the setup's sign-in gave, which the install record keeps.
const ACCOUNTS = { chatgpt: 'fake@example.invalid' };

// A worker installed on GitHub by setup with the default rules: resets reset-a (in 5 days) and
// reset-b (in 2 days 3 hours).
async function onGitHub() {
  const env = await cliWorld();
  const { code, io } = await env.run(setup, { answers: ['1', ''] });
  assert.equal(code, 0, io.output());
  const repo = env.world.github.repo();
  assert.ok(repo);
  const state = () => openState(env.world.github.text(repo, FILES.state), env.world.github.secret(repo, STATE_KEY_SECRET));
  return { ...env, repo, state };
}

// The same on Google Apps Script.
async function onGoogle() {
  const env = await cliWorld();
  const { code, io } = await env.run(setup, { answers: ['2', ''] });
  assert.equal(code, 0, io.output());
  const project = env.world.google.project();
  assert.ok(project?.gas);
  const gas = project.gas;
  const property = (key: string): unknown => JSON.parse(gas.properties.get(key) ?? 'null');
  const state = () => property('state') as { session: { refreshToken: string } };
  const journal = () => (property('journal') as { kind: string; outcome: string }[]).slice();
  // Only the web app is asked: no Google sign-in, no Apps Script API, no GitHub.
  const requests = env.world.google.requests.length;
  const onlyWebApp = () => {
    assert.deepEqual(env.world.google.requests.slice(requests).filter(r => !r.url.includes('/macros/')), []);
    assert.equal(env.world.github.requests.length, 0);
    assert.deepEqual(env.world.google.violations, []);
  };
  return { ...env, project, gas, property, state, journal, onlyWebApp };
}

test('pause on GitHub takes the schedule off and keeps the worker; unpause brings the schedule back', async () => {
  const { world, repo, run, state, mac } = await onGitHub();
  const session = state().session, runs = repo.runs.length;

  const paused = await run(pauseWorker);
  assert.equal(paused.code, 0, paused.io.output());
  assert.match(paused.io.lines.at(-1) ?? '', /^Воркер на паузе: расписание снято/);
  assert.equal(repo.workflowState, 'disabled_manually');
  assert.equal(await world.github.schedule(), null, 'the cron does not run the worker');
  assert.deepEqual(await mac.files.readInstall(), { platform: 'github', paused: true, accounts: ACCOUNTS });
  assert.deepEqual(state().session, session, 'the worker session stays');
  assert.deepEqual(world.auth.revoked, [], 'the session is not revoked');
  assert.equal(repo.runs.length, runs, 'pause runs no worker run');

  const back = await run(unpauseWorker);
  assert.equal(back.code, 0, back.io.output());
  assert.match(back.io.lines.at(-1) ?? '', /^Воркер снят с паузы: расписание вернулось\.$/);
  assert.equal(repo.workflowState, 'active');
  assert.deepEqual(await mac.files.readInstall(), { platform: 'github', accounts: ACCOUNTS }, 'unpause drops the paused field');
  assert.ok(await world.github.schedule(), 'the cron runs the worker again');
  assert.deepEqual(world.github.violations, []);
});

test('the overview on pause keeps warning and marks every reset «сгорит»', async () => {
  const { run } = await onGitHub();
  await run(pauseWorker);
  const { code, io } = await run(status);
  assert.equal(code, 0, io.output());
  assert.ok(io.lines.includes('● воркер на паузе'), io.output());
  assert.match(io.lines[4] ?? '', /^ {2}reset-b {3}сгорит +22 окт 15:00$/);
  assert.match(io.lines[5] ?? '', /^ {2}reset-a {3}сгорит +25 окт 12:00$/);
  assert.match(io.lines.at(-1) ?? '', /^! Воркер на паузе: сбросы не применяются и каждый сгорит в свой срок активации\./);
  assert.doesNotMatch(io.output(), /скоро применится|воркер работает/, 'nothing is applied on pause');
});

test('apply-now on pause applies the reset and leaves the schedule off', async () => {
  const { world, repo, run, mac } = await onGitHub();
  await run(pauseWorker);

  const { code, io } = await run(applyNow, { answers: ['1', 'y'] });
  assert.equal(code, 0, io.output());
  assert.equal(io.lines.at(-1), 'Сброс reset-b применён.');
  assert.deepEqual(world.spent(), ['reset-b']);
  assert.deepEqual(repo.runs[0]?.inputs, { apply_now: 'reset-b' });
  assert.equal(repo.workflowState, 'disabled_manually', 'the run does not bring the schedule back');
  assert.deepEqual(await mac.files.readInstall(), { platform: 'github', paused: true, accounts: ACCOUNTS });
});

test('setup on pause runs the trial run and leaves the schedule off', async () => {
  const { repo, run, mac } = await onGitHub();
  await run(pauseWorker);
  const runs = repo.runs.length;

  const { code, io } = await run(setup);
  assert.equal(code, 0, io.output());
  assert.equal(repo.runs.length, runs + 1, 'the trial run happened');
  assert.deepEqual(repo.runs[0]?.inputs, { apply_now: '', [TRIAL_INPUT]: 'true' });
  assert.equal(repo.workflowState, 'disabled_manually', 'the trial does not bring the schedule back');
  assert.deepEqual(await mac.files.readInstall(), { platform: 'github', paused: true, accounts: ACCOUNTS });
});

test('upgrade on pause updates the code and leaves the schedule off', async () => {
  const { world, repo, run, mac } = await onGitHub();
  await run(pauseWorker);

  const { code, io } = await run(upgrade, { workerSource: NEW_WORKER });
  assert.equal(code, 0, io.output());
  assert.equal(world.github.text(repo, FILES.worker), NEW_WORKER);
  assert.equal(repo.workflowState, 'disabled_manually', 'the upgrade does not bring the schedule back');
  assert.deepEqual(await mac.files.readInstall(), { platform: 'github', paused: true, accounts: ACCOUNTS });
});

test('pause on Google takes the trigger off and keeps the worker; unpause brings it back', async () => {
  const { world, gas, run, state, journal, mac, onlyWebApp } = await onGoogle();
  const session = state().session, entries = journal().length;

  const paused = await run(pauseWorker);
  assert.equal(paused.code, 0, paused.io.output());
  assert.match(paused.io.lines.at(-1) ?? '', /^Воркер на паузе: расписание снято/);
  assert.deepEqual(gas.triggers, []);
  assert.equal((await mac.files.readInstall())?.paused, true);
  assert.deepEqual(state().session, session, 'the worker session stays');
  assert.deepEqual(world.auth.revoked, [], 'the session is not revoked');
  assert.equal(journal().length, entries, 'pause runs no worker run');
  onlyWebApp();

  const back = await run(unpauseWorker);
  assert.equal(back.code, 0, back.io.output());
  assert.deepEqual(gas.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.equal((await mac.files.readInstall())?.paused, undefined, 'unpause drops the paused field');
  gas.tick();
  assert.equal(journal().length, entries + 1, 'the worker ticks by its schedule again');
});

test('status on Google on pause says so and marks the resets «сгорит»', async () => {
  const { run, onlyWebApp } = await onGoogle();
  await run(pauseWorker);
  const { code, io } = await run(status);
  assert.equal(code, 0, io.output());
  assert.ok(io.lines.includes('● воркер на паузе'), io.output());
  assert.match(io.lines[4] ?? '', /^ {2}reset-b {3}сгорит +22 окт 15:00$/);
  assert.match(io.lines.at(-1) ?? '', /^! Воркер на паузе: сбросы не применяются и каждый сгорит в свой срок активации\./);
  assert.doesNotMatch(io.output(), /нет расписания|Почините воркер/, 'a pause is not a broken worker');
  onlyWebApp();
});

test('apply-now on Google on pause applies the reset and leaves the schedule off', async () => {
  const { world, gas, run, journal, mac, onlyWebApp } = await onGoogle();
  await run(pauseWorker);

  const { code, io } = await run(applyNow, { answers: ['1', 'y'] });
  assert.equal(code, 0, io.output());
  assert.equal(io.lines.at(-1), 'Сброс reset-b применён.');
  assert.equal(world.consumeCalls().length, 1);
  assert.equal(journal().at(-1)?.kind, 'apply_now');
  assert.deepEqual(gas.triggers, [], 'the run does not bring the schedule back');
  assert.equal((await mac.files.readInstall())?.paused, true);
  onlyWebApp();
});

test('setup on Google on pause does not bring the schedule back, and the trial still runs', async () => {
  const { gas, run, journal, mac, onlyWebApp } = await onGoogle();
  await run(pauseWorker);

  const { code, io } = await run(setup, { answers: [] });
  assert.equal(code, 0, io.output());
  assert.ok(io.lines.includes('Воркер остаётся на паузе: расписание остаётся снятым.'), io.output());
  assert.equal(gas.triggers.length, 0, 'the repair does not bring the schedule back');
  assert.equal(journal().at(-1)?.kind, 'trial', 'the trial run happened');
  assert.equal((await mac.files.readInstall())?.paused, true);
  onlyWebApp();
});

test('upgrade on Google on pause updates the code and leaves the schedule off', async () => {
  const { gas, project, run, state, mac } = await onGoogle();
  await run(pauseWorker);
  const versions = project.versions.length, session = state().session;

  const { code, io } = await run(upgrade, { appsScriptSource: `${await bundle()}\n// next version\n` });
  assert.equal(code, 0, io.output());
  assert.equal(project.versions.length, versions + 1, 'a new version is deployed');
  assert.equal(gas.triggers.length, 0, 'the upgrade does not bring the schedule back');
  assert.deepEqual(state().session, session, 'the worker keeps its session');
  assert.equal((await mac.files.readInstall())?.paused, true);
});
