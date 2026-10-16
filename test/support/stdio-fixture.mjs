import { createInterface } from 'node:readline';
import { MockRpc } from './mock-rpc.mjs';

const mock = new MockRpc();
const scenario = process.env.AUTO_RESET_MOCK_SCENARIO;
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === 'initialize') {
    if (scenario === 'hangInitialize') continue;
    write({ id: message.id, result: await mock.start() });
    continue;
  }
  if (scenario === 'externalRefresh') {
    write({ id: 'refresh-from-child', method: 'account/chatgptAuthTokens/refresh', params: { reason: 'unauthorized' } });
    continue;
  }
  if (scenario === 'hang') continue;
  if (scenario === 'exit') process.exit(0);
  if (scenario === 'broken') { process.stdout.write('broken-json\n'); continue; }
  if (scenario === 'ambiguous') { write({ id: message.id, result: {}, error: { code: -32603 } }); continue; }
  if (scenario === 'wrongId') { write({ id: 'unexpected', result: {} }); continue; }
  if (scenario === 'unknownOutcome') { write({ id: message.id, result: { outcome: 'surprise' } }); continue; }
  if (scenario === 'unicode') {
    const bytes = Buffer.from(`${JSON.stringify({ id: message.id, result: { unicode: 'сброс' } })}\n`);
    for (const byte of bytes) { process.stdout.write(Buffer.from([byte])); await new Promise(resolve => setImmediate(resolve)); }
    continue;
  }
  try { write({ id: message.id, result: await mock.request(message.method, message.params) }); }
  catch (error) { write({ id: message.id, error: { code: error.code ?? -32603, message: 'synthetic error' } }); }
}
