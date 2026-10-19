#!/usr/bin/env node
// `codex-auto-resets <command>`.
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { setup } from './setup.mjs';
import { status } from './status.mjs';
import { applyNow } from './apply-now.mjs';
import { rules } from './rules.mjs';
import { login } from './login.mjs';
import { upgrade } from './upgrade.mjs';
import { uninstall } from './uninstall.mjs';
import { watch } from './watch.mjs';
import { WatchFiles } from './watch-files.mjs';
import { LaunchAgent } from './launch-agent.mjs';
import { GitHubTokenKeychain } from './keychain.mjs';
import pkg from '../../package.json' with { type: 'json' };

// The worker bundle that setup and upgrade put into the repository: `npm run build:worker`.
const WORKER_BUNDLE = new URL('../../dist/worker.mjs', import.meta.url);
const COMMANDS = { setup, status, 'apply-now': applyNow, rules, login, upgrade, uninstall };
// The launchd agent runs `watch`; it is not in the usage. A locked Keychain may ask for the
// password in a dialog nobody sees, so the agent waits for it briefly.
const WATCH_KEYCHAIN_MS = 10_000;
const USAGE = `Использование: codex-auto-resets <команда>
  setup      установить или продолжить установку
  status     сбросы, правила и состояние воркера
  apply-now  применить сброс сейчас
  rules      когда применять сбросы
  login      заново войти в ChatGPT
  upgrade    обновить воркер после brew upgrade
  uninstall  удалить воркер и вход в GitHub
  --version  версия программы`;

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (name === '--version' && !rest.length) {
    console.log(pkg.version);
    return 0;
  }
  const run = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : name === 'watch' ? watch : null;
  if (!run || rest.length) {
    console.error(USAGE);
    return 2;
  }
  if (process.platform !== 'darwin') {
    console.error('codex-auto-resets работает только на macOS.');
    return 1;
  }
  if (run === watch) {
    return watch({ fetch: globalThis.fetch, keychain: new GitHubTokenKeychain({ timeoutMs: WATCH_KEYCHAIN_MS }),
      files: new WatchFiles(), log: line => console.log(`${new Date().toISOString()} ${line}`) });
  }
  let workerSource = null;
  if (name === 'setup' || name === 'upgrade') {
    workerSource = await readFile(WORKER_BUNDLE, 'utf8').catch(() => null);
    if (workerSource === null) {
      console.error('Нет сборки воркера dist/worker.mjs. Соберите её: npm run build:worker');
      return 1;
    }
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const io = { print: line => console.log(line), prompt: question => terminal.question(question) };
  try {
    return await run({ fetch: globalThis.fetch, keychain: new GitHubTokenKeychain(), io, workerSource,
      mac: { files: new WatchFiles(), agent: new LaunchAgent() } });
  } finally { terminal.close(); }
}

process.exitCode = await main();
