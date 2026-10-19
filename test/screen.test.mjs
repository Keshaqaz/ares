import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setup } from '../src/cli/setup.mjs';
import { openScreen, runScreen } from '../src/cli/screen.mjs';
import { FILES } from '../src/worker/layout.mjs';
import { readRules } from '../src/worker/state-file.mjs';
import { cliWorld } from './support/cli-world.mjs';
import { credit } from './support/fake-world.mjs';
import { status } from '../src/cli/status.mjs';
import { language } from '../src/cli/language.mjs';

const HINT = '↑↓ выбор · Enter применить / переключить · l язык · r обновить · q выход';

// The screen of a worker installed by setup with the default rules: resets reset-b (in 2 days
// 3 hours) and reset-a (in 5 days). Device codes the screen shows are approved at once.
async function opened({ language = 'ru' } = {}) {
  const env = await cliWorld({ language });
  const { code, io } = await env.run(setup, { answers: [''] });
  assert.equal(code, 0, io.output());
  let screen;
  const sleep = async ms => {
    for (const note of screen?.notes ?? []) for (const [found] of note.text.matchAll(/FAKE-\d+/g)) env.world.approve(found);
    env.world.advance(ms);
  };
  await env.run(async options => { screen = await openScreen({ ...options, sleep }); return 0; });
  const press = (...names) => names.reduce((done, name) => done.then(() => screen.press({ name, sequence: name })), Promise.resolve());
  const text = () => screen.frame().join('\n');
  return { ...env, repo: env.world.github.repo(), screen, press, text };
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
  assert.deepEqual(repo.runs[0].inputs, { apply_now: 'reset-a' });
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
  assert.equal(repo.commits.at(-1).message, 'Change the general rules');
  assert.match(text(), /Откройте https:\/\/auth\.openai\.com\/codex\/device и введите код FAKE-\d+/);
  assert.match(text(), /Правила сохранены и заработают со следующего запуска воркера\.\n.*\n.*\nВнеочередная проверка с этого Mac включена\.\n\n↑↓/);
  assert.match(text(), /▸ ☑ Когда кончится недельный лимит · проверка с Mac работает/);
  assert.ok(await mac.files.readSession());

  await press('return');
  assert.equal(readRules(world.github.text(repo, FILES.rules)).weeklyAutoApply, false);
  assert.match(text(), /Внеочередная проверка с этого Mac выключена, его вход в ChatGPT отозван\./);
  assert.equal(await mac.files.readSession(), null);
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
  assert.match(screen.frame().at(-1), /^Применить RES67F8 сейчас\?/);
  await press('y');
  assert.deepEqual(repo.runs[0].inputs, { apply_now: id });
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

test('the terminal: the screen takes the alternate screen, frames are drawn from the top, q gives the terminal back', async () => {
  const { screen } = await opened();
  const input = new PassThrough(), output = new PassThrough();
  let written = '';
  output.on('data', chunk => { written += chunk; });
  Object.assign(output, { columns: 100 });
  const done = runScreen(screen, { input, output });
  assert.ok(written.startsWith('\x1b[?1049h\x1b[?25l'), 'the alternate screen, without the cursor');
  input.write('\x1b[B');
  await new Promise(resolve => setImmediate(resolve));
  const frames = written.split('\x1b[H').slice(1);
  assert.equal(frames.length, 2, 'the second frame goes over the first');
  assert.match(frames[1], /^\x1b\[K\n {2}\x1b\[1maures/, 'a margin around the screen');
  assert.match(frames[1], /▸ \x1b\[0m\x1b\[1;36mreset-a/);
  input.write('q');
  assert.equal(await done, 0);
  assert.ok(written.endsWith('\x1b[?25h\x1b[?1049l'), 'the cursor and the terminal as it was are back');
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
