import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from '../src/cli/setup.mjs';
import { buildWorker } from '../scripts/build-worker.mjs';
import { FILES, STATE_KEY_SECRET } from '../src/worker/layout.mjs';
import { openState, readRules } from '../src/worker/state-file.mjs';
import { credit } from './support/fake-world.mjs';
import { cliWorld, WORKER_SOURCE } from './support/cli-world.mjs';

const HOUR = 3600_000, DAY = 24 * HOUR;

async function installWorld(options) {
  const { world, keychain, run } = await cliWorld(options);
  return { world, keychain, run: ({ answers = [''], ...rest } = {}) => run(setup, { answers, ...rest }) };
}

test('setup goes from nothing to a working worker in a private repository', async () => {
  const { world, keychain, run } = await installWorld();
  const { code, io } = await run();
  assert.equal(code, 0);

  const repo = world.github.repo();
  assert.equal(repo.meta.private, true);
  assert.deepEqual([...repo.files.keys()].sort(), Object.values(FILES).sort());
  assert.equal(world.github.text(repo, FILES.worker), WORKER_SOURCE);
  assert.match(world.github.text(repo, FILES.workflow), /cron: '30 \* \* \* \*'/);
  assert.deepEqual(readRules(world.github.text(repo, FILES.rules)), { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: false });
  const state = openState(world.github.text(repo, FILES.state), world.github.secret(repo, STATE_KEY_SECRET));
  assert.equal(state.session.accountId, world.accountId);
  assert.equal(state.session.refreshToken, world.auth.current.refresh);
  // The trial run read the resets and published them.
  assert.deepEqual(repo.runs.map(r => [r.event, r.conclusion]), [['workflow_dispatch', 'success']]);
  assert.deepEqual(state.observed?.resets.map(r => r.id).sort(), ['reset-a', 'reset-b']);

  assert.equal(keychain.entries.size, 1);
  assert.match(io.output(), /https:\/\/github\.com\/login\/device/);
  assert.match(io.output(), /https:\/\/auth\.openai\.com\/codex\/device/);
  assert.match(io.output(), /Перед истечением \(в последние 8 часов\) — включено/);
  assert.match(io.output(), /Когда кончится недельный лимит — выключено/);
  assert.match(io.lines.at(-1), /^Воркер работает\. Сбросов: 2, ближайший истекает 22 октября 2026 г\. в 15:00 UTC\.$/);
  assert.deepEqual(world.violations, []);
  assert.deepEqual(world.github.violations, []);
});

test('end to end: the worker setup committed runs on plain node and ticks on the files setup wrote', async () => {
  const built = await buildWorker(join(await mkdtemp(join(tmpdir(), 'setup-build-')), 'worker.mjs'));
  const { world, run } = await installWorld({ node: true, workerSource: await readFile(built, 'utf8') });
  world.chatgpt.credits.push(credit('reset-due', world.now + 3 * HOUR));
  const { code, io } = await run();
  assert.equal(code, 0, io.output());
  const repo = world.github.repo();
  assert.match(world.github.text(repo, FILES.worker), /^\/\/ codex-auto-resets worker /);
  assert.match(repo.runs[0].log, /Z applied\n$/);
  // The before-expiry rule setup wrote reached the worker: it applied the reset due in 3 hours.
  const summary = JSON.parse(world.github.text(repo, FILES.summary));
  assert.equal(summary.lastApplied.creditId, 'reset-due');
  assert.deepEqual(summary.rules, { beforeExpiry: true, weeklyAutoApply: false });
  const state = openState(world.github.text(repo, FILES.state), world.github.secret(repo, STATE_KEY_SECRET));
  assert.equal(state.applied.at(-1).reason, 'before_expiry');
  assert.equal(state.session.accountId, world.accountId);
});

test('the GitHub token stays in the Keychain: never in the repository, its secrets or the output', async () => {
  const { world, keychain, run } = await installWorld();
  const { io } = await run();
  const token = keychain.entries.get('github');
  assert.match(token, /^gho_/);
  const repo = world.github.repo();
  const stored = [...repo.files.values()].map(f => f.text)
    .concat([...repo.secrets.keys()].map(name => world.github.secret(repo, name)), repo.commits.map(c => c.message));
  for (const text of stored) assert.ok(!text.includes(token));
  assert.ok(!io.output().includes(token));
  // Only the Authorization header carries it.
  assert.ok(world.github.requests.every(r => !r.body.includes(token)));
});

test('a repeated setup finds the repository and keeps the state, rules and cron the worker runs on', async () => {
  const { world, keychain, run } = await installWorld();
  await run({ answers: ['2', ''] });
  const repo = world.github.repo();
  const before = new Map([...repo.files].map(([path, file]) => [path, file.text]));
  const key = world.github.secret(repo, STATE_KEY_SECRET);
  world.advance(DAY);

  const { code, io } = await run({ answers: [], random: () => 0.9 });
  assert.equal(code, 0);
  assert.equal(world.github.repos.size, 1);
  assert.deepEqual(io.asked, [], 'no rules prompt');
  assert.doesNotMatch(io.output(), /github\.com\/login\/device|auth\.openai\.com/, 'no new logins');
  assert.equal(world.github.secret(repo, STATE_KEY_SECRET), key);
  for (const path of [FILES.workflow, FILES.worker, FILES.rules]) assert.equal(world.github.text(repo, path), before.get(path), path);
  assert.equal(readRules(world.github.text(repo, FILES.rules)).weeklyAutoApply, true);
  const state = openState(world.github.text(repo, FILES.state), key);
  // The worker's is the first session; the second is this Mac's, for the weekly rule.
  assert.equal(state.session.refreshToken, world.auth.sessions[0].refresh);
  assert.equal(repo.runs.length, 2);
  assert.match(io.lines.at(-1), /^Воркер работает\. Сбросов: 2/);
  assert.equal(keychain.entries.size, 1);
});

// GitHub drops the connection on the first write of `path`, as when the laptop goes offline.
const dropFirstWrite = (world, path) => {
  let dropped = false;
  world.github.fail = (method, url) => {
    if (dropped || method !== 'PUT' || !url.endsWith(`/contents/${path}`)) return null;
    dropped = true;
    return Promise.reject(new TypeError('fetch failed'));
  };
};

for (const [label, path, logins] of [
  ['before the state', FILES.state, 2],
  ['before the rules', FILES.rules, 1],
  ['before the workflow', FILES.workflow, 1],
]) {
  test(`setup interrupted ${label} is finished by the next setup in the same repository`, async () => {
    const { world, run } = await installWorld();
    dropFirstWrite(world, path);
    const first = await run();
    assert.equal(first.code, 1);
    assert.match(first.io.lines.at(-1), /GitHub недоступен\. Повторите `codex-auto-resets setup`: сделанное сохранится/);
    const repo = world.github.repo();
    assert.equal(repo.runs.length, 0);
    assert.equal(repo.files.has(FILES.workflow), false, 'no schedule over a half-filled repository');

    const second = await run({ answers: repo.files.has(FILES.rules) ? [] : [''] });
    assert.equal(second.code, 0);
    assert.equal(world.github.repos.size, 1);
    assert.deepEqual([...repo.files.keys()].sort(), Object.values(FILES).sort());
    assert.equal(world.requests.filter(r => r.path.endsWith('/deviceauth/usercode')).length, logins, 'ChatGPT logins');
    const state = openState(world.github.text(repo, FILES.state), world.github.secret(repo, STATE_KEY_SECRET));
    assert.equal(state.session.refreshToken, world.auth.current.refresh);
    assert.match(second.io.lines.at(-1), /^Воркер работает\./);
  });
}

test('a state left without its key is replaced through a new ChatGPT login', async () => {
  const { world, run } = await installWorld();
  await run();
  const repo = world.github.repo();
  repo.secrets.delete(STATE_KEY_SECRET);
  const { code, io } = await run({ answers: [] });
  assert.equal(code, 0);
  assert.match(io.output(), /auth\.openai\.com\/codex\/device/);
  assert.ok(openState(world.github.text(repo, FILES.state), world.github.secret(repo, STATE_KEY_SECRET)));
});

test('a failed trial run names the cause and the fix', async () => {
  const { world, run } = await installWorld();
  const runner = world.github.runner;
  world.github.runner = (repo, dispatched) => { world.revokeAccess(); return runner(repo, dispatched); };
  world.github.logDelay = 2;
  const { code, io } = await run();
  assert.equal(code, 1);
  const [failed] = world.github.repo().runs;
  assert.equal(failed.conclusion, 'failure');
  assert.equal(io.lines.at(-2), 'Воркер потерял вход в ChatGPT. Войдите заново: `codex-auto-resets login`.');
  assert.equal(io.lines.at(-1), `Подробности: ${failed.html_url}`);
});

test('a trial run that cannot open the state tells to delete it and run setup again', async () => {
  const { world, run } = await installWorld();
  await run();
  const repo = world.github.repo();
  // A key that no longer matches the state, e.g. changed by hand.
  world.github.setSecret(repo, STATE_KEY_SECRET, Buffer.alloc(32, 7).toString('base64'));
  const { code, io } = await run({ answers: [] });
  assert.equal(code, 1);
  assert.match(io.lines.at(-2), new RegExp(`state_undecryptable.*Удалите ${FILES.state.replace('.', '\\.')}.*codex-auto-resets setup`));
  // The advice works: setup refills the deleted state.
  repo.files.delete(FILES.state);
  const again = await run({ answers: [] });
  assert.equal(again.code, 0);
  assert.match(again.io.lines.at(-1), /^Воркер работает\./);
});

test('a trial run still queued after 10 minutes is left for the user to check', async () => {
  const { world, run } = await installWorld();
  world.github.runner = () => null;
  const start = world.now;
  const { code, io } = await run();
  assert.equal(code, 1);
  assert.match(io.lines.at(-1), /дольше 10 минут.*actions\/runs\/\d+/);
  assert.ok(world.now - start >= 10 * 60_000 && world.now - start < 12 * 60_000);
});

test('setup waits until GitHub knows the freshly pushed workflow', async () => {
  const { world, run } = await installWorld();
  world.github.dispatchNotFound = 3;
  const { code } = await run();
  assert.equal(code, 0);
  assert.equal(world.github.requests.filter(r => r.path.endsWith('/dispatches')).length, 4);
});

test('a trial tick that hits a transient ChatGPT failure still leaves an installed worker', async () => {
  const { world, run } = await installWorld();
  const runner = world.github.runner;
  world.github.runner = async (repo, dispatched) => {
    world.chatgpt.fail = { status: 503 };
    try { return await runner(repo, dispatched); } finally { world.chatgpt.fail = null; }
  };
  const { code, io } = await run();
  assert.equal(code, 0);
  assert.match(io.lines.at(-1), /ChatGPT временно недоступен/);
});

test('setup never takes over a foreign repository of the same name or a public one', async () => {
  const { world, run } = await installWorld();
  await run();
  const repo = world.github.repo();
  const files = repo.files.size;
  repo.meta.private = false;
  let result = await run({ answers: [] });
  assert.equal(result.code, 1);
  assert.match(result.io.lines.at(-1), /открыт всем\. Сделайте его приватным/);

  repo.meta = { ...repo.meta, private: true, description: 'My own project' };
  result = await run({ answers: [] });
  assert.equal(result.code, 1);
  assert.match(result.io.lines.at(-1), /создан не codex-auto-resets/);
  assert.equal(repo.files.size, files);
  assert.equal(repo.runs.length, 1);
});

test('a revoked token in the Keychain is replaced through a new GitHub login', async () => {
  const { world, keychain, run } = await installWorld();
  await run();
  const old = keychain.entries.get('github');
  world.github.tokens.delete(old);
  const { code, io } = await run({ answers: [] });
  assert.equal(code, 0);
  assert.match(io.output(), /Вход в GitHub устарел[\s\S]*github\.com\/login\/device/);
  assert.notEqual(keychain.entries.get('github'), old);
  assert.ok(world.github.tokens.has(keychain.entries.get('github')));
});

test('the GitHub login waits as GitHub asks and stops when the user denies access', async () => {
  const { world, keychain, run } = await installWorld();
  const { code, io } = await run({ answers: [], github: 'denied' });
  assert.equal(code, 1);
  assert.equal(io.lines.at(-1), 'Вход в GitHub отклонён.');
  assert.equal(keychain.entries.size, 0);
  assert.equal(world.github.repos.size, 0);

  // Before the code is entered: one slow_down (interval 10 s), then pending polls.
  let polls = 0;
  const slow = await installWorld();
  slow.world.github.fail = (method, path) => { if (path === '/login/oauth/access_token') polls++; return null; };
  const result = await slow.run({ github: false, answers: [] });
  assert.equal(result.code, 1);
  assert.match(result.io.lines.at(-1), /Время на ввод кода GitHub вышло/);
  assert.ok(polls > 80 && polls < 92, `${polls} polls in 15 minutes at 10 s`);
});
