import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, open, readFile } from 'node:fs/promises';
import { bench } from './support/bench.mjs';

const real = process.env.AUTO_RESET_CONTRACT_MODE === 'app-server';

test('stock managed auth: successful account response hides rotated tokens lost on file-save failure', { skip: !real }, async t => {
  const b = await bench();
  t.after(async () => {
    await chmod(b.authPath, 0o600);
    await b.close();
    assert.deepEqual(b.backend.state.violations, []);
  });
  const before = await readFile(b.authPath);
  b.backend.state.beforeRefreshReply = async () => {
    await chmod(b.authPath, 0o400);
    // Confirm this runtime user really cannot truncate, not merely a changed mode bit.
    await assert.rejects(open(b.authPath, 'w'), { code: 'EACCES' });
  };
  assert.equal((await b.account.refresh()).kind, 'accountRead');
  assert.equal(b.backend.state.refreshes, 1); // Synthetic backend issued the new tokens.
  assert.deepEqual(await readFile(b.authPath), before); // Client lost them, yet returned account.
});

test('stock managed auth: process exit while refresh reply is pending does not settle rotation', { skip: !real }, async t => {
  const b = await bench();
  let release, seen;
  const started = new Promise(resolve => { seen = resolve; });
  b.backend.state.beforeRefreshReply = async () => {
    seen();
    await new Promise(resolve => { release = resolve; });
  };
  t.after(async () => { release?.(); await b.close(); assert.deepEqual(b.backend.state.violations, []); });
  const before = await readFile(b.authPath);
  const refresh = b.account.refresh();
  const failed = assert.rejects(refresh, /transport_closed|process_exited/);
  await Promise.race([started, failed.then(() => { throw new Error('refresh stopped before synthetic rotation'); })]);
  await b.rpc.close();
  await failed;
  release();
  assert.equal(b.backend.state.refreshes, 1);
  assert.deepEqual(await readFile(b.authPath), before);
  assert.ok(b.audit.every(row => !/^(thread|turn|model)\//.test(row.method)));
});

// Exploration requested by the user, not an enabled production auth mode.
test('alternative: stock external-token mode supports selected reset RPC without owning refresh tokens', { skip: !real }, async t => {
  const b = await bench({ authMode: 'external' });
  t.after(async () => { await b.close(); assert.deepEqual(b.backend.state.violations, []); });
  const refreshed = await b.account.refresh();
  // 0.160.1 reports account type chatgpt even after confirmed chatgptAuthTokens login.
  // Account type cannot be used to infer who owns refresh. The host owns this mode.
  assert.equal(refreshed.kind, 'accountRead');
  assert.equal((await b.account.read()).kind, 'details');
  const result = await b.account.consume({ creditId: 'selected-013', idempotencyKey: 'synthetic-external-015' }, { refreshAfter: false });
  assert.equal(result.state, 'applied');
  assert.equal(b.backend.state.refreshes, 0);
  await assert.rejects(readFile(b.authPath), { code: 'ENOENT' });
  assert.ok(b.audit.every(row => !/^(thread|turn|model)\//.test(row.method)));
});
