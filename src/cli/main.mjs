#!/usr/bin/env node
// `codex-auto-resets <command>`. Only setup exists so far.
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { setup } from './setup.mjs';
import { GitHubTokenKeychain } from './keychain.mjs';

// The worker bundle that setup puts into the repository: `npm run build:worker`.
const WORKER_BUNDLE = new URL('../../dist/worker.mjs', import.meta.url);
const USAGE = 'Использование: codex-auto-resets setup';

const [command, ...rest] = process.argv.slice(2);
if (command !== 'setup' || rest.length) {
  console.error(USAGE);
  process.exitCode = 2;
} else if (process.platform !== 'darwin') {
  console.error('CLI работает только на macOS: токен GitHub хранится в Keychain.');
  process.exitCode = 1;
} else {
  const workerSource = await readFile(WORKER_BUNDLE, 'utf8').catch(() => null);
  if (workerSource === null) {
    console.error('Нет сборки воркера dist/worker.mjs. Соберите её: npm run build:worker');
    process.exitCode = 1;
  } else {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    const io = { print: line => console.log(line), prompt: question => terminal.question(question) };
    try {
      process.exitCode = await setup({ fetch: globalThis.fetch, keychain: new GitHubTokenKeychain(), io, workerSource });
    } finally { terminal.close(); }
  }
}
