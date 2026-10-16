import { appendFileSync } from 'node:fs';
import { FileStateStore } from '../src/state-store.mjs';
import { CycleEngine } from '../src/reset-cycles.mjs';
import { AccountAdapter } from '../src/account.mjs';
import { MockRpc } from './mock-rpc.mjs';
import { credit } from './fake-backend.mjs';

const [path, audit, stage] = process.argv.slice(2);
const now = () => 1893456000;
const rpc = new MockRpc();
rpc.state.rows = [credit('a', { expires_at: new Date((now() + 7200) * 1000).toISOString() })];
rpc.state.count = 1;
const original = rpc.request.bind(rpc);
rpc.request = (method, params) => {
  if (method === 'account/rateLimitResetCredit/consume') {
    appendFileSync(audit, `${JSON.stringify(params)}\n`);
    if (stage === 'afterSend') process.exit(74);
  }
  return original(method, params);
};
const engine = new CycleEngine(new FileStateStore(path), new AccountAdapter(rpc, { now }), {
  now, checkpoint: async name => { if (name === stage) process.exit(74); },
});
await engine.run();
