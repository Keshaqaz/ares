import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from '../src/cli/setup.mjs';
import { upgrade } from '../src/cli/upgrade.mjs';
import { uninstall } from '../src/cli/uninstall.mjs';
import { KeychainUnavailable } from '../src/cli/keychain.mjs';
import { buildWorker } from '../scripts/build-worker.mjs';
import { GITHUB_OAUTH_CLIENT_ID } from '../src/github/oauth-app.ts';
import { FILES, STATE_KEY_SECRET, REVOKE_INPUT } from '../src/worker/layout.mjs';
import { openState } from '../src/worker/state-file.mjs';
import { workflowYaml } from '../src/worker/workflow.mjs';
import { cliWorld } from './support/cli-world.mjs';

const OAUTH_APP_LINK = `https://github.com/settings/connections/applications/${GITHUB_OAUTH_CLIENT_ID}`;
const NEW_WORKER = '// fake worker bundle, next version\n';

async function installed(options) {
  const env = await cliWorld(options);
  const { code, io } = await env.run(setup, { answers: [''] });
  assert.equal(code, 0, io.output());
  const repo = env.world.github.repo();
  const state = () => openState(env.world.github.text(repo, FILES.state), env.world.github.secret(repo, STATE_KEY_SECRET));
  return { ...env, repo, state };
}

// The workflow as a version before «uninstall» wrote it: no revoke input.
function olderWorkflow(minute) {
  const lines = workflowYaml({ minute }).split('\n');
  lines.splice(lines.findIndex(line => line.trim() === `${REVOKE_INPUT}:`), 5);
  return lines.filter(line => !line.includes(REVOKE_INPUT)).join('\n');
}

test('upgrade replaces the worker and the workflow, keeps the cron minute and migrates the rules', async () => {
  const { world, repo, run } = await installed();
  world.github.write(repo, FILES.workflow, olderWorkflow(17));
  // A format step as a format change adds it: version 1 called the weekly rule `autoApply`.
  const rulesMigrations = [({ autoApply, ...old }) => ({ ...old, weeklyAutoApply: autoApply })];
  world.github.write(repo, FILES.rules, '{"formatVersion":1,"beforeExpiry":true,"autoApply":true}\n');
  const state = world.github.text(repo, FILES.state);

  const { code, io } = await run(upgrade, { workerSource: NEW_WORKER, rulesMigrations });
  assert.equal(code, 0, io.output());
  assert.equal(world.github.text(repo, FILES.worker), NEW_WORKER);
  assert.equal(world.github.text(repo, FILES.workflow), workflowYaml({ minute: 17 }));
  assert.deepEqual(JSON.parse(world.github.text(repo, FILES.rules)), { formatVersion: 2, beforeExpiry: true, weeklyAutoApply: true });
  assert.equal(world.github.text(repo, FILES.state), state, 'the worker migrates its state itself');
  // The new worker reads older rules, so it goes first; the workflow goes last, as in setup.
  assert.deepEqual(repo.commits.slice(-3).map(c => c.paths[0]), [FILES.worker, FILES.rules, FILES.workflow]);
  assert.match(io.lines.at(-1), /^Воркер обновлён до версии \d+\.\d+\.\d+\. Изменения заработают со следующего запуска\.$/);
  assert.deepEqual(world.github.violations, []);
});

test('upgrade on the current version writes nothing', async () => {
  const { repo, run } = await installed();
  const commits = repo.commits.length;
  const { code, io } = await run(upgrade);
  assert.equal(code, 0);
  assert.match(io.lines.at(-1), /^Воркер уже последней версии \(\d+\.\d+\.\d+\)\.$/);
  assert.equal(repo.commits.length, commits);
});

test('end to end: the upgraded workflow and built worker revoke the session on plain node', async () => {
  const built = await readFile(await buildWorker(join(await mkdtemp(join(tmpdir(), 'upgrade-build-')), 'worker.mjs')), 'utf8');
  const { world, repo, run } = await installed({ node: true, workerSource: '// older worker\n' });
  world.github.write(repo, FILES.workflow, olderWorkflow(30));
  assert.equal((await run(upgrade, { workerSource: built })).code, 0);
  assert.equal(world.github.text(repo, FILES.worker), built);

  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  // The child worker's revoke does not reach this world; its log line does.
  assert.ok(io.lines.includes('Вход воркера в ChatGPT отозван.'), io.output());
});

test('upgrade refuses rules of a newer version and an unreadable workflow, writing nothing', async () => {
  const { world, repo, run } = await installed();
  const commits = repo.commits.length;
  world.github.write(repo, FILES.rules, '{"formatVersion":9,"beforeExpiry":true,"weeklyAutoApply":false}\n');
  let result = await run(upgrade, { workerSource: NEW_WORKER });
  assert.equal(result.code, 1);
  assert.match(result.io.lines.at(-1), /более новой версией\. Обновите программу: `brew upgrade aures`/);

  world.github.write(repo, FILES.rules, '{"formatVersion":1,"beforeExpiry":true,"weeklyAutoApply":false}\n');
  world.github.write(repo, FILES.workflow, 'name: edited by hand\n');
  result = await run(upgrade, { workerSource: NEW_WORKER });
  assert.equal(result.code, 1);
  assert.match(result.io.lines.at(-1), /изменён вручную/);
  assert.equal(repo.commits.length, commits + 3, 'only the test\'s own writes');
});

test('upgrade asks for setup when there is no worker', async () => {
  const { run } = await cliWorld();
  const { code, io } = await run(upgrade);
  assert.equal(code, 1);
  assert.equal(io.lines.at(-1), 'Воркер не установлен. Запустите `aures setup`.');
});

test('uninstall revokes the worker session, deletes the repository and the Keychain entry, and links the OAuth App', async () => {
  const { world, repo, keychain, run, state } = await installed();
  const session = state().session;
  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  assert.match(io.output(), /удаления репозитория[\s\S]*https:\/\/github\.com\/login\/device/);
  assert.deepEqual(repo.runs[0].inputs, { apply_now: '', [REVOKE_INPUT]: 'true' });
  assert.deepEqual(world.auth.revoked, [session.refreshToken]);
  assert.equal(world.github.repo(), undefined);
  assert.equal(keychain.entries.size, 0);
  assert.deepEqual(io.lines.slice(-4), [
    'Вход воркера в ChatGPT отозван.',
    'Репозиторий воркера удалён.',
    'Вход в GitHub удалён из Связки ключей.',
    `Последний шаг: закройте доступ к GitHub кнопкой Revoke на странице ${OAUTH_APP_LINK}`,
  ]);
  assert.deepEqual(world.github.violations, []);
});

test('uninstall goes on when the revocation fails and says so', async () => {
  const { world, run } = await installed();
  world.auth.revokeFail = { status: 503 };
  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  assert.ok(io.lines.includes('Вход воркера в ChatGPT не отозван: ChatGPT не подтвердил отзыв (revoke_503). ' +
    'Он удалится вместе с репозиторием.'), io.output());
  assert.equal(world.github.repo(), undefined);
});

test('uninstall does not wait for a worker that cannot revoke: an older workflow or a disabled one', async () => {
  for (const [label, prepare, reason] of [
    ['older', (world, repo) => world.github.write(repo, FILES.workflow, olderWorkflow(30)), 'воркер устарел'],
    ['disabled', (world, repo) => { repo.workflowState = 'disabled_manually'; }, 'воркер выключен в GitHub'],
  ]) {
    const { world, repo, run } = await installed();
    prepare(world, repo);
    const runs = repo.runs.length;
    const { code, io } = await run(uninstall, { answers: ['y'] });
    assert.equal(code, 0, `${label}: ${io.output()}`);
    assert.equal(repo.runs.length, runs, label);
    assert.ok(io.lines.includes(`Вход воркера в ChatGPT не отозван: ${reason}. Он удалится вместе с репозиторием.`), io.output());
    assert.equal(world.github.repo(), undefined, label);
  }
});

test('uninstall deletes nothing until the user confirms', async () => {
  const { world, repo, keychain, run } = await installed();
  const runs = repo.runs.length;
  const { code, io } = await run(uninstall, { answers: [''] });
  assert.equal(code, 0);
  assert.equal(io.lines.at(-1), 'Отменено.');
  assert.equal(world.github.repo(), repo);
  assert.equal(repo.runs.length, runs);
  assert.deepEqual(world.auth.revoked, []);
  assert.equal(keychain.entries.size, 1);
});

test('uninstall without a worker repository clears the Keychain, and leaves a foreign repository alone', async () => {
  const { world, keychain, run } = await cliWorld();
  keychain.entries.set('github', 'gho_left_behind');
  let result = await run(uninstall);
  assert.equal(result.code, 0, result.io.output());
  assert.deepEqual(result.io.lines.slice(-3), ['Репозитория воркера нет.', 'Вход в GitHub удалён из Связки ключей.',
    `Последний шаг: закройте доступ к GitHub кнопкой Revoke на странице ${OAUTH_APP_LINK}`]);
  assert.equal(keychain.entries.size, 0);

  world.github.repos.set('octo-fake/codex-auto-resets-worker', { meta: { name: 'codex-auto-resets-worker', private: true,
    description: 'mine' }, files: new Map(), commits: [], secrets: new Map(), runs: [], workflowState: 'active' });
  result = await run(uninstall);
  assert.equal(result.code, 0);
  assert.match(result.io.output(), /https:\/\/github\.com\/octo-fake\/codex-auto-resets-worker создан не aures, оставлен как есть/);
  assert.ok(world.github.repo());
});

test('uninstall tells how to remove the Keychain entry by hand when Keychain is unavailable', async () => {
  const { world, keychain, run } = await installed();
  keychain.remove = async () => { throw new KeychainUnavailable(); };
  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0);
  assert.equal(world.github.repo(), undefined);
  assert.equal(io.lines.at(-2), 'Связка ключей недоступна: удалите в ней запись codex-auto-resets вручную.');
});
