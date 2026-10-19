#!/usr/bin/env node
// `aures <command>`.
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { setup } from './setup.ts';
import { status } from './status.ts';
import { screen } from './screen.ts';
import { applyNow } from './apply-now.ts';
import { rules } from './rules.ts';
import { login } from './login.ts';
import { upgrade } from './upgrade.ts';
import { uninstall } from './uninstall.ts';
import { watch } from './watch.ts';
import { WatchFiles } from './watch-files.ts';
import { LaunchAgent } from './launch-agent.ts';
import { GitHubTokenKeychain } from './keychain.ts';
import { liveLine } from './live-line.ts';
import type { CommandOptions } from './common.ts';
import { t, setLanguage, isLanguage } from './language.ts';
import pkg from '../../package.json' with { type: 'json' };

// The worker bundle that setup and upgrade put into the repository: `npm run build:worker`.
const WORKER_BUNDLE = new URL('../../dist/worker.mjs', import.meta.url);
type Command = (options: CommandOptions) => Promise<number>;
// Without the bundle setup and upgrade do not start.
const withBundle = (command: (options: CommandOptions & { workerSource: string }) => Promise<number>): Command => async options => {
  const workerSource = await readFile(WORKER_BUNDLE, 'utf8').catch(() => null);
  if (workerSource === null) {
    console.error(t('There is no worker build dist/worker.mjs. Build it: npm run build:worker',
      'Нет сборки воркера dist/worker.mjs. Соберите её: npm run build:worker'));
    return 1;
  }
  return command({ ...options, workerSource });
};
const COMMANDS: Record<string, Command> = { setup: withBundle(setup), status, 'apply-now': applyNow, rules, login,
  upgrade: withBundle(upgrade), uninstall };
// The launchd agent runs `watch`; it is not in the usage. A locked Keychain may ask for the
// password in a dialog nobody sees, so the agent waits for it briefly.
const WATCH_KEYCHAIN_MS = 10_000;
const usage = (): string => t(`Usage: aures [command]
  (no command)   the screen: resets and rules; Enter applies a reset or switches a rule
  status         the same printed once, without controls
  setup          install, or finish an interrupted install
  apply-now      apply a reset now
  rules          choose when resets are applied
  login          sign the worker in to ChatGPT again
  upgrade        update the worker after brew upgrade
  uninstall      remove the worker, the Mac check and the GitHub sign-in
  language       en or ru: the language of the CLI
  --version      the program version`, `Использование: aures [команда]
  (без команды)  экран: сбросы и правила; Enter применяет сброс или переключает правило
  status         то же одним выводом, без управления
  setup          установить или продолжить установку
  apply-now      применить сброс сейчас
  rules          когда применять сбросы
  login          заново войти в ChatGPT
  upgrade        обновить воркер после brew upgrade
  uninstall      удалить воркер, проверку с Mac и вход в GitHub
  language       en или ru: язык программы
  --version      версия программы`);

async function main(): Promise<number> {
  const [name, ...rest] = process.argv.slice(2);
  if (name === '--version' && !rest.length) {
    console.log(pkg.version);
    return 0;
  }
  const files = new WatchFiles();
  setLanguage(await files.readLanguage());
  const [choice] = rest;
  if (name === 'language' && rest.length === 1 && isLanguage(choice)) {
    setLanguage(choice);
    await files.writeLanguage(choice);
    console.log(t('The CLI speaks English.', 'Программа говорит по-русски.'));
    return 0;
  }
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  // Outside a terminal the screen is printed once, as `status`.
  const run = name === undefined ? tty ? 'screen' : status : Object.hasOwn(COMMANDS, name) ? COMMANDS[name] ?? null : name === 'watch' ? 'watch' : null;
  if (!run || rest.length) {
    console.error(usage());
    return 2;
  }
  if (process.platform !== 'darwin') {
    console.error(t('aures runs on macOS only.', 'aures работает только на macOS.'));
    return 1;
  }
  if (run === 'watch') {
    return watch({ fetch: globalThis.fetch, keychain: new GitHubTokenKeychain({ timeoutMs: WATCH_KEYCHAIN_MS }),
      files, log: line => console.log(`${new Date().toISOString()} ${line}`) });
  }
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  if (run === 'screen') {
    const io = { print: (line: string) => console.log(line), color };
    // An action that Ctrl-C left unfinished must not keep the process alive.
    process.exit(await screen({ fetch: globalThis.fetch, keychain: new GitHubTokenKeychain(), io,
      mac: { files, agent: new LaunchAgent() }, terminal: { input: process.stdin, output: process.stdout } }));
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const { print, wait } = liveLine(process.stdout, { color });
  const io = { print, wait, prompt: (question: string) => terminal.question(question), color };
  try {
    return await run({ fetch: globalThis.fetch, keychain: new GitHubTokenKeychain(), io, mac: { files, agent: new LaunchAgent() } });
  } finally { terminal.close(); }
}

process.exitCode = await main();
