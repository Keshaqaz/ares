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
import { GitHubTokenKeychain, KeychainEntry, GOOGLE_TOKEN_ACCOUNT, WORKER_SECRET_ACCOUNT } from './keychain.ts';
import { openInBrowser, copyToClipboard } from './browser.ts';
import { liveLine } from './live-line.ts';
import type { CommandOptions } from './common.ts';
import { t, setLanguage, startLanguage, readSystemLanguage, isLanguage } from './language.ts';
import pkg from '../../package.json' with { type: 'json' };

// The worker bundles that setup and upgrade deploy: `npm run build:worker`.
const WORKER_BUNDLE = new URL('../../dist/worker.mjs', import.meta.url);
const APPS_SCRIPT_BUNDLE = new URL('../../dist/apps-script/worker.js', import.meta.url);
type Command = (options: CommandOptions) => Promise<number>;
interface Bundles { workerSource: string; appsScriptSource: string }
// null for a bundle that is not built.
const readBundles = (): Promise<(string | null)[]> =>
  Promise.all([WORKER_BUNDLE, APPS_SCRIPT_BUNDLE].map(url => readFile(url, 'utf8').catch(() => null)));
// Without the bundles setup and upgrade do not start.
const withBundle = (command: (options: CommandOptions & Bundles) => Promise<number>): Command => async options => {
  const [workerSource, appsScriptSource] = await readBundles();
  if (workerSource == null || appsScriptSource == null) {
    console.error(t('There is no worker build in dist/. Build it: npm run build:worker',
      'Нет сборки воркера в dist/. Соберите её: npm run build:worker'));
    return 1;
  }
  return command({ ...options, workerSource, appsScriptSource });
};
// The Keychain entries, the browser and the clipboard every command gets.
const access = () => ({ keychain: new GitHubTokenKeychain(), googleKeychain: new KeychainEntry(GOOGLE_TOKEN_ACCOUNT),
  secretKeychain: new KeychainEntry(WORKER_SECRET_ACCOUNT), open: openInBrowser, copy: copyToClipboard });
// «2026-10-20T05:02:21+07:00»: the Mac's time with its offset, as the screen shows times.
function localStamp(date = new Date()): string {
  const offset = -date.getTimezoneOffset(), pad = (n: number) => String(n).padStart(2, '0');
  const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, 19);
  return `${local}${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
const COMMANDS: Record<string, Command> = { setup: withBundle(setup), status, 'apply-now': applyNow, rules, login,
  upgrade: withBundle(upgrade), uninstall };
// The launchd agent runs `watch`; it is not in the usage. A locked Keychain may ask for the
// password in a dialog nobody sees, so the agent waits for it briefly.
const WATCH_KEYCHAIN_MS = 10_000;
const usage = (): string => t(`Usage: aures [command]
  (no command)   the screen: resets and rules; Enter applies a reset or switches a rule;
                 Tab — the screen «Worker»: check now, repair, pause, switch platform, the journal
  status         the same printed once, without controls
  setup          install, or finish an interrupted install
  apply-now      apply a reset now
  rules          choose when resets are applied
  login          sign the worker in to ChatGPT again
  upgrade        update the worker after brew upgrade
  uninstall      remove the worker, the Mac check and the sign-ins
  language       en or ru: the language of the CLI
  --version      the program version`, `Использование: aures [команда]
  (без команды)  экран: сбросы и правила; Enter применяет сброс или переключает правило;
                 Tab — экран «Воркер»: проверить сейчас, починить, пауза, смена площадки, журнал
  status         то же одним выводом, без управления
  setup          установить или продолжить установку
  apply-now      применить сброс сейчас
  rules          когда применять сбросы
  login          заново войти в ChatGPT
  upgrade        обновить воркер после brew upgrade
  uninstall      удалить воркер, проверку с Mac и входы
  language       en или ru: язык программы
  --version      версия программы`);

async function main(): Promise<number> {
  const [name, ...rest] = process.argv.slice(2);
  if (name === '--version' && !rest.length) {
    console.log(pkg.version);
    return 0;
  }
  const files = new WatchFiles();
  // The pick in settings.json wins; without one the language follows the system, and only
  // the pick is written — by `aures language` below or `l` on the screen.
  setLanguage(startLanguage(await files.readLanguage(), await readSystemLanguage()));
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
      secretKeychain: new KeychainEntry(WORKER_SECRET_ACCOUNT, { timeoutMs: WATCH_KEYCHAIN_MS }),
      files, log: line => console.log(`${localStamp()} ${line}`) });
  }
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  if (run === 'screen') {
    // A question before the screen opens (where the worker is) gets a line of its own.
    const prompt = async (question: string) => {
      const line = createInterface({ input: process.stdin, output: process.stdout });
      try { return await line.question(question); } finally { line.close(); }
    };
    const io = { print: (line: string) => console.log(line), prompt, color };
    // «Починить» on the screen «Воркер» deploys the bundles; without them it says so.
    const [workerSource = null, appsScriptSource = null] = await readBundles();
    // An action that Ctrl-C left unfinished must not keep the process alive.
    process.exit(await screen({ fetch: globalThis.fetch, ...access(), io, workerSource, appsScriptSource,
      mac: { files, agent: new LaunchAgent() }, terminal: { input: process.stdin, output: process.stdout } }));
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const { print, wait } = liveLine(process.stdout, { color });
  const io = { print, wait, prompt: (question: string) => terminal.question(question), color };
  try {
    return await run({ fetch: globalThis.fetch, ...access(), io, mac: { files, agent: new LaunchAgent() } });
  } finally { terminal.close(); }
}

process.exitCode = await main();
