import { createInterface } from 'node:readline';
import { StdioRpc, RpcFailure } from './account/stdio.mjs';
import { AccountAdapter } from './account/account.mjs';
import { syntheticAccountId } from '../test/support/fake-backend.mjs';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { FileStateStore, StateFailure } from './core/state-store.mjs';
import { CycleEngine } from './core/reset-cycles.mjs';
import { renderCycleReport } from './core/cycle-report.mjs';

// Commands are JSONL on stdin, results JSONL on stdout. No secrets or shell interpolation.
// Live account activation requires 14/15/17/21; only synthetic modes are exposed here.
const args = process.argv.slice(2);
const validArgs = [2, 4].includes(args.length) && args[0] === '--mode' &&
  (args.length === 2 || args[2] === '--state' && args[3].length > 0);
const mode = validArgs ? args[1] : null;
const statePath = validArgs && args.length === 4 ? args[3] : null;
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const pins = JSON.parse(await readFile(new URL('./runtime-lock.json', import.meta.url), 'utf8'));
if (process.version !== `v${pins.node}`) {
  output({ error: 'node_version_mismatch', required: pins.node });
  process.exitCode = 1;
} else if (!['mock', 'app-server-fake'].includes(mode)) {
  output({ error: 'usage', usage: 'node src/cli.mjs --mode mock|app-server-fake [--state PATH] (JSONL commands on stdin)' });
  process.exitCode = 1;
} else {
  let cleanup;
  try {
    let account;
    if (mode === 'mock') {
      const rpc = new StdioRpc({ file: process.execPath,
        args: [fileURLToPath(new URL('../test/support/stdio-fixture.mjs', import.meta.url))],
        env: { PATH: process.env.PATH }, cwd: fileURLToPath(new URL('..', import.meta.url)) });
      cleanup = () => rpc.close();
      await rpc.start();
      account = new AccountAdapter(rpc, { accountId: () => syntheticAccountId });
    } else {
      const { bench } = await import('../test/support/bench.mjs');
      const stand = await bench();
      cleanup = stand.close;
      account = stand.account;
    }
    const store = statePath ? new FileStateStore(statePath) : null;
    const cycles = store ? new CycleEngine(store, account) : null;
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
      let command;
      try {
        if (Buffer.byteLength(line) > 4096) throw new RpcFailure('command_too_large');
        command = JSON.parse(line);
        if (!command || typeof command !== 'object' || Array.isArray(command)) throw new RpcFailure('invalid_command');
        let result;
        if (cycles) {
          const allowed = {
            init: ['command', 'language'], status: ['command', 'format'], run: ['command', 'creditId'],
            refresh: ['command'], reconnect: ['command'],
            control: ['command', 'action', 'commandId', 'expectedVersion', 'creditId', 'deltaSeconds', 'scheduledAt', 'automation', 'acknowledgeDelayRisk', 'enabled'],
          }[command.command];
          if (!allowed || Object.keys(command).some(key => !allowed.includes(key))) throw new StateFailure('invalid_command');
          if (command.command === 'init') { await store.initialize(command.language); result = await cycles.status(); }
          else if (command.command === 'status') {
            if (command.format !== undefined && !['json', 'markdown'].includes(command.format)) throw new StateFailure('invalid_format');
            result = await cycles.status();
            if (command.format === 'markdown') result = { markdown: renderCycleReport(result) };
          } else if (command.command === 'run') {
            if (command.creditId !== undefined && (typeof command.creditId !== 'string' || !command.creditId)) throw new StateFailure('invalid_command');
            result = await cycles.run(command.creditId);
          } else if (command.command === 'refresh') result = await cycles.refresh();
          else if (command.command === 'reconnect') result = await cycles.reconnect();
          else { const { command: ignored, ...control } = command; result = await cycles.command(control); }
        } else {
          const fields = command.command === 'consume' ? ['command', 'creditId', 'idempotencyKey'] : ['command'];
          if (Object.keys(command).some(key => !fields.includes(key))) throw new RpcFailure('invalid_command');
          if (command.command === 'read') result = await account.read();
          else if (command.command === 'refresh') result = await account.refresh();
          else if (command.command === 'reconnect') result = await account.reconnect();
          else if (command.command === 'consume') { await account.read(); result = await account.consume(command); }
          else throw new RpcFailure('unknown_command');
        }
        output({ mode, command: command.command, result });
      } catch (error) {
        output({ mode, command: command?.command ?? null, error: error instanceof RpcFailure || error instanceof StateFailure ? error.kind : 'invalid_command' });
        process.exitCode = 1;
      }
    }
  } catch (error) {
    output({ mode, error: error instanceof RpcFailure || error instanceof StateFailure ? error.kind : 'runtime_unavailable' });
    process.exitCode = 1;
  } finally { await cleanup?.(); }
}
