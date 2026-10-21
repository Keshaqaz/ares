import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setup } from '../src/cli/setup.ts';
import { openScreen, runScreen } from '../src/cli/screen.ts';
import type { Screen } from '../src/cli/screen.ts';
import { FILES } from '../src/worker/layout.ts';
import { readRules } from '../src/worker/state-file.ts';
import { cliWorld } from './support/cli-world.ts';
import pkg from '../package.json' with { type: 'json' };
import { credit } from './support/fake-world.ts';
import { status } from '../src/cli/status.ts';
import { language } from '../src/cli/language.ts';
import { pauseWorker } from '../src/cli/pause.ts';
import { login } from '../src/cli/login.ts';
import type { Language } from '../src/cli/language.ts';

const HINT = '↑↓ выбор · Enter применить · Tab воркер · l язык · r обновить · q выход';

// The screen of a worker installed by setup with the default rules: resets reset-b (in 2 days
// 3 hours) and reset-a (in 5 days). Device codes the screen shows are approved at once.
async function opened({ language = 'ru' }: { language?: Language } = {}) {
  const env = await cliWorld({ language });
  const { code, io } = await env.run(setup, { answers: ['1', ''] });
  assert.equal(code, 0, io.output());
  let screen: Screen | undefined;
  const sleep = async (ms: number) => {
    for (const note of screen?.notes ?? []) {
      for (const [found] of note.text.matchAll(/FAKE-\d+/g)) env.world.approve(found);
      for (const [found] of note.text.matchAll(/GHFK-\d+/g)) env.world.github.approve(found);
    }
    env.world.advance(ms);
  };
  await env.run(async options => { screen = await openScreen({ ...options, sleep }); return 0; });
  assert.ok(screen);
  const shown = screen;
  const press = (...names: string[]) => names.reduce<Promise<unknown>>((done, name) => done.then(() => shown.press({ name, sequence: name })),
    Promise.resolve());
  const text = () => shown.frame().join('\n');
  const repo = env.world.github.repo();
  assert.ok(repo);
  return { ...env, repo, screen: shown, press, text };
}

test('the screen shows the resets on top, the rules under them and moves the cursor over both', async () => {
  const { screen, press, text } = await opened();
  assert.equal(screen.frame()[4], `▸ reset-b   через 2 д 2 ч${' '.repeat(35)}22 окт 15:00`);
  assert.match(text(), /ПРАВИЛА\n─+\n {2}☑ Перед истечением \(в последние 8 часов\)\n {2}☐ Когда кончится недельный лимит/);
  assert.equal(screen.frame().at(-1), HINT);

  await press('down', 'down', 'down');
  assert.match(text(), /▸ ☐ Когда кончится недельный лимит/);
  await press('down');
  assert.match(text(), /▸ reset-b/, 'the cursor goes round');
  await press('up');
  assert.match(text(), /▸ ☐ Когда кончится недельный лимит/);
});

test('Enter on a reset applies it now after a «y», any other key cancels', async () => {
  const { world, repo, press, text, screen } = await opened();
  await press('down', 'return');
  assert.equal(screen.frame().at(-1), 'Применить reset-a сейчас? Сброс одноразовый. y — да, другая клавиша — отмена');
  await press('n');
  assert.equal(screen.frame().at(-1), HINT);
  assert.equal(repo.runs.length, 1, 'only the trial run of setup');

  await press('return');
  await screen.press({ sequence: 'н' }); // «y» on the Russian layout
  assert.deepEqual(world.spent(), ['reset-a']);
  assert.deepEqual(repo.runs[0]?.inputs, { apply_now: 'reset-a' });
  assert.match(text(), /\nСброс reset-a применён\.\n/);
  assert.match(text(), /СБРОСЫ · 1\n─+\n▸ reset-b/, 'the applied reset is gone and the cursor stays in the list');
  assert.match(text(), /применён reset-a 20 окт 12:00 — вручную/);

  await press('down');
  assert.doesNotMatch(text(), /применён\./, 'the next key clears the result');
});

test('Enter on a rule switches it, and the weekly rule sets up the check from this Mac', async () => {
  const { world, repo, mac, press, text } = await opened();
  await press('down', 'down', 'down', 'return');
  assert.deepEqual(readRules(world.github.text(repo, FILES.rules)), { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: true });
  assert.equal(repo.commits.at(-1)?.message, 'Change the general rules');
  assert.match(text(), /Откройте https:\/\/auth\.openai\.com\/codex\/device и введите код FAKE-\d+/);
  assert.match(text(), /Правила сохранены и заработают со следующего запуска воркера\.\n.*\n.*\nВнеочередная проверка с этого Mac включена\.\n\n↑↓/);
  assert.match(text(), /▸ ☑ Когда кончится недельный лимит · проверка с Mac работает/);
  assert.ok(await mac.files.readSession());

  await press('return');
  assert.equal(readRules(world.github.text(repo, FILES.rules)).weeklyAutoApply, false);
  assert.match(text(), /Внеочередная проверка с этого Mac выключена\./);
  assert.ok(await mac.files.readSession());
});

test('a reset with an ID as ChatGPT gives it is shown as RES and the last 4 characters and applied by the whole ID', async () => {
  const { world, repo, press, text, screen } = await opened();
  const id = 'RateLimitResetCredit_0eb466b3212c819193799a1741f067f8';
  world.chatgpt.credits.push(credit(id, world.now + 3 * 86400_000));
  await world.github.schedule();
  await screen.load();
  assert.match(text(), /\n {2}RES67F8 {3}через 3 д/);
  assert.doesNotMatch(text(), /RateLimitResetCredit/);
  await press('down', 'return');
  assert.match(screen.frame().at(-1) ?? '', /^Применить RES67F8 сейчас\?/);
  await press('y');
  assert.deepEqual(repo.runs[0]?.inputs, { apply_now: id });
  assert.match(text(), /\nСброс RES67F8 применён\.\n/);
  assert.match(text(), /применён RES67F8 /);
});

test('a failed action shows why and leaves the screen open', async () => {
  const { repo, press, text, screen } = await opened();
  repo.workflowState = 'disabled_manually';
  await press('return', 'y');
  assert.match(text(), /\nВоркер выключен в GitHub\. Включите его кнопкой Enable workflow: .*\n\n↑↓ выбор/);
  assert.match(text(), /● воркер выключен в GitHub/);
  assert.equal(screen.busy, null);
  assert.equal(repo.runs.length, 1);
});

// The screen in a fake terminal of the size given: its output and keys.
function terminal(screen: Screen, size: { columns: number; rows: number }) {
  const input = new PassThrough(), output = Object.assign(new PassThrough(), size);
  let written = '';
  output.on('data', (chunk: Buffer) => { written += chunk; });
  const done = runScreen(screen, { input, output });
  const press = async (key: string) => { const from = written.length; input.write(key); await new Promise(resolve => setImmediate(resolve));
    return written.slice(from); };
  return { input, done, press, written: () => written };
}
const visible = (text: string): string => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

test('the terminal: the screen takes the alternate screen, redraws the lines that changed, q gives the terminal back', async () => {
  const { screen } = await opened();
  const { done, press, written } = terminal(screen, { columns: 100, rows: 40 });
  assert.ok(written().startsWith('\x1b[?1049h\x1b[?25l'), 'the alternate screen, without the cursor');
  assert.match(written(), /\x1b\[2;1H {2}\x1b\[1maures/, 'a margin around the screen');
  const moved = await press('\x1b[B');
  assert.match(moved, /\x1b\[6;1H\x1b\[2K\x1b\[6;1H {2}\x1b\[1;36m {2}\x1b\[0mreset-b/);
  assert.match(moved, /\x1b\[7;1H\x1b\[2K\x1b\[7;1H {2}\x1b\[1;36m▸ \x1b\[0m\x1b\[1;36mreset-a/);
  assert.equal([...moved.matchAll(/\x1b\[2K/g)].length, 2, 'only the two lines of the cursor');
  await press('q');
  assert.equal(await done, 0);
  assert.ok(written().endsWith('\x1b[?25h\x1b[?1049l'), 'the cursor and the terminal as it was are back');
});

test('the terminal: a frame taller than the terminal keeps its bottom and never scrolls it', async () => {
  const { screen } = await opened();
  const { input, done, written } = terminal(screen, { columns: 100, rows: 8 });
  const rows = [...written().matchAll(/\x1b\[(\d+);1H/g)].map(([, row]) => Number(row));
  assert.equal(Math.max(...rows), 8);
  assert.doesNotMatch(written(), /\n/, 'no line feed that could scroll the terminal');
  assert.match(visible(written()), /↑↓ выбор/);
  assert.doesNotMatch(visible(written()), /aures|СБРОСЫ/, 'the top gives way');
  input.write('q');
  assert.equal(await done, 0);
});

test('the screen in English: l switches to Russian and back, keeping the choice on this Mac', async () => {
  const { mac, press, text, screen, run } = await opened({ language: 'en' });
  assert.equal(screen.frame()[0], `aures ${pkg.version}${' '.repeat(44 - pkg.version.length)}20 Oct 12:00   EN · RU`);
  assert.equal(screen.frame()[4], `▸ reset-b   in 2d 2h${' '.repeat(40)}22 Oct 15:00`);
  assert.match(text(), /RULES\n─+\n {2}☑ Before expiry \(in the last 8 hours\)\n {2}☐ When the weekly limit runs out/);
  assert.match(text(), /● worker works · waiting for a scheduled run/);
  assert.equal(screen.frame().at(-1), '↑↓ select · Enter apply · Tab worker · l language · r refresh · q quit');

  await press('l');
  assert.equal(language(), 'ru');
  assert.equal(await mac.files.readLanguage(), 'ru');
  assert.match(text(), /СБРОСЫ · 2[\s\S]*ПРАВИЛА/);
  assert.equal(screen.frame().at(-1), HINT);
  await screen.press({ sequence: 'д' }); // «l» on the Russian layout
  assert.equal(language(), 'en');
  assert.equal(await mac.files.readLanguage(), 'en');
  assert.match(text(), /RESETS · 2/);

  const { io } = await run(status);
  assert.match(io.output(), /^aures \S+ +20 Oct 12:00\n/, 'status has no language toggle');
  assert.match(io.output(), /RESETS · 2/);
});

// The screen «Воркер» (issues 11, 15): Tab from the resets and back, the platform and its
// accounts, «Проверить сейчас», «Починить», «Пауза» / «Снять с паузы» and the live journal.
const WORKER_HINT = '↑↓ выбор · Enter выполнить · Tab сбросы · l язык · r обновить · q выход';
const REPAIR_CAPTION = 'Заново залить текущую версию воркера и вернуть расписание на этой площадке. Сбросы, правила, вход в ChatGPT ' +
  'и журнал не трогаются. Поможет, если воркер перестал запускаться или его файлы меняли вручную';
const HOUR = 3600_000, MINUTE = 60_000;

// The same screen of a worker that setup installed on Google Apps Script.
async function openedOnGoogle() {
  const env = await cliWorld();
  const { code, io } = await env.run(setup, { answers: ['2', ''] });
  assert.equal(code, 0, io.output());
  let screen: Screen | undefined;
  await env.run(async options => { screen = await openScreen(options); return 0; });
  assert.ok(screen);
  const shown = screen;
  const press = (...names: string[]) => names.reduce<Promise<unknown>>((done, name) => done.then(() => shown.press({ name, sequence: name })),
    Promise.resolve());
  const project = env.world.google.project();
  assert.ok(project?.gas);
  return { ...env, project, gas: project.gas, screen: shown, press, text: () => shown.frame().join('\n') };
}
// The caption under «Починить» as one line, the way the frame wraps it.
const caption = (frame: string[]): string => frame.slice(frame.findIndex(line => line.endsWith('Починить')) + 1)
  .filter(line => line.startsWith('    ')).map(line => line.trim()).join(' ');

test('the screen «Воркер» on GitHub: Tab opens it from the resets and goes back', async () => {
  const { screen, press, text } = await opened();
  assert.equal(screen.frame().at(-1), HINT);
  await press('tab');
  assert.equal(screen.view, 'worker');
  assert.match(screen.frame()[0] ?? '', /^aures \S+ +20 окт 12:00 {3}EN · RU$/);
  assert.match(text(), /\nВОРКЕР\n─+\n● GitHub Actions · активен\n {2}https:\/\/github\.com\/octo-fake\/codex-auto-resets-worker\n/);
  assert.match(text(), /\nАККАУНТЫ\n─+\n {2}GitHub {4}octo-fake {3,}войти заново\n {2}ChatGPT {3}fake@example\.invalid · вход работает {3,}войти заново\n/);
  assert.match(text(), /\nДЕЙСТВИЯ\n─+\n▸ Проверить сейчас · ~1 мин Actions\n {2}Починить\n/);
  assert.match(text(), /\nЖУРНАЛ\n─+\n {2}опрошен 12:00:\d\d, ответил за 0,0 с\n {2}20 окт 12:00 {2}пробный · применять нечего · 0,0 с\n/);
  assert.doesNotMatch(text(), /СБРОСЫ|ПРАВИЛА/);
  assert.equal(screen.frame().at(-1), WORKER_HINT);

  await press('tab');
  assert.equal(screen.view, 'resets');
  assert.match(text(), /СБРОСЫ · 2[\s\S]*ПРАВИЛА/);
  assert.equal(screen.frame().at(-1), HINT);
});

test('the screen «Воркер» on Google: the platform, its accounts and the caption of «Починить»', async () => {
  const { screen, press, text, project } = await openedOnGoogle();
  await screen.press({ name: 'tab', sequence: '\t' });
  assert.match(text(), new RegExp(`\nВОРКЕР\n─+\n● Google Apps Script · активен\n {2}https://script\\.google\\.com/home/projects/${project.scriptId}\n`));
  assert.match(text(), /\nАККАУНТЫ\n─+\n {2}Google {4}owner@example\.invalid {3,}войти заново\n {2}ChatGPT {3}fake@example\.invalid · вход работает {3,}войти заново\n/);
  assert.match(text(), /\nДЕЙСТВИЯ\n─+\n▸ Проверить сейчас\n {2}Починить\n/);
  // The journal is newest first under its live line: the trial run of setup, then its login.
  assert.match(text(), /\nЖУРНАЛ\n─+\n {2}опрошен 12:00:\d\d, ответил за 0,0 с\n {2}20 окт 12:00 {2}пробный · применять нечего · 0,0 с\n {2}20 окт 12:00 {2}вход · применять нечего · 0,0 с/);
  assert.equal(caption(screen.frame()), '', 'the caption shows under the cursor only');

  await press('down');
  assert.match(text(), /\n▸ Починить\n/);
  assert.equal(caption(screen.frame()), REPAIR_CAPTION);
  assert.ok(screen.frame().every(line => [...line].length <= 72), 'the caption wraps to the width');

  await press('tab');
  assert.match(text(), /СБРОСЫ · 2/);
  await press('tab');
  assert.match(text(), /ВОРКЕР/);
});

test('the screen «Воркер» in English', async () => {
  const { screen, press, text } = await opened({ language: 'en' });
  await press('tab');
  assert.match(text(), /\nWORKER\n─+\n● GitHub Actions · active\n/);
  assert.match(text(), /\nACCOUNTS\n─+\n {2}GitHub {4}octo-fake {3,}sign in again\n {2}ChatGPT {3}fake@example\.invalid · signed in {3,}sign in again\n/);
  assert.match(text(), /\nACTIONS\n─+\n▸ Check now · ~1 min of Actions\n {2}Repair\n {2}Pause\n/);
  assert.match(text(), /\nJOURNAL\n─+\n {2}polled 12:00:\d\d, answered in 0\.0 s\n {2}20 Oct 12:00 {2}trial · nothing to apply · 0\.0 s\n/);
  assert.equal(screen.frame().at(-1), '↑↓ select · Enter run · Tab resets · l language · r refresh · q quit');
});

test('«Проверить сейчас» on GitHub runs the trial run and the journal tells what the rules would apply', async () => {
  const { world, repo, screen, press, text } = await opened();
  world.chatgpt.credits.push(credit('reset-c', world.now + 2 * HOUR));
  await press('tab', 'return');
  assert.equal(repo.runs.length, 2);
  assert.deepEqual(repo.runs[0]?.inputs, { apply_now: '', trial_run: 'true' });
  assert.deepEqual(world.spent(), [], 'a trial run applies nothing');
  assert.match(text(), /\nЖУРНАЛ\n─+\n {2}опрошен 12:00:\d\d, ответил за 0,0 с\n {2}20 окт 12:00 {2}aures · Проверить сейчас: Воркер работает\. [^\n]* Сейчас правила применили бы сброс reset-c \(перед истечением\)\.\n {2}20 окт 12:00 {2}пробный · применили бы reset-c \(перед истечением\) · 0,0 с\n/);
  assert.equal(screen.busy, null);
});

test('«Проверить сейчас» on Google asks the worker for a trial run and the journal tells what the rules would apply', async () => {
  const { world, gas, press, text } = await openedOnGoogle();
  world.chatgpt.credits.push(credit('reset-c', world.now + 30 * MINUTE));
  await press('tab', 'return');
  assert.deepEqual(world.spent(), []);
  const journal = JSON.parse(gas.properties.get('journal') ?? '[]') as { kind: string; outcome: string }[];
  assert.deepEqual(journal.at(-1), { at: new Date(world.now).toISOString(), kind: 'trial', outcome: 'would_apply', durationMs: 0,
    wouldApply: { creditId: 'reset-c', reason: 'before_expiry' } });
  assert.match(text(), /\n {2}20 окт 12:00 {2}пробный · применили бы reset-c \(перед истечением\) · 0,0 с\n/);
  assert.match(text(), /aures · Проверить сейчас: [^\n]*Сейчас правила применили бы сброс reset-c \(перед истечением\)\./);
});

// What «Починить» must leave as it was on GitHub: the sealed state, the rules and the secrets.
const kept = (repo: NonNullable<ReturnType<Awaited<ReturnType<typeof cliWorld>>['world']['github']['repo']>>) => ({
  state: repo.files.get(FILES.state)?.text, rules: repo.files.get(FILES.rules)?.text, secrets: new Map(repo.secrets) });

test('«Починить» on GitHub puts this version\'s worker and workflow back and brings the schedule back, the state stays', async () => {
  const { world, repo, screen, press, text } = await opened();
  const workflow = world.github.text(repo, FILES.workflow), before = kept(repo), runs = repo.runs.length;
  world.github.write(repo, FILES.worker, '// changed by hand\n');
  repo.files.delete(FILES.workflow);
  repo.workflowState = 'disabled_manually';

  await press('tab', 'down', 'return');
  assert.equal(world.github.text(repo, FILES.worker), '// fake worker bundle\n');
  assert.equal(world.github.text(repo, FILES.workflow).replace(/^\s+- cron: .*$/m, ''), workflow.replace(/^\s+- cron: .*$/m, ''));
  assert.equal(repo.workflowState, 'active');
  assert.deepEqual(kept(repo), before);
  assert.equal(repo.runs.length, runs, 'no worker run');
  assert.match(text(), new RegExp(`aures · Починить: Воркер починен: залита версия ${pkg.version.replace(/\./g, '\\.')}, расписание вернулось\\.`));
  assert.equal(screen.busy, null);
  assert.deepEqual(world.github.violations, []);
});

test('«Починить» on GitHub keeps the cron minute of a workflow it rewrites', async () => {
  const { world, repo, press } = await opened();
  const workflow = world.github.text(repo, FILES.workflow);
  world.github.write(repo, FILES.workflow, workflow.replace('Worker', 'Worker changed by hand'));
  await press('tab', 'down', 'return');
  assert.equal(world.github.text(repo, FILES.workflow), workflow);
});

test('«Починить» on a paused GitHub worker puts the files back but not the schedule', async () => {
  const { world, repo, run, press, text } = await opened();
  assert.equal((await run(pauseWorker)).code, 0);
  world.github.write(repo, FILES.worker, '// changed by hand\n');
  const before = kept(repo);
  await press('tab');
  assert.match(text(), /\n● GitHub Actions · на паузе\n/);
  await press('down', 'return');
  assert.equal(world.github.text(repo, FILES.worker), '// fake worker bundle\n');
  assert.equal(repo.workflowState, 'disabled_manually');
  assert.deepEqual(kept(repo), before);
  assert.match(text(), /aures · Починить: Воркер починен: залита версия \S+\. Воркер на паузе, расписание осталось снятым\./);
});

test('«Починить» on Google deploys this version into the same deployment and brings the schedule back, the data stays', async () => {
  const { world, project, gas, screen, press, text, secretKeychain } = await openedOnGoogle();
  const [deploymentId] = [...project.deployments.keys()];
  const versions = project.versions.length;
  const source = project.files.find(file => file.name === 'worker')?.source;
  const worker = project.files.find(file => file.name === 'worker');
  assert.ok(worker);
  worker.source = '// changed by hand\n';
  gas.triggers.length = 0;
  const properties = new Map(gas.properties);

  await press('tab', 'down', 'return');
  assert.equal(screen.busy, null);
  assert.equal(project.files.find(file => file.name === 'worker')?.source, source);
  assert.deepEqual([...project.deployments], [[deploymentId, versions + 1]], 'the same deployment, so the same URL');
  assert.equal(await secretKeychain.read(), world.google.deployedSecret());
  const live = world.google.project()?.gas;
  assert.ok(live);
  assert.deepEqual(live.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.deepEqual(new Map(live.properties), properties, 'the state, the rules and the journal are untouched');
  assert.match(text(), /aures · Починить: Воркер починен: залита версия \S+, расписание вернулось\./);

  // The screen goes on with the new secret.
  await press('up', 'return');
  assert.match(text(), /aures · Проверить сейчас: /);
  assert.deepEqual(world.google.violations, []);
});

test('«Починить» on a paused Google worker deploys the code but leaves the schedule off', async () => {
  const { world, run, press, text } = await openedOnGoogle();
  assert.equal((await run(pauseWorker)).code, 0);
  await press('tab', 'down', 'return');
  assert.match(text(), /\n● Google Apps Script · на паузе\n/);
  assert.deepEqual(world.google.project()?.gas?.triggers, []);
  assert.match(text(), /Воркер на паузе, расписание осталось снятым\./);
});

test('«Пауза» and «Снять с паузы» on GitHub: the schedule goes off and comes back, the journal tells both steps', async () => {
  const { repo, mac, screen, press, text } = await opened();
  await press('tab');
  assert.match(text(), /\nДЕЙСТВИЯ\n─+\n▸ Проверить сейчас · ~1 мин Actions\n {2}Починить\n {2}Пауза\n/);

  await press('down', 'down', 'return');
  assert.equal(screen.busy, null);
  assert.equal(repo.workflowState, 'disabled_manually');
  assert.deepEqual(await mac.files.readInstall(), { platform: 'github', paused: true, accounts: { chatgpt: 'fake@example.invalid' } });
  assert.match(text(), /\n● GitHub Actions · на паузе\n/);
  assert.match(text(), /\n▸ Снять с паузы\n/, 'the action that applies to the state');
  assert.doesNotMatch(text(), /\n {2}Пауза\n/);
  assert.match(text(), /aures · Пауза: Воркер на паузе: расписание снято, вход и данные остаются\. «Применить сейчас» продолжает работать\./);

  await press('return');
  assert.equal(repo.workflowState, 'active');
  assert.equal((await mac.files.readInstall())?.paused, undefined);
  assert.match(text(), /\n● GitHub Actions · активен\n/);
  assert.match(text(), /\n▸ Пауза\n/, 'the worker can be paused again');
  assert.match(text(), /aures · Снять с паузы: Воркер снят с паузы: расписание вернулось\./);
});

test('«Пауза» and «Снять с паузы» on Google: the trigger goes off and comes back, the journal tells both steps', async () => {
  const { gas, mac, screen, press, text } = await openedOnGoogle();
  await press('tab');
  assert.match(text(), /\nДЕЙСТВИЯ\n─+\n▸ Проверить сейчас\n {2}Починить\n {2}Пауза\n/);

  await press('down', 'down', 'return');
  assert.equal(screen.busy, null);
  assert.deepEqual(gas.triggers, []);
  assert.equal((await mac.files.readInstall())?.paused, true);
  assert.match(text(), /\n● Google Apps Script · на паузе\n/);
  assert.match(text(), /\n▸ Снять с паузы\n/);
  assert.match(text(), /aures · Пауза: Воркер на паузе: расписание снято, вход и данные остаются\. «Применить сейчас» продолжает работать\./);

  await press('return');
  assert.deepEqual(gas.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.equal((await mac.files.readInstall())?.paused, undefined);
  assert.match(text(), /\n● Google Apps Script · активен\n/);
  assert.match(text(), /\n▸ Пауза\n/);
  assert.match(text(), /aures · Снять с паузы: Воркер снят с паузы: расписание вернулось\./);
});

test('«Починить» after «Пауза» from the screen puts the code in and leaves the schedule off', async () => {
  const { world, repo, screen, press, text } = await opened();
  world.github.write(repo, FILES.worker, '// changed by hand\n');
  await press('tab', 'down', 'down', 'return');
  assert.match(text(), /\n● GitHub Actions · на паузе\n/);

  await press('up', 'return');
  assert.equal(screen.busy, null);
  assert.equal(world.github.text(repo, FILES.worker), '// fake worker bundle\n');
  assert.equal(repo.workflowState, 'disabled_manually', 'the repair does not bring the schedule back');
  assert.match(text(), /aures · Пауза: Воркер на паузе: расписание снято/);
  assert.match(text(), /aures · Починить: Воркер починен: залита версия \S+\. Воркер на паузе, расписание осталось снятым\./);
});

// The web app polls the worker on Google; the Actions runs API on GitHub.
// A doPost is a POST and the GET of its redirect; the POSTs are counted.
const webAppPolls = (world: { google: { requests: { method: string; url: string }[] } }) =>
  world.google.requests.filter(r => r.method === 'POST' && r.url.includes('/macros/')).length;
const runListings = (world: { github: { requests: { method: string; path: string }[] } }) =>
  world.github.requests.filter(r => r.method === 'GET' && /\/actions\/workflows\/[^/]+\/runs$/.test(r.path)).length;

test('the screen «Воркер» polls Google every 30 s while it is open and stops on the resets and on close', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { world, screen, press } = await openedOnGoogle();
  await press('tab');
  const opened = webAppPolls(world);
  t.mock.timers.tick(29_999);
  await screen.polling;
  assert.equal(webAppPolls(world), opened);
  t.mock.timers.tick(1);
  await screen.polling;
  assert.equal(webAppPolls(world), opened + 1);
  t.mock.timers.tick(30_000);
  await screen.polling;
  assert.equal(webAppPolls(world), opened + 2);

  await press('tab');
  const onResets = webAppPolls(world);
  t.mock.timers.tick(5 * 30_000);
  await screen.polling;
  assert.equal(webAppPolls(world), onResets, 'no poll while the resets are shown');

  await press('tab');
  const again = webAppPolls(world);
  assert.equal(await screen.press({ name: 'q', sequence: 'q' }), 'exit');
  t.mock.timers.tick(5 * 30_000);
  await screen.polling;
  assert.equal(webAppPolls(world), again, 'no poll after the screen closed');
});

test('the screen «Воркер» polls GitHub every 60 s while it is open and stops on the resets and on close', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { world, screen, press, text } = await opened();
  await press('tab');
  const opened_ = runListings(world);
  t.mock.timers.tick(30_000);
  await screen.polling;
  assert.equal(runListings(world), opened_);
  world.advance(HOUR);
  await world.github.schedule();
  t.mock.timers.tick(30_000);
  await screen.polling;
  assert.equal(runListings(world), opened_ + 1);
  assert.match(text(), /опрошен 13:00:\d\d, ответил за 0,0 с\n {2}20 окт 13:00 {2}по расписанию · применять нечего/);

  await press('tab');
  const onResets = runListings(world);
  t.mock.timers.tick(5 * 60_000);
  await screen.polling;
  assert.equal(runListings(world), onResets);

  await press('tab');
  const again = runListings(world);
  assert.equal(await screen.press({ name: 'c', sequence: '\x03', ctrl: true }), 'exit');
  t.mock.timers.tick(5 * 60_000);
  await screen.polling;
  assert.equal(runListings(world), again);
});

test('the emails of the accounts come from the sign-ins; an install from before them names the accounts unknown', async () => {
  const { mac, run, screen, press, text } = await opened();
  assert.deepEqual((await mac.files.readInstall())?.accounts, { chatgpt: 'fake@example.invalid' }, 'setup keeps the ChatGPT email of the id_token');
  const install = await mac.files.readInstall();
  assert.ok(install);
  const { accounts: _accounts, ...before } = install;
  await mac.files.writeInstall(before);
  await press('tab');
  assert.match(text(), /\n {2}ChatGPT {3}аккаунт неизвестен · вход работает {3,}войти заново\n/);

  // `aures login` keeps the email of its new session; so does «войти заново» on the screen.
  const { code, io } = await run(login);
  assert.equal(code, 0, io.output());
  assert.deepEqual((await mac.files.readInstall())?.accounts, { chatgpt: 'fake@example.invalid' });
  await mac.files.writeInstall(before);
  await press('up', 'return');
  assert.equal(screen.busy, null);
  assert.match(text(), /aures · ChatGPT: Вход обновлён, правила и история на месте\./);
  assert.match(text(), /\n▸ ChatGPT {3}fake@example\.invalid · вход работает/);
});

test('a Google grant without the email scope is no broken grant: setup goes on and the account reads as unknown', async () => {
  const env = await cliWorld();
  env.world.google.grantsEmail = false;
  const { code, io } = await env.run(setup, { answers: ['2', ''] });
  assert.equal(code, 0, io.output());
  assert.match(io.output(), /\nВы вошли в Google\.\n/);
  assert.equal((await env.mac.files.readInstall())?.accounts?.google, undefined);
  let screen: Screen | undefined;
  await env.run(async options => { screen = await openScreen(options); return 0; });
  assert.ok(screen);
  await screen.press({ name: 'tab' });
  assert.match(screen.frame().join('\n'), /\n {2}Google {4}аккаунт неизвестен {3,}войти заново\n/);
  assert.deepEqual(env.world.google.violations, []);
});

test('«Войти заново» for Google signs the CLI in anew, keeps the email and ends the grant before it', async () => {
  const { world, googleKeychain, mac, screen, press, text } = await openedOnGoogle();
  const before = await googleKeychain.read();
  assert.ok(before && world.google.refreshTokens.has(before));
  world.google.email = 'other@example.invalid';
  await press('tab', 'up', 'up', 'return');
  assert.equal(screen.busy, null);
  assert.match(text(), /aures · Google: Вы вошли в Google как other@example\.invalid\./);
  assert.equal((await mac.files.readInstall())?.accounts?.google, 'other@example.invalid');
  assert.notEqual(await googleKeychain.read(), before);
  assert.equal(world.google.refreshTokens.has(before), false);
});

test('«Войти заново» for GitHub takes only the account of the worker repository', async () => {
  const { world, keychain, screen, press, text } = await opened();
  const before = await keychain.read();
  await press('tab', 'up', 'up', 'return');
  assert.match(text(), /aures · GitHub: Вы вошли в GitHub как octo-fake\./);
  const renewed = await keychain.read();
  assert.notEqual(renewed, before);

  world.github.login = 'someone-else';
  await press('return');
  assert.equal(screen.busy, null);
  assert.match(text(), /aures · GitHub: Это аккаунт GitHub someone-else, а воркер в octo-fake\. Войдите в него\./);
  assert.equal(await keychain.read(), renewed, 'the sign-in before it is back');
});
