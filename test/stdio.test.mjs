import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { MockRpc } from '../testing/mock-rpc.mjs';
import { StdioRpc } from '../src/stdio.mjs';
import { AccountAdapter, parseRateLimits, weeklyEvidence } from '../src/account.mjs';

const rpcFixture = scenario => new StdioRpc({ file: process.execPath,
  args: [fileURLToPath(new URL('../testing/stdio-fixture.mjs', import.meta.url))],
  env: { PATH: process.env.PATH, AUTO_RESET_MOCK_SCENARIO: scenario },
}, { timeoutMs: 250 });

for (const [scenario, reason] of [
  ['hang', 'rpc_timeout'], ['broken', 'malformed_rpc'], ['ambiguous', 'malformed_rpc'],
  ['wrongId', 'malformed_rpc'], ['exit', 'process_exited'],
]) {
  test(`stdio ${scenario}: consume outcome stays unresolved and child terminates`, async () => {
    const rpc = rpcFixture(scenario);
    await rpc.start();
    const mock = new MockRpc();
    const account = new AccountAdapter(rpc, { accountId: () => mock.accountId });
    account.snapshot = { weekly: weeklyEvidence(await mock.request('account/rateLimits/read'), mock.accountId, Date.now() / 1000), credits: [{ id: 'selected-013', resetType: 'codexRateLimits', status: 'available', expiry: { kind: 'none' } }] };
    const result = await account.consume({ creditId: 'selected-013', idempotencyKey: 'synthetic-key' });
    assert.equal(result.state, 'unconfirmed');
    assert.equal(result.reason, reason);
    const child = rpc.child;
    await rpc.close();
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(rpc.pending.size, 0);
  });
}

test('timeout during initialize cleans up child', async () => {
  const rpc = rpcFixture('hangInitialize');
  await assert.rejects(rpc.start(), /rpc_timeout/);
  assert.equal(rpc.child, null);
});

test('unknown RPC outcome cannot become success', async () => {
  const rpc = rpcFixture('unknownOutcome');
  try {
    await rpc.start();
    const mock = new MockRpc();
    const account = new AccountAdapter(rpc, { accountId: () => mock.accountId });
    account.snapshot = { weekly: weeklyEvidence(await mock.request('account/rateLimits/read'), mock.accountId, Date.now() / 1000), credits: [{ id: 'selected-013', resetType: 'codexRateLimits', status: 'available', expiry: { kind: 'none' } }] };
    assert.equal((await account.consume({ creditId: 'selected-013', idempotencyKey: 'synthetic-key' })).state, 'unconfirmed');
    assert.throws(() => rpc.request('turn/start', {}), /method_forbidden/);
  } finally { await rpc.close(); }
});

test('UTF-8 split across pipe chunks survives JSONL parsing', async () => {
  const rpc = rpcFixture('unicode');
  try {
    await rpc.start();
    assert.equal((await rpc.request('account/read')).unicode, 'сброс');
  } finally { await rpc.close(); }
});

test('unsafe count, duplicate IDs, malformed timestamps fail closed; omitted expiry stays unknown', () => {
  const row = { id: 'selected', resetType: 'codexRateLimits', status: 'available', grantedAt: 100, expiresAt: null };
  const response = (credits, availableCount = 2) => ({ rateLimits: {}, rateLimitResetCredits: { availableCount, credits } });
  assert.throws(() => parseRateLimits(response([row], 2 ** 60)), /invalid_read/);
  assert.throws(() => parseRateLimits(response([row, row])), /invalid_read/);
  assert.throws(() => parseRateLimits(response([{ ...row, expiresAt: 'later' }])), /invalid_read/);
  assert.throws(() => parseRateLimits(response([row], 0)), /invalid_read/);
  const { expiresAt, ...missing } = row;
  assert.equal(parseRateLimits(response([missing])).credits[0].expiry.kind, 'unknown');
});

test('unexpected external refresh request gets a fixed refusal and terminates the interval without a new access token', async () => {
  const rpc = rpcFixture('externalRefresh'); rpc.stopOnExternalRefresh = true;
  const responses = [], write = rpc.write.bind(rpc);
  rpc.write = message => { if (message.error) responses.push(message); return write(message); };
  try {
    await rpc.start();
    await assert.rejects(rpc.request('account/read', {}), /external_refresh_required/);
    assert.deepEqual(responses, [{ id: 'refresh-from-child', error: { code: -32601, message: 'No server request handler configured' } }]);
    // A later request reports why the transport closed, not a generic transport_closed.
    await assert.rejects(rpc.request('account/read', {}), /external_refresh_required/);
  } finally { await rpc.close(); }
});
