import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setup } from '../src/cli/setup.ts';
import { openScreen, runScreen } from '../src/cli/screen.ts';
import type { Screen } from '../src/cli/screen.ts';
import { FILES } from '../src/worker/layout.ts';
import { readRules } from '../src/worker/state-file.ts';
import { cliWorld } from './support/cli-world.ts';
import { credit } from './support/fake-world.ts';
import { status } from '../src/cli/status.ts';
import { language } from '../src/cli/language.ts';
import type { Language } from '../src/cli/language.ts';

const HINT = '↑↓ выбор · Enter применить / переключить · l язык · r обновить · q выход';

// The screen of a worker installed by setup with the default rules: resets reset-b (in 2 days
// 3 hours) and reset-a (in 5 days). Device codes the screen shows are approved at once.
async function opened({ language = 'ru' }: { language?: Language } = {}) {
  const env = await cliWorld({ language });
  const { code, io } = await env.run(setup, { answers: [''] });
  assert.equal(code, 0, io.output());
  let screen: Screen | undefined;
  const sleep = async (ms: number) => {
    for (const note of screen?.notes ?? []) for (const [found] of note.text.matchAll(/FAKE-\d+/g)) env.world.approve(found);
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
  assert.equal(screen.frame()[0], `aures${' '.repeat(45)}20 Oct 12:00   EN · RU`);
  assert.equal(screen.frame()[4], `▸ reset-b   in 2d 2h${' '.repeat(40)}22 Oct 15:00`);
  assert.match(text(), /RULES\n─+\n {2}☑ Before expiry \(in the last 8 hours\)\n {2}☐ When the weekly limit runs out/);
  assert.match(text(), /● worker works · last run 20 Oct 12:00/);
  assert.equal(screen.frame().at(-1), '↑↓ select · Enter apply / switch · l language · r refresh · q quit');

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
  assert.match(io.output(), /^aures +20 Oct 12:00\n/, 'status has no language toggle');
  assert.match(io.output(), /RESETS · 2/);
});
