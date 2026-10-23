import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceLogin } from '../src/chatgpt/session.ts';
import { showCode } from '../src/cli/common.ts';
import type { Printer } from '../src/cli/common.ts';
import type { DeviceCode } from '../src/chatgpt/session.ts';
import type { OpenUrl, CopyText } from '../src/cli/browser.ts';
import { setLanguage } from '../src/cli/language.ts';
import { setup } from '../src/cli/setup.ts';
import { uninstall } from '../src/cli/uninstall.ts';
import { fakeWorld } from './support/fake-world.ts';
import { cliWorld } from './support/cli-world.ts';

// Issue 23: a device-code login opens its page in the browser and copies the code to the
// clipboard, for ChatGPT and GitHub alike; a browser or a clipboard that does not work changes
// nothing — the line with the code is printed anyway and the login goes on.
setLanguage('ru');
const DEVICE = 'https://auth.openai.com/codex/device', GITHUB_DEVICE = 'https://github.com/login/device';

// A ChatGPT login that shows its code the way the CLI does, against the fake auth.openai.com:
// the user enters the code after a few polls; sleeping moves the fake world's clock.
async function login(world: ReturnType<typeof fakeWorld>, io: Printer, open: OpenUrl, copy: CopyText): Promise<{ code: DeviceCode }> {
  let shown: DeviceCode | null = null;
  let slept = 0;
  await deviceLogin({ fetch: world.fetch, now: () => world.now,
    onCode: code => { shown = code; return showCode(io, open, copy)(code); },
    sleep: async ms => {
      world.advance(ms); slept++;
      if (slept === 3) world.approve(shown?.userCode ?? '');
    } });
  assert.ok(shown);
  return { code: shown };
}

test('the device login opens the page, copies the code and says both', async () => {
  const world = fakeWorld();
  const lines: string[] = [];
  const opened: string[] = [], copied: string[] = [];
  const { code } = await login(world, { print: line => lines.push(line) },
    async url => { opened.push(url); }, async text => { copied.push(text); return true; });
  assert.deepEqual(opened, [DEVICE]);
  assert.deepEqual(copied, [code.userCode]);
  assert.deepEqual(lines, [
    `Откройте ${DEVICE} и введите код ${code.userCode} (код скопирован)`,
    `Если браузер не открылся: ${DEVICE}`,
  ]);
});

test('a browser or a clipboard that does not work changes nothing: the code is printed, the login completes', async () => {
  const clipboard: CopyText[] = [
    async () => { throw new Error('no clipboard'); },
    () => { throw new Error('no clipboard, at once'); },
    async () => false,
  ];
  for (const copy of clipboard) {
    const world = fakeWorld();
    const lines: string[] = [];
    const open: OpenUrl = () => { throw new Error('no browser'); };
    const { code } = await login(world, { print: line => lines.push(line) }, open, copy);
    assert.deepEqual(lines, [
      `Откройте ${DEVICE} и введите код ${code.userCode}`,
      `Если браузер не открылся: ${DEVICE}`,
    ], 'the code line stays, without the copied mark');
  }
});

test('the GitHub device login of setup opens the page and copies the code', async () => {
  const env = await cliWorld();
  const { code, io } = await env.run(setup, { answers: ['1', ''] });
  assert.equal(code, 0, io.output());
  assert.ok(env.world.google.opened.includes(GITHUB_DEVICE), 'the device page is opened');
  assert.ok(env.world.google.opened.includes(DEVICE), 'the ChatGPT page is opened too');
  assert.ok(env.copied.some(text => /^GHFK-\d+$/.test(text)), 'the GitHub code is copied');
  assert.ok(env.copied.some(text => /^FAKE-\d+$/.test(text)), 'the ChatGPT code is copied too');
  assert.match(io.output(), new RegExp(`Откройте ${GITHUB_DEVICE.replace(/\//g, '\\/')} и введите код GHFK-\\d+ \\(код скопирован\\)\n` +
    `Если браузер не открылся: ${GITHUB_DEVICE.replace(/\//g, '\\/')}`));
});

test('the GitHub device login of uninstall opens the page and copies the code', async () => {
  const env = await cliWorld();
  await env.run(setup, { answers: ['1', ''] });
  const opened = env.world.google.opened.length, copied = env.copied.length;
  const { code, io } = await env.run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  assert.deepEqual(env.world.google.opened.slice(opened), [GITHUB_DEVICE]);
  assert.ok(env.copied.slice(copied).some(text => /^GHFK-\d+$/.test(text)), 'the code is copied');
  assert.match(io.output(), /Для удаления репозитория[\s\S]*Откройте https:\/\/github\.com\/login\/device и введите код GHFK-\d+ \(код скопирован\)/);
});
