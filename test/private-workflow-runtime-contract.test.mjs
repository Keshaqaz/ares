import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { privateWorkflowFixture } from '../testing/private-workflow-fixture.mjs';
import { fakeBackend } from '../testing/fake-backend.mjs';
import { syntheticNetworkGuard } from '../testing/bench.mjs';
import { ExternalAuthRuntime } from '../src/external-auth-runtime.mjs';
import { HostOAuth } from '../src/host-oauth.mjs';
import { StdioRpc } from '../src/stdio.mjs';

const real = process.env.AUTO_RESET_CONTRACT_MODE === 'app-server';
const binary = () => realpathSync(process.env.AUTO_RESET_CODEX_BIN ??
  process.env.PATH.split(':').map(dir => join(dir, 'codex')).find(path => existsSync(path)));

async function stockFixture(t) {
  const f = await privateWorkflowFixture(t);
  f.backend = await fakeBackend(); t.after(() => f.backend.close());
  f.backend.state.weeklyExhausted = true;
  f.backend.state.rows = f.rpc.state.rows; f.backend.state.count = 1;
  f.audit = []; f.launches = [];
  f.oauth = new HostOAuth({ now: () => f.clock, syntheticEndpoint: `${f.backend.url}/oauth/token`,
    fetchImpl: async (url, options) => { await f.emit('host.oauth'); return fetch(url, options); } });
  f.external = new ExternalAuthRuntime({ binary: binary(), syntheticBackend: f.backend.url,
    networkGuard: await syntheticNetworkGuard(f.backend.url), audit: e => f.audit.push(e),
    observeLaunch: e => {
      f.launches.push(e);
      assert.equal(f.github.state.auth.phase, 'ready');
      assert.ok(f.github.secret);
      assert.ok(!/synthetic-refresh|synthetic-PAT|authBase64|id_token|refresh_token/.test(JSON.stringify(e.launch)));
    } });
  f.calls = () => f.backend.state.requests.filter(r => r.creditId);
  return f;
}
const job = async (f, options) => { f.enqueue(options); return f.actions.start(); };

for (const failure of ['success', 'nothingToReset', '401', 'lost-response', 'success-response-401', 'post-success-401']) {
  test(`stock private workflow synthetic HTTP: ${failure}, fresh state/Secret and no replay`, { skip: !real }, async t => {
    const f = await stockFixture(t); await f.select();
    if (failure === 'nothingToReset') f.backend.state.outcome = 'nothing_to_reset';
    if (failure === '401') f.backend.state.consumeStatus = 401;
    if (failure === 'lost-response') f.backend.state.loss = true;
    if (failure === 'success-response-401') {
      f.backend.state.beforeConsumeReply = () => { f.backend.state.consumeStatus = 401; };
    }
    if (failure === 'post-success-401') {
      f.backend.state.beforeConsumeReply = () => { f.backend.state.usageStatus = 401; };
    }
    const result = await job(f);
    const journal = f.github.state.requests;
    assert.equal(journal.length, 1); assert.equal(f.calls().length, 1);
    assert.equal(journal[0].state, failure === 'nothingToReset' ? 'nothingToReset' :
      ['401', 'lost-response', 'success-response-401'].includes(failure) ? 'unconfirmed' : 'applied');
    assert.deepEqual(f.calls().map(({ creditId, idempotencyKey }) => ({ creditId, idempotencyKey })),
      [{ creditId: journal[0].creditId, idempotencyKey: journal[0].idempotencyKey }]);
    const history = structuredClone(journal);
    if (failure === 'success-response-401') {
      assert.ok(!f.backend.state.rows.some(row => row.id === journal[0].creditId));
    }
    if (journal[0].state === 'unconfirmed') f.clock += 4000; // A later job past the deadline cannot clear uncertainty.
    await job(f); assert.equal(f.calls().length, 1);
    assert.deepEqual(f.github.state.requests, history);
    assert.equal(f.backend.state.refreshes, 1);
    assert.ok(f.audit.every(e => !/^(thread|turn|model)\//.test(e.method)));
    assert.deepEqual(f.backend.state.violations, []);
    assert.ok(!/synthetic-refresh|synthetic-PAT|authBase64/.test(result.summary + JSON.stringify(f.github.state)));
    for (const launch of f.launches) await assert.rejects(readFile(join(launch.codexHome, 'auth.json')), { code: 'ENOENT' });
  });
}

test('workflow bridge handles a real stdio external refresh request: fixed refusal, stopped interval, no replay', async t => {
  const f = await privateWorkflowFixture(t); await f.select();
  const audit = [], refusals = [];
  f.external = { open: async () => {
    const rpc = new StdioRpc({ file: process.execPath,
      args: [fileURLToPath(new URL('../testing/stdio-fixture.mjs', import.meta.url))],
      env: { PATH: process.env.PATH, AUTO_RESET_MOCK_SCENARIO: 'externalRefresh' } },
    { stopOnExternalRefresh: true, timeoutMs: 1000, audit: e => audit.push(e) });
    const write = rpc.write.bind(rpc);
    rpc.write = msg => { if (msg.error) refusals.push(msg); return write(msg); };
    await rpc.start();
    const handle = { closed: false, request: (method, params) => rpc.request(method, params),
      close: async () => { await rpc.close(); handle.closed = true; } };
    return handle;
  } };
  await job(f); assert.equal(f.calls().length, 0);
  assert.equal(audit.filter(e => e.direction === 'send' && e.method === 'account/rateLimits/read').length, 1);
  assert.deepEqual(refusals, [{ id: 'refresh-from-child', error: { code: -32601, message: 'No server request handler configured' } }]);
  assert.equal(f.refreshes, 1); assert.equal(f.github.state.requests.length, 0);
});
