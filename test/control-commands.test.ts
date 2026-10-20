import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from '../src/cli/setup.ts';
import { status } from '../src/cli/status.ts';
import { applyNow } from '../src/cli/apply-now.ts';
import { rules } from '../src/cli/rules.ts';
import { login } from '../src/cli/login.ts';
import { buildWorker } from '../scripts/build-worker.ts';
import { FILES, STATE_KEY_SECRET, LOGIN_SECRET } from '../src/worker/layout.ts';
import { openState, readRules } from '../src/worker/state-file.ts';
import { workflowYaml } from '../src/worker/workflow.ts';
import type { Summary } from '../src/worker/summary.ts';
import { credit, window } from './support/fake-world.ts';
import { cliWorld } from './support/cli-world.ts';
import pkg from '../package.json' with { type: 'json' };

const HOUR = 3600_000, DAY = 24 * HOUR;

// A worker installed by setup with the default rules: resets reset-a (in 5 days) and reset-b
// (in 2 days 3 hours).
async function installed(options?: Parameters<typeof cliWorld>[0]) {
  const env = await cliWorld(options);
  const { code, io } = await env.run(setup, { answers: ['1', ''] });
  assert.equal(code, 0, io.output());
  const repo = env.world.github.repo();
  assert.ok(repo);
  const state = () => openState(env.world.github.text(repo, FILES.state), env.world.github.secret(repo, STATE_KEY_SECRET));
  const summary = (): Summary => JSON.parse(env.world.github.text(repo, FILES.summary));
  return { ...env, repo, state, summary };
}

test('status shows the resets, the rules, the last run and the last application', async () => {
  const { world, run } = await installed();
  world.chatgpt.credits.push(credit('reset-due', world.now + 3 * HOUR));
  world.advance(HOUR);
  await world.github.schedule();
  world.advance(30 * 60_000);

  const { code, io } = await run(status);
  assert.equal(code, 0);
  assert.deepEqual(io.lines, [
    `aures ${pkg.version}${' '.repeat(54 - pkg.version.length)}20 окт 13:30`,
    '',
    'СБРОСЫ · 2',
    '─'.repeat(72),
    `  reset-b   через 2 д 1 ч${' '.repeat(35)}22 окт 15:00`,
    `  reset-a   через 4 д 22 ч${' '.repeat(34)}25 окт 12:00`,
    '',
    'ПРАВИЛА',
    '─'.repeat(72),
    '  ☑ Перед истечением (в последние 8 часов)',
    '  ☐ Когда кончится недельный лимит',
    '',
    '● воркер работает · ждёт запуска по расписанию',
    '  применён reset-due 20 окт 13:00 — перед истечением',
    '  https://github.com/octo-fake/codex-auto-resets-worker',
  ]);
  assert.deepEqual(world.github.violations, []);
});

test('status marks a reset inside the before-expiry window', async () => {
  const { world, run } = await installed();
  world.chatgpt.credits.push(credit('reset-soon', world.now + 10 * HOUR));
  world.advance(HOUR);
  await world.github.schedule();
  world.advance(2 * HOUR);
  const { io } = await run(status);
  assert.match(io.lines[4] ?? '', /^ {2}reset-soon {3}скоро применится +20 окт 22:00$/);
});

test('status counts down to the next scheduled run by the usual gap between them', async () => {
  const { world, run } = await installed();
  for (const gap of [HOUR, 6 * HOUR, 6 * HOUR]) {
    world.advance(gap);
    await world.github.schedule();
  }
  world.advance(2 * HOUR);
  assert.ok((await run(status)).io.lines.includes('● воркер работает · следующий запуск ожидается через 4 ч'));

  // A dispatched run does not move the schedule.
  await world.github.dispatch();
  world.advance(30 * 60_000);
  assert.ok((await run(status)).io.lines.includes('● воркер работает · следующий запуск ожидается через 3 ч'));

  world.advance(4 * HOUR);
  assert.ok((await run(status)).io.lines.includes('● воркер работает · следующий запуск ожидается в любой момент'));
});

test('status warns when the worker has not run for hours', async () => {
  const { world, run } = await installed();
  world.advance(9 * HOUR);
  const { code, io } = await run(status);
  assert.equal(code, 0);
  assert.ok(io.lines.includes('● воркер молчит 9 ч'), io.output());
  assert.match(io.lines.at(-1) ?? '', /^! Воркер не запускался уже 9 ч\. Проверьте: https:\/\/github\.com\/.*\/actions$/);
  assert.match(io.output(), /СБРОСЫ · 2/, 'the last published resets are still shown');
});

test('status warns about a silent cron even when dispatched runs keep the worker going', async () => {
  const { world, run } = await installed();
  world.advance(HOUR);
  await world.github.schedule();
  world.advance(7 * HOUR);
  await world.github.dispatch();
  world.advance(30 * 60_000);
  assert.ok((await run(status)).io.lines.includes('● воркер работает · ждёт запуска по расписанию'));

  world.advance(HOUR);
  await world.github.dispatch();
  const { code, io } = await run(status);
  assert.equal(code, 0);
  assert.ok(io.lines.includes('● нет запуска по расписанию 8 ч'), io.output());
  assert.match(io.lines.at(-1) ?? '', /^! GitHub не запускал воркер по расписанию уже 8 ч, а правило перед истечением зависит от этих запусков\. Проверьте: https:\/\/github\.com\/.*\/actions$/);
});

test('status warns that a disabled workflow does not run the worker', async () => {
  const { world, repo, run } = await installed();
  repo.workflowState = 'disabled_manually';
  assert.equal(await world.github.schedule(), null);
  const { code, io } = await run(status);
  assert.equal(code, 0);
  assert.ok(io.lines.includes('● воркер выключен в GitHub'), io.output());
  assert.match(io.lines.at(-1) ?? '', /^! Сбросы не применяются\. Включите воркер кнопкой Enable workflow: .*\/actions\/workflows\/codex-auto-resets\.yml$/);
});

test('status explains a failed last run', async () => {
  const { world, repo, run } = await installed();
  world.endSession('refresh_token_invalidated');
  world.advance(HOUR);
  await world.github.schedule();
  const { io } = await run(status);
  assert.ok(io.lines.includes('● последний запуск с ошибкой · 20 окт 13:00'), io.output());
  assert.equal(io.lines.at(-1), '! Воркер потерял вход в ChatGPT. Войдите заново: `aures login`. ' +
    `Подробности: ${repo.runs[0]?.html_url}`);
});

test('control commands ask for setup when there is no worker', async () => {
  const { run, mac } = await cliWorld();
  for (const command of [status, applyNow, rules, login]) {
    // This Mac has no install record: the user says to look on GitHub.
    const { code, io } = await run(command, { answers: ['1'] });
    assert.equal(code, 1);
    assert.equal(io.lines.at(-1), 'Воркер не установлен. Запустите `aures setup`.');
  }
  assert.equal(await mac.files.readInstall(), null, 'a worker that is not found is not recorded');
});

test('apply-now applies the chosen reset in a dispatched run and shows the result', async () => {
  const { world, repo, run, summary } = await installed();
  const { code, io } = await run(applyNow, { answers: ['2', 'y'] });
  assert.equal(code, 0, io.output());
  assert.match(io.output(), /1\. reset-b — истекает 22 октября[\s\S]*2\. reset-a — истекает 25 октября/);
  assert.deepEqual(repo.runs[0]?.inputs, { apply_now: 'reset-a' });
  assert.deepEqual(world.spent(), ['reset-a']);
  assert.equal(io.lines.at(-1), 'Сброс reset-a применён.');
  assert.equal(summary().lastApplied?.reason, 'apply_now');
});

test('apply-now follows its own run when the Mac dispatches another one meanwhile', async () => {
  const { world, repo, run } = await installed();
  // Ours waits in the queue; the regular tick the check from the Mac starts finishes at once.
  world.github.queueMs = 60_000;
  const runner = world.github.runner;
  world.github.runner = (repo, run) => run.inputs.apply_now ? runner?.(repo, run) ?? null :
    { conclusion: 'success', log: '2026-10-20T12:00:00.000Z idle\n' };
  let dispatched = false, foreign = false;
  world.github.fail = (method, path) => {
    if (method === 'POST' && path.endsWith('/dispatches')) dispatched = true;
    // The first poll after our dispatch: the Mac's run is newer than ours, as the first new one.
    else if (dispatched && !foreign && method === 'GET') {
      foreign = true;
      world.github.queueMs = 0;
      void world.github.dispatch();
    }
    return null;
  };
  const { code, io } = await run(applyNow, { answers: ['2', 'y'] });
  assert.equal(code, 0, io.output());
  assert.equal(repo.runs.length, 3, 'setup, ours and the Mac\'s');
  assert.deepEqual(world.spent(), ['reset-a']);
  assert.equal(io.lines.at(-1), 'Сброс reset-a применён.');
});

test('apply-now waits when GitHub does not show the run it just named yet', async () => {
  const { world, run } = await installed();
  let hidden = 2;
  world.github.fail = (method, path) => method === 'GET' && /\/actions\/runs\/\d+$/.test(path) && hidden-- > 0 ?
    new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }) : null;
  const { code, io } = await run(applyNow, { answers: ['2', 'y'] });
  assert.equal(code, 0, io.output());
  assert.equal(io.lines.at(-1), 'Сброс reset-a применён.');
});

test('apply-now finds its run among the new ones when GitHub does not name it', async () => {
  const { world, run } = await installed();
  world.github.runDetails = false;
  const { code, io } = await run(applyNow, { answers: ['2', 'y'] });
  assert.equal(code, 0, io.output());
  assert.equal(io.lines.at(-1), 'Сброс reset-a применён.');
});

test('apply-now does nothing until the user picks a reset and confirms it', async () => {
  const { world, repo, run } = await installed();
  let result = await run(applyNow, { answers: ['7', 'abc', ''] });
  assert.equal(result.code, 0);
  assert.match(result.io.output(), /Введите номер от 1 до 2\.[\s\S]*Введите номер от 1 до 2\.[\s\S]*Отменено\./);
  result = await run(applyNow, { answers: ['1', ''] });
  assert.equal(result.io.lines.at(-1), 'Отменено.');
  assert.equal(repo.runs.length, 1, 'only the trial run of setup');
  assert.deepEqual(world.spent(), []);
});

test('apply-now reports an application ChatGPT refused and one whose result is unknown', async () => {
  const { world, run } = await installed();
  world.chatgpt.outcome = 'nothing_to_reset';
  let result = await run(applyNow, { answers: ['1', 'y'] });
  assert.equal(result.code, 1);
  assert.equal(result.io.lines.at(-1), 'Сброс reset-b не применён: сбрасывать нечего, сброс сохранён.');

  world.chatgpt.outcome = 'reset';
  world.chatgpt.lose = 'before';
  result = await run(applyNow, { answers: ['1', 'y'] });
  assert.equal(result.code, 1);
  assert.match(result.io.lines.at(-1) ?? '', /^Результат пока неизвестен: воркер уточнит его/);
  // The next scheduled tick settles it with the same redeem_request_id.
  world.chatgpt.lose = null;
  world.advance(HOUR);
  await world.github.schedule();
  assert.deepEqual(world.spent(), ['reset-b']);
});

test('apply-now explains a failed run and refuses a disabled workflow', async () => {
  const { world, repo, run } = await installed();
  world.revokeAccess();
  let result = await run(applyNow, { answers: ['1', 'y'] });
  assert.equal(result.code, 1);
  assert.equal(result.io.lines.at(-2), 'Воркер потерял вход в ChatGPT. Войдите заново: `aures login`.');
  assert.equal(result.io.lines.at(-1), `Подробности: ${repo.runs[0]?.html_url}`);

  repo.workflowState = 'disabled_inactivity';
  const runs = repo.runs.length;
  result = await run(applyNow);
  assert.equal(result.code, 1);
  assert.match(result.io.lines.at(-1) ?? '', /^Воркер выключен в GitHub\. Включите его кнопкой Enable workflow/);
  assert.equal(repo.runs.length, runs);
});

test('rules switches a general rule in the open rules file, and the next tick follows it', async () => {
  const { world, repo, run, summary } = await installed();
  const { code, io } = await run(rules, { answers: ['2', ''] });
  assert.equal(code, 0);
  assert.match(io.output(), /2\. Когда кончится недельный лимит — выключено[\s\S]*2\. Когда кончится недельный лимит — включено/);
  assert.ok(io.lines.includes('Правила сохранены и заработают со следующего запуска воркера.'), io.output());
  assert.equal(io.lines.at(-1), 'Внеочередная проверка с этого Mac включена.');
  assert.deepEqual(readRules(world.github.text(repo, FILES.rules)), { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: true });
  assert.equal(repo.commits.at(-1)?.message, 'Change the general rules');

  world.chatgpt.secondary = window(604800, 100, world.now + 2 * DAY);
  world.advance(HOUR);
  await world.github.schedule();
  assert.deepEqual(world.spent(), ['reset-b']);
  assert.equal(summary().lastApplied?.reason, 'weekly');
  assert.deepEqual(summary().rules, { beforeExpiry: true, weeklyAutoApply: true });
});

test('rules without a change writes nothing', async () => {
  const { repo, run } = await installed();
  const commits = repo.commits.length;
  const { code, io } = await run(rules, { answers: [''] });
  assert.equal(code, 0);
  assert.equal(io.lines.at(-1), 'Правила не изменились.');
  assert.equal(repo.commits.length, commits);
});

test('login replaces a lost worker session, keeps rules and history, and the next tick runs on it', async () => {
  const { world, repo, run, state, summary } = await installed();
  await run(rules, { answers: ['1', ''] });
  world.chatgpt.credits.push(credit('reset-due', world.now + 2 * HOUR));
  await run(applyNow, { answers: ['1', 'y'] });
  const history = state().applied;
  assert.equal(history?.length, 1);
  world.endSession('refresh_token_invalidated');
  world.advance(HOUR);
  assert.equal((await world.github.schedule())?.conclusion, 'failure');

  const { code, io } = await run(login);
  assert.equal(code, 0, io.output());
  assert.match(io.output(), /auth\.openai\.com\/codex\/device/);
  assert.equal(io.lines.at(-2), 'Вход обновлён, правила и история на месте.');
  assert.match(io.lines.at(-1) ?? '', /^Воркер работает\. Сбросов: 2, ближайший истекает/);
  assert.equal(repo.secrets.has(LOGIN_SECRET), false, 'the login secret is gone');
  assert.equal(state().session.refreshToken, world.auth.current?.refresh);
  assert.deepEqual(state().applied, history);
  assert.equal(readRules(world.github.text(repo, FILES.rules)).beforeExpiry, false);

  world.advance(HOUR);
  const next = await world.github.schedule();
  assert.equal(next?.conclusion, 'success');
  assert.match(next?.log ?? '', /Z idle\n$/);
  assert.equal(summary().login?.result, 'accepted');
});

test('login into another ChatGPT account is rejected with a hint to uninstall', async () => {
  const { world, repo, run, state } = await installed();
  const before = state().session;
  world.accountId = 'account-other';
  const { code, io } = await run(login);
  assert.equal(code, 1);
  assert.match(io.lines.at(-1) ?? '', /^Это другой аккаунт ChatGPT.*`aures uninstall`/);
  assert.deepEqual(state().session, before);
  assert.equal(repo.secrets.has(LOGIN_SECRET), false, 'the other account\'s session does not stay in GitHub');
});

test('login refuses a worker whose workflow does not pass the login secret', async () => {
  const { world, repo, run } = await installed();
  const old = workflowYaml({ minute: 30 }).split('\n').filter(line => !line.includes(LOGIN_SECRET)).join('\n');
  world.github.write(repo, FILES.workflow, old);
  const { code, io } = await run(login);
  assert.equal(code, 1);
  assert.match(io.lines.at(-1) ?? '', /^Воркер устарел\. Обновите его: `aures upgrade`/);
  assert.doesNotMatch(io.output(), /auth\.openai\.com/, 'no login the worker could not take');
});

test('end to end on the built worker: rules, apply-now and login reach the worker on plain node', async () => {
  const built = await buildWorker(join(await mkdtemp(join(tmpdir(), 'control-build-')), 'worker.mjs'));
  const { world, run, summary } = await installed({ node: true, workerSource: await readFile(built, 'utf8') });

  assert.equal((await run(rules, { answers: ['2', ''] })).code, 0);
  world.advance(HOUR);
  await world.github.schedule();
  assert.deepEqual(summary().rules, { beforeExpiry: true, weeklyAutoApply: true });

  // The child worker's consume does not reach this world, so the reset stays listed here.
  const applied = await run(applyNow, { answers: ['2', 'y'] });
  assert.equal(applied.code, 0, applied.io.output());
  assert.equal(summary().lastApplied?.creditId, 'reset-a');

  world.endSession('refresh_token_invalidated');
  const relogged = await run(login);
  assert.equal(relogged.code, 0, relogged.io.output());
  assert.equal(summary().login?.result, 'accepted');
});

test('login removes its secret even when the run is not seen through', async () => {
  const { world, repo, run } = await installed();
  world.github.runner = () => null;
  const { code, io } = await run(login);
  assert.equal(code, 1);
  assert.match(io.lines.at(-1) ?? '', /дольше 10 минут/);
  assert.equal(repo.secrets.has(LOGIN_SECRET), false);
});

test('login whose run waits in the GitHub queue past the wait asks for login again, not to wait', async () => {
  const { world, repo, run } = await installed();
  world.github.queueMs = 11 * 60_000;
  const { code, io } = await run(login);
  assert.equal(code, 1);
  assert.match(io.lines.at(-1) ?? '', /новый вход ему не передан\. Повторите `aures login`\.$/);
  assert.doesNotMatch(io.output(), /запустится сам/);
  assert.equal(repo.secrets.has(LOGIN_SECRET), false);
});

test('setup with a new state drops a login secret left behind, so it never brings back older tokens', async () => {
  const { world, repo, run, state } = await installed();
  world.github.setSecret(repo, LOGIN_SECRET, JSON.stringify({ id: 'login-stale', session: state().session }));
  repo.files.delete(FILES.state);
  assert.equal((await run(setup)).code, 0);
  assert.equal(repo.secrets.has(LOGIN_SECRET), false);
  assert.equal(state().session.refreshToken, world.auth.current?.refresh);
  assert.equal(state().login, undefined);
});
