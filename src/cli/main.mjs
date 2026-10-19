#!/usr/bin/env node
// `aures <command>`.
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { setup } from './setup.mjs';
import { status } from './status.mjs';
import { screen } from './screen.mjs';
import { applyNow } from './apply-now.mjs';
import { rules } from './rules.mjs';
import { login } from './login.mjs';
import { upgrade } from './upgrade.mjs';
import { uninstall } from './uninstall.mjs';
import { watch } from './watch.mjs';
import { WatchFiles } from './watch-files.mjs';
import { LaunchAgent } from './launch-agent.mjs';
import { GitHubTokenKeychain } from './keychain.mjs';
import { liveLine } from './live-line.mjs';
import { t, setLanguage, LANGUAGES } from './language.mjs';
import pkg from '../../package.json' with { type: 'json' };

// The worker bundle that setup and upgrade put into the repository: `npm run build:worker`.
const WORKER_BUNDLE = new URL('../../dist/worker.mjs', import.meta.url);
const COMMANDS = { setup, status, 'apply-now': applyNow, rules, login, upgrade, uninstall };
// The launchd agent runs `watch`; it is not in the usage. A locked Keychain may ask for the
// password in a dialog nobody sees, so the agent waits for it briefly.
const WATCH_KEYCHAIN_MS = 10_000;
const usage = () => t(`Usage: aures [command]
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

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (name === '--version' && !rest.length) {
    console.log(pkg.version);
    return 0;
  }
  const files = new WatchFiles();
  setLanguage(await files.readLanguage());
  if (name === 'language' && rest.length === 1 && LANGUAGES.includes(rest[0])) {
    setLanguage(rest[0]);
    await files.writeLanguage(rest[0]);
    console.log(t('The CLI speaks English.', 'Программа говорит по-русски.'));
    return 0;
  }
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  // Outside a terminal the screen is printed once, as `status`.
  const run = name === undefined ? tty ? screen : status : Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : name === 'watch' ? watch : null;
  if (!run || rest.length) {
    console.error(usage());
    return 2;
  }
  if (process.platform !== 'darwin') {
    console.error(t('aures runs on macOS only.', 'aures работает только на macOS.'));
    return 1;
  }
  if (run === watch) {
    return watch({ fetch: globalThis.fetch, keychain: new GitHubTokenKeychain({ timeoutMs: WATCH_KEYCHAIN_MS }),
      files, log: line => console.log(`${new Date().toISOString()} ${line}`) });
  }
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  if (run === screen) {
    const io = { print: line => console.log(line), color };
    // An action that Ctrl-C left unfinished must not keep the process alive.
    process.exit(await screen({ fetch: globalThis.fetch, keychain: new GitHubTokenKeychain(), io,
      mac: { files, agent: new LaunchAgent() }, terminal: { input: process.stdin, output: process.stdout } }));
  }
  let workerSource = null;
  if (name === 'setup' || name === 'upgrade') {
    workerSource = await readFile(WORKER_BUNDLE, 'utf8').catch(() => null);
    if (workerSource === null) {
      console.error(t('There is no worker build dist/worker.mjs. Build it: npm run build:worker',
        'Нет сборки воркера dist/worker.mjs. Соберите её: npm run build:worker'));
      return 1;
    }
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const { print, wait } = liveLine(process.stdout, { color });
  const io = { print, wait, prompt: question => terminal.question(question), color };
  try {
    return await run({ fetch: globalThis.fetch, keychain: new GitHubTokenKeychain(), io, workerSource,
      mac: { files, agent: new LaunchAgent() } });
  } finally { terminal.close(); }
}

process.exitCode = await main();
