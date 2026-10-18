#!/usr/bin/env node
// `codex-auto-resets <command>`.
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { setup } from './setup.mjs';
import { status } from './status.mjs';
import { applyNow } from './apply-now.mjs';
import { rules } from './rules.mjs';
import { login } from './login.mjs';
import { GitHubTokenKeychain } from './keychain.mjs';

// The worker bundle that setup puts into the repository: `npm run build:worker`.
const WORKER_BUNDLE = new URL('../../dist/worker.mjs', import.meta.url);
const COMMANDS = { setup, status, 'apply-now': applyNow, rules, login };
const USAGE = `Использование: codex-auto-resets <команда>
  setup      установить воркер или дозаполнить установку
  status     сбросы, правила и последний запуск воркера
  apply-now  применить выбранный сброс сейчас
  rules      включить или выключить общие правила
  login      заново войти в ChatGPT, если сессия воркера потеряна`;

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  const run = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
  if (!run || rest.length) {
    console.error(USAGE);
    return 2;
  }
  if (process.platform !== 'darwin') {
    console.error('CLI работает только на macOS: токен GitHub хранится в Keychain.');
    return 1;
  }
  let workerSource = null;
  if (name === 'setup') {
    workerSource = await readFile(WORKER_BUNDLE, 'utf8').catch(() => null);
    if (workerSource === null) {
      console.error('Нет сборки воркера dist/worker.mjs. Соберите её: npm run build:worker');
      return 1;
    }
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const io = { print: line => console.log(line), prompt: question => terminal.question(question) };
  try {
    return await run({ fetch: globalThis.fetch, keychain: new GitHubTokenKeychain(), io, workerSource });
  } finally { terminal.close(); }
}

process.exitCode = await main();
