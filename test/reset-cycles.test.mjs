import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { FileStateStore } from '../src/state-store.mjs';
import { CycleEngine, minuteGroup } from '../src/reset-cycles.mjs';
import { activeWindows } from '../src/schedule-planner.mjs';
import { renderCycleReport } from '../src/cycle-report.mjs';
import { AccountAdapter } from '../src/account.mjs';
import { MockRpc } from '../testing/mock-rpc.mjs';
import { credit } from '../testing/fake-backend.mjs';

const BASE = 1893456000;
const row = (id, expiry) => credit(id, { expires_at: expiry === null ? null : new Date(expiry * 1000).toISOString() });
async function fixture(t, { expiry = BASE + 7200, start = BASE, initialize = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'reset-cycle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = new FileStateStore(path);
  if (initialize) { await store.initialize(); await store.update(s => { s.settings.weeklyAutoReset = true; }); }
  const rpc = new MockRpc();
  rpc.state.rows = [row('a', expiry)]; rpc.state.count = 1; rpc.state.outcome = 'nothing_to_reset';
  let now = start;
  const f = { dir, path, store, rpc, setTime: value => { now = value; }, time: () => now };
  f.restart = (options = {}) => {
    f.account = new AccountAdapter(rpc, { now: f.time });
    f.engine = new CycleEngine(new FileStateStore(path), f.account, { now: f.time, ...options });
    return f.engine;
  };
  f.restart();
  f.command = async (action, fields = {}) => f.engine.command({ action, commandId: randomUUID(),
    expectedVersion: (await store.read()).version, ...fields });
  f.select = fields => f.command('select', { creditId: 'a', ...fields });
  f.calls = () => rpc.state.requests;
  return f;
}

// Exported, file-backed suite for reuse by workflow integration 17. Adapter response cases
// stay in contract.test.mjs; these cases exercise durable state and observable RPC ordering.
test('five-minute cadence survives restart and delayed runs do not catch up', async t => {
  const f = await fixture(t);
  await f.select({ deltaSeconds: 7200 });
  f.setTime(BASE - 1); await f.engine.run(); assert.equal(f.calls().length, 0);
  f.setTime(BASE); await f.engine.run();
  assert.equal(f.calls().length, 1);
  let state = await f.store.read();
  assert.equal(state.requests[0].state, 'nothingToReset');
  assert.equal(state.cycles[0].nextAttemptAt, BASE + 300);
  f.restart();
  f.setTime(BASE + 299); await f.engine.run(); assert.equal(f.calls().length, 1);
  f.setTime(BASE + 1000); await f.engine.run(); await f.engine.run();
  state = await f.store.read();
  assert.equal(f.calls().length, 2);
  assert.equal(state.requests[1].nextAttemptAt, BASE + 1300);
  assert.notEqual(state.requests[0].idempotencyKey, state.requests[1].idempotencyKey);
  assert.deepEqual(f.calls().map(c => c.creditId), ['a', 'a']);
});

test('finite cycle is not shortened to an hour; expiry is exclusive', async t => {
  const f = await fixture(t);
  await f.select({ deltaSeconds: 7200 });
  f.setTime(BASE + 3601); await f.engine.run(); assert.equal(f.calls().length, 1);
  f.setTime(BASE + 7200); const result = await f.engine.run();
  assert.equal(f.calls().length, 1); assert.equal(result.cycles[0].status, 'ended');
  await assert.rejects(f.command('retry', { creditId: 'a' }), /retry_requires_ended_hour/);
});

test('late first hourly run never starts a new hour; retry starts one explicitly', async t => {
  const f = await fixture(t, { expiry: null });
  await f.select({ scheduledAt: BASE });
  f.setTime(BASE + 3600);
  const report = await f.engine.run();
  assert.equal(f.calls().length, 0); assert.equal(report.cycles[0].status, 'ended');
  assert.equal(report.cycles[0].retryAvailable, true);
  await f.command('retry', { creditId: 'a' });
  assert.equal((await f.engine.status()).cycles[0].deadline, BASE + 7200);
  await f.engine.run(); assert.equal(f.calls().length, 1);
});

test('expiry refinement, reconnect and pause/resume preserve the original hourly boundary', async t => {
  const f = await fixture(t, { expiry: null });
  await f.select({ scheduledAt: BASE });
  await f.command('disable');
  f.setTime(BASE + 600);
  f.rpc.state.rows = [row('a', BASE + 1800)];
  await f.engine.refresh();
  let c = (await f.engine.status()).cycles[0];
  assert.equal(c.originalDeadline, BASE + 3600); assert.equal(c.deadline, BASE + 1800);
  await f.command('reconnect'); await f.engine.reconnect(); await f.command('resume');
  c = (await f.engine.status()).cycles[0];
  assert.equal(c.scheduledAt, BASE); assert.equal(c.deadline, BASE + 1800);
  f.rpc.state.rows = [row('a', BASE + 9000)]; await f.engine.refresh();
  assert.equal((await f.engine.status()).cycles[0].deadline, BASE + 1800);
  f.setTime(BASE + 1800); await f.engine.run(); assert.equal(f.calls().length, 0);
});

test('calendar-minute groups include the date, choose earliest and retain success after restart', async t => {
  const f = await fixture(t);
  const midday = BASE + 12 * 3600;
  assert.equal(minuteGroup(midday + 1), minuteGroup(midday + 59));
  assert.notEqual(minuteGroup(midday + 59), minuteGroup(midday + 60));
  assert.notEqual(minuteGroup(midday + 1), minuteGroup(midday + 86401));
  f.rpc.state.rows = [row('later', midday + 59), row('earlier', midday + 1), row('next', midday + 60)]; f.rpc.state.count = 3;
  await f.command('select', { deltaSeconds: 12 * 3600 + 1 });
  assert.equal((await f.engine.status()).cycles[0].creditId, 'earlier');
  f.rpc.state.outcome = 'reset'; await f.engine.run();
  f.restart(); await f.engine.refresh();
  await assert.rejects(f.command('select', { creditId: 'later' }), /group_locked/);
  assert.equal((await f.engine.status()).groups[0].outcome, 'applied');
  assert.equal(f.calls().length, 1);
  await f.command('select', { creditId: 'next' });
});

test('auto-select rejects partial/count-only/unavailable metadata without changing selection, version or command journal', async t => {
  for (const kind of ['partial', 'countOnly', 'unavailable']) {
    const f = await fixture(t); await f.select();
    if (kind === 'partial') {
      f.rpc.state.rows.push(row('visible-earlier', BASE + 3600)); f.rpc.state.count = 3;
    } else {
      f.rpc.state.detailsStatus = 503; f.rpc.state.usageSummary = kind === 'countOnly';
    }
    const before = await f.store.read();
    await assert.rejects(f.command('select'), /auto_select_requires_complete_metadata/);
    assert.deepEqual(await f.store.read(), before);
    assert.equal(f.calls().length, 0);
    if (kind === 'partial') {
      await f.command('select', { creditId: 'visible-earlier' });
      assert.equal((await f.engine.status()).cycles.find(c => c.creditId === 'visible-earlier').status, 'scheduled');
    }
  }
});

test('unavailable read exception rejects auto-select before state observation', async t => {
  const f = await fixture(t); await f.select(); const before = await f.store.read();
  f.rpc.state.usageStatus = 503;
  await assert.rejects(f.command('select'), /metadata_unavailable/);
  assert.deepEqual(await f.store.read(), before); assert.equal(f.calls().length, 0);
});

test('count-only and unavailable metadata cannot create an initial automatic choice', async t => {
  for (const usageSummary of [true, false]) {
    const f = await fixture(t); f.rpc.state.detailsStatus = 503; f.rpc.state.usageSummary = usageSummary;
    const before = await f.store.read();
    await assert.rejects(f.command('select'), /auto_select_requires_complete_metadata/);
    assert.deepEqual(await f.store.read(), before); assert.equal(f.calls().length, 0);
  }
});

test('explicit ID replacement is allowed after confirmed non-application, never automatically', async t => {
  const f = await fixture(t);
  f.rpc.state.rows.push(row('b', BASE + 7201)); f.rpc.state.count = 2;
  await f.select({ deltaSeconds: 7200 }); await f.engine.run();
  await f.command('select', { creditId: 'b', deltaSeconds: 7201 });
  await f.engine.run();
  assert.deepEqual(f.calls().map(c => c.creditId), ['a', 'b']);
  f.rpc.state.rows = [row('a', BASE + 7200)]; f.rpc.state.count = 1;
  f.setTime(BASE + 300); await f.engine.run();
  assert.deepEqual(f.calls().map(c => c.creditId), ['a', 'b']);
  assert.equal((await f.engine.status()).cycles[0].creditId, 'b');
});

test('unknown outcome blocks new IDs, keys, apply-now and retry through reconnect and deadline', async t => {
  const f = await fixture(t, { expiry: null });
  f.rpc.state.rows.push(row('b', BASE + 10000)); f.rpc.state.count = 2;
  await f.select({ scheduledAt: BASE });
  f.rpc.state.loss = true; await f.engine.run();
  f.restart();
  await f.command('reconnect'); await f.engine.reconnect();
  f.setTime(BASE + 4000); await f.engine.run();
  for (const action of ['apply-now', 'retry']) await assert.rejects(f.command(action, { creditId: 'a' }), /outcome_unconfirmed/);
  await assert.rejects(f.command('select', { creditId: 'b' }), /outcome_unconfirmed/);
  const report = await f.engine.status();
  assert.equal(report.outcomeUnconfirmed, true); assert.equal(report.cycles[0].status, 'unconfirmed');
  assert.equal(report.cycles[0].nextAttemptAt, null); assert.equal(f.calls().length, 1);
});

test('late expiry binds an unknown request to its group and prevents a second ID', async t => {
  const f = await fixture(t, { expiry: null });
  await f.select({ scheduledAt: BASE });
  f.rpc.state.outcome = 'unknown'; await f.engine.run();
  f.rpc.state.rows = [row('a', BASE + 2000), row('b', BASE + 2001)]; f.rpc.state.count = 2;
  f.restart(); await f.engine.refresh();
  const state = await f.store.read();
  assert.deepEqual(state.requests[0].groupKeys, [minuteGroup(BASE + 2000)]);
  assert.equal(state.groups[0].outcome, 'unconfirmed');
  await assert.rejects(f.command('select', { creditId: 'b' }), /outcome_unconfirmed/);
  await f.engine.run(); assert.equal(f.calls().length, 1);
});

test('two selected IDs discovered in the same minute stop until explicit selection resolves the conflict', async t => {
  const f = await fixture(t, { expiry: null });
  f.rpc.state.rows.push(row('b', null)); f.rpc.state.count = 2;
  await f.select({ scheduledAt: BASE }); await f.command('select', { creditId: 'b', scheduledAt: BASE });
  f.rpc.state.rows = [row('a', BASE + 1981), row('b', BASE + 2039)];
  await f.engine.refresh(); await f.engine.run();
  assert.equal(f.calls().length, 0); assert.equal((await f.engine.status()).groups[0].outcome, 'conflict');
  await f.command('select', { creditId: 'b', scheduledAt: BASE }); await f.engine.run();
  assert.deepEqual(f.calls().map(c => c.creditId), ['b']);
});

test('partial reads, missing ID and unverified expiry preserve saved schedule and do not prove success', async t => {
  const f = await fixture(t);
  await f.select({ deltaSeconds: 7200 });
  for (const mutate of [
    () => { f.rpc.state.detailsStatus = 503; },
    () => { f.rpc.state.detailsStatus = 200; f.rpc.state.rows = []; },
    () => { f.rpc.state.rows = [row('a', null)]; },
    () => { f.rpc.state.usageStatus = 503; },
  ]) {
    mutate(); await f.engine.refresh(); await f.engine.run();
    const c = (await f.engine.status()).cycles[0];
    assert.deepEqual(c.expiry, { kind: 'at', unixSeconds: BASE + 7200 });
    assert.equal(c.scheduledAt, BASE); assert.equal(c.deadline, BASE + 7200);
    assert.ok(c.metadataProblem); assert.notEqual(c.status, 'applied');
  }
  assert.equal(f.calls().length, 0);
});

test('unknown expiry uses the saved hour while incomplete metadata blocks consume', async t => {
  const f = await fixture(t, { expiry: null });
  const original = f.rpc.request.bind(f.rpc);
  f.rpc.request = async (method, params) => {
    const value = await original(method, params);
    if (method === 'account/rateLimits/read') delete value.rateLimitResetCredits.credits[0].expiresAt;
    return value;
  };
  await assert.rejects(f.select(), /chosen_start_required/);
  await f.select({ scheduledAt: BASE });
  await f.engine.run(); assert.equal(f.calls().length, 0);
  f.setTime(BASE + 3600); const report = await f.engine.run();
  assert.equal(report.cycles[0].status, 'ended'); assert.equal(report.cycles[0].deadline, BASE + 3600);
});

test('manual command IDs are durable; stale versions and reused IDs are conflicts', async t => {
  const f = await fixture(t);
  const cmd = { action: 'select', creditId: 'a', deltaSeconds: 7200, commandId: 'manual-1', expectedVersion: (await f.store.read()).version };
  const first = await f.engine.command(cmd);
  f.restart();
  assert.equal((await f.engine.command(cmd)).duplicate, true);
  assert.equal((await f.store.read()).cycles.length, 1);
  await assert.rejects(f.engine.command({ ...cmd, commandId: 'manual-2' }), /version_conflict/);
  await assert.rejects(f.engine.command({ ...cmd, deltaSeconds: 3600 }), /command_id_reused/);
  const apply = { action: 'apply-now', creditId: 'a', commandId: 'manual-now', expectedVersion: first.version };
  await f.engine.command(apply); await f.engine.command(apply);
  assert.equal((await f.store.read()).cycles.length, 2);
  assert.equal(f.calls().length, 0); // accepted is visibly different from applied
  await f.engine.run(); await f.engine.run(); assert.equal(f.calls().length, 1);
});

test('apply-now replaces a future schedule; a paused hour resumes without extending it', async t => {
  const f = await fixture(t, { expiry: null });
  await f.select({ scheduledAt: BASE + 86400 });
  await f.command('apply-now', { creditId: 'a' });
  let report = await f.engine.status();
  assert.equal(report.cycles.length, 1); assert.equal(report.cycles[0].scheduledAt, BASE);
  assert.equal(report.cycles[0].deadline, BASE + 3600);
  await f.engine.run(); await f.command('disable', { creditId: 'a' });
  f.setTime(BASE + 3600); await f.command('resume', { creditId: 'a' }); await f.engine.run();
  report = await f.engine.status(); assert.equal(report.cycles[0].status, 'ended'); assert.equal(f.calls().length, 1);
});

for (const mutation of ['disable', 'revoke', 'version', 'deadline']) {
  test(`final RPC check catches ${mutation} after durable reservation`, async t => {
    const f = await fixture(t);
    await f.select({ deltaSeconds: 7200 });
    f.engine.checkpoint = async name => {
      if (name !== 'afterReserve') return;
      if (mutation === 'deadline') f.setTime(BASE + 7200);
      else if (mutation === 'version') await f.command('resume');
      else await f.command(mutation);
    };
    await f.engine.run();
    const s = await f.store.read();
    assert.equal(f.calls().length, 0); assert.equal(s.requests[0].state, 'notSent');
    assert.equal(s.requests[0].nextAttemptAt, BASE + 300);
    if (mutation === 'disable' || mutation === 'version') {
      f.engine.checkpoint = async () => {};
      if (mutation === 'disable') await f.command('resume');
      f.setTime(BASE + 300); await f.engine.run();
      assert.equal(f.calls().length, 1);
    }
  });
}

test('disable after sending does not cancel RPC or discard the confirmed result', async t => {
  const f = await fixture(t);
  await f.select({ deltaSeconds: 7200 }); f.rpc.state.outcome = 'reset';
  const original = f.rpc.request.bind(f.rpc);
  let finish, didSend;
  const sent = new Promise(resolve => { didSend = resolve; });
  f.rpc.request = (method, params) => {
    if (method !== 'account/rateLimitResetCredit/consume') return original(method, params);
    didSend(); return new Promise(resolve => { finish = () => resolve(original(method, params)); });
  };
  const run = f.engine.run(); await sent;
  // send happened under inspect's lock, which is released before awaiting the response.
  while (true) {
    try { await f.command('disable'); break; }
    catch (error) { if (error.kind !== 'state_busy') throw error; await new Promise(resolve => setImmediate(resolve)); }
  }
  finish(); await run;
  const report = await f.engine.status();
  assert.equal(report.disabled, true); assert.equal(report.cycles[0].status, 'applied');
  assert.equal(f.calls().length, 1);
});

test('failed intent persistence sends nothing; failed result persistence restores uncertainty', async t => {
  const f = await fixture(t);
  await f.select({ deltaSeconds: 7200 });
  const persist = f.engine.store.persist.bind(f.engine.store);
  f.engine.store.persist = async s => { if (s.requests.length) throw new Error('write failed'); return persist(s); };
  await assert.rejects(f.engine.run(), /write failed/); assert.equal(f.calls().length, 0);
  f.restart(); f.rpc.state.outcome = 'reset';
  const realPersist = f.engine.store.persist.bind(f.engine.store);
  f.engine.store.persist = async s => {
    if (s.requests.some(r => r.state === 'applied')) throw new Error('result write failed');
    return realPersist(s);
  };
  await assert.rejects(f.engine.run(), /result write failed/);
  f.restart(); await f.engine.run();
  assert.equal(f.calls().length, 1); assert.equal((await f.engine.status()).outcomeUnconfirmed, true);
});

for (const stage of ['afterReserve', 'afterSend', 'afterRpc']) {
  test(`process crash ${stage} restores the same request without replay`, async t => {
    const f = await fixture(t);
    await f.select({ deltaSeconds: 7200 });
    const auditPath = join(f.dir, 'sent.jsonl');
    const child = spawnSync(process.execPath, ['testing/cycle-crash-fixture.mjs', f.path, auditPath, stage], { encoding: 'utf8' });
    assert.equal(child.status, 74, child.stderr);
    if (stage === 'afterSend') {
      await assert.rejects(f.store.read(), /state_busy/);
      await f.store.recoverInterruptedWriter({ expectedPid: child.pid, serialized: true });
    }
    const before = await f.store.read();
    assert.equal(before.requests[0].state, 'unconfirmed');
    assert.equal(before.requests[0].nextAttemptAt, BASE + 300);
    f.restart(); f.setTime(BASE + 400); await f.engine.run();
    assert.deepEqual((await f.store.read()).requests, before.requests); assert.equal(f.calls().length, 0);
    if (stage === 'afterReserve') await assert.rejects(readFile(auditPath), { code: 'ENOENT' });
    else assert.equal((await readFile(auditPath, 'utf8')).trim().split('\n').length, 1);
  });
}

test('missing/corrupt/future state never initializes implicitly; known migration preserves history', async t => {
  const f = await fixture(t, { initialize: false });
  await assert.rejects(f.engine.run(), /state_missing/);
  await f.store.initialize('en');
  await f.store.update(s => { s.settings.weeklyAutoReset = true; });
  await f.select({ deltaSeconds: 7200 }); await f.engine.run();
  const state = await f.store.read();
  const v0 = { ...state, schemaVersion: 0 }; delete v0.commands;
  // The option predates schema 0 layouts: a stored document without it migrates
  // to disabled automation — migration never enables it without the owner's choice.
  delete v0.settings.weeklyAutoReset;
  await writeFile(f.path, JSON.stringify(v0)); f.restart();
  assert.deepEqual((await f.store.read()).requests, state.requests);
  assert.equal((await f.store.read()).settings.weeklyAutoReset, false);
  await f.command('disable'); assert.equal(JSON.parse(await readFile(f.path)).schemaVersion, 1);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  await assert.rejects(f.store.initialize(), /state_exists/);
  await writeFile(f.path, JSON.stringify({ ...state, schemaVersion: 99 }));
  await assert.rejects(f.engine.run(), /incompatible_state/);
  await writeFile(f.path, '{broken'); await assert.rejects(f.engine.run(), /invalid_state/);
  assert.equal(f.calls().length, 1);
});

test('revocation, unknown schema fields and an occupied writer lock fail closed', async t => {
  const f = await fixture(t); await f.select({ deltaSeconds: 7200 }); await f.command('revoke');
  await f.engine.run(); assert.equal(f.calls().length, 0);
  await assert.rejects(f.command('resume'), /installation_revoked/);
  await assert.rejects(f.engine.refresh(), /installation_revoked/);
  const s = await f.store.read(); await writeFile(f.path, JSON.stringify({ ...s, credentials: 'forbidden' }));
  await assert.rejects(f.engine.run(), /invalid_state/);
  await writeFile(f.path, JSON.stringify(s)); await mkdir(`${f.path}.lock`);
  await assert.rejects(f.engine.run(), /state_busy/);
});

test('JSON and ru/en reports distinguish accepted commands, schedule and confirmed application', async t => {
  const f = await fixture(t); await f.select({ deltaSeconds: 7200 });
  let report = await f.engine.status();
  assert.equal(report.commands[0].state, 'accepted'); assert.equal(report.cycles[0].lastResult, null);
  const ru = renderCycleReport(report);
  assert.match(ru, /принятие не означает применение/); assert.match(ru, /Целевой момент/);
  assert.match(renderCycleReport({ ...report, language: 'en' }), /acceptance does not confirm application/);
  await f.engine.run(); report = await f.engine.status();
  assert.equal(report.cycles[0].lastAttemptAt, BASE); assert.equal(report.cycles[0].nextAttemptAt, BASE + 300);
  assert.equal(report.cycles[0].lastResult, 'nothingToReset');
  f.rpc.state.outcome = 'reset'; f.setTime(BASE + 300); await f.engine.run();
  assert.match(renderCycleReport(await f.engine.status()), /Применение подтверждено/);
  await assert.rejects(f.command('select', { token: 'must-never-persist' }), /invalid_command/);
  assert.doesNotMatch(await readFile(f.path, 'utf8'), /must-never-persist/);
});

test('no automation has no deadline and can be applied now days after selection', async t => {
  const f = await fixture(t, { expiry: null });
  await f.select({ automation: false });
  f.setTime(BASE + 86400); await f.engine.run();
  let report = await f.engine.status();
  assert.equal(report.cycles[0].status, 'notScheduled'); assert.equal(report.cycles[0].deadline, null);
  assert.equal(report.cycles[0].scheduledAt, null); assert.equal(f.calls().length, 0);
  await f.command('apply-now', { creditId: 'a' }); await f.engine.run();
  report = await f.engine.status();
  assert.equal(report.cycles[0].deadline, BASE + 90000); assert.equal(f.calls().length, 1);
});

test('reconnect failure blocks attempts; later success after the hour does not restart it', async t => {
  const f = await fixture(t, { expiry: null });
  await f.select({ scheduledAt: BASE }); await f.command('reconnect');
  f.account.reconnect = async () => { throw new Error('synthetic refresh failure'); };
  await f.engine.reconnect(); await f.engine.run();
  assert.equal((await f.engine.status()).cycles[0].status, 'reconnectRequired'); assert.equal(f.calls().length, 0);
  f.restart(); f.setTime(BASE + 3600); await f.engine.reconnect(); await f.engine.run();
  const c = (await f.engine.status()).cycles[0];
  assert.equal(c.status, 'ended'); assert.equal(c.deadline, BASE + 3600); assert.equal(f.calls().length, 0);
});

test('writer recovery rejects a live process and requires explicit serialization', async t => {
  const f = await fixture(t);
  await mkdir(`${f.path}.lock`);
  const { hostname } = await import('node:os');
  await writeFile(`${f.path}.lock/owner.json`, JSON.stringify({ pid: process.pid, host: hostname() }));
  await assert.rejects(f.store.recoverInterruptedWriter({ expectedPid: process.pid }), /serialized_recovery_required/);
  await assert.rejects(f.store.recoverInterruptedWriter({ expectedPid: process.pid, serialized: true }), /writer_still_running/);
});

test('state CLI uses durable control commands and rejects direct consume', async t => {
  const f = await fixture(t, { initialize: false });
  const run = lines => spawnSync(process.execPath, ['src/cli.mjs', '--mode', 'mock', '--state', f.path], {
    input: lines.map(value => JSON.stringify(value)).join('\n') + '\n', encoding: 'utf8',
  });
  const first = run([{ command: 'init', language: 'en' }, { command: 'control', action: 'select',
    commandId: 'cli-select', expectedVersion: 0, creditId: 'selected-013', automation: false }, { command: 'status', format: 'markdown' }]);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const output = first.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(output[1].result.state, 'accepted'); assert.match(output[2].result.markdown, /Granted reset application/);
  const second = run([{ command: 'control', action: 'select', commandId: 'cli-select', expectedVersion: 0,
    creditId: 'selected-013', automation: false }, { command: 'consume', creditId: 'selected-013', idempotencyKey: 'unsafe' }]);
  assert.equal(second.status, 1);
  const replay = second.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replay[0].result.duplicate, true); assert.equal(replay[1].error, 'invalid_command');
  assert.equal((await f.store.read()).requests.length, 0);
});


test('explicit pilot window stops attempts early and apply-now preserves its cap', async t => {
  const f = await fixture(t, { expiry: BASE + 21 * 86400 });
  await f.select({ scheduledAt: BASE, attemptUntil: BASE + 1800 });
  let c = (await f.store.read()).cycles[0];
  assert.equal(c.originalDeadline, BASE + 21 * 86400);
  assert.equal(c.deadline, BASE + 1800);
  f.setTime(BASE + 60); await f.command('apply-now', { creditId: 'a' });
  c = (await f.store.read()).cycles.find(c => c.current);
  assert.equal(c.deadline, BASE + 1800);
  f.setTime(BASE + 1800); await f.engine.run();
  assert.equal(f.calls().length, 0);
  assert.equal((await f.store.read()).cycles.find(c => c.current).status, 'ended');
});

test('attempt window cannot extend expiry or end before its chosen start', async t => {
  const f = await fixture(t);
  for (const attemptUntil of [BASE, BASE + 7201])
    await assert.rejects(f.select({ scheduledAt: BASE, attemptUntil }), /invalid_attempt_window/);
  assert.equal((await f.store.read()).cycles.length, 0);
});

// 32: weekly-only automation table. Windows are identified by confirmed duration and
// identity evidence, never by primary/secondary position; five-hour exhaustion alone,
// unknown windows or a lapsed resetsAt never authorize the durable consume.
const rateWindow = (usedPercent, windowDurationMins, resetsAt) => ({ usedPercent, windowDurationMins, resetsAt });
const weeklyLimits = (primary, secondary, extra = {}) => ({ limitId: 'codex', rateLimitReachedType: 'rate_limit_reached',
  spendControlReached: false, primary, secondary, ...extra });
for (const [name, limits, expectedCalls] of [
  ['five-hour exhaustion alone never consumes',
    weeklyLimits(rateWindow(100, 300, BASE + 3600), rateWindow(40, 10080, BASE + 604800)), 0],
  ['weekly exhaustion alone consumes',
    weeklyLimits(rateWindow(0, 300, BASE + 300), rateWindow(100, 10080, BASE + 604800)), 1],
  ['both windows exhausted consumes',
    weeklyLimits(rateWindow(100, 300, BASE + 3600), rateWindow(100, 10080, BASE + 604800)), 1],
  ['windows are identified by duration, not by position',
    weeklyLimits(rateWindow(100, 10080, BASE + 604800), rateWindow(100, 300, BASE + 3600)), 1],
  ['unknown weekly window never consumes',
    weeklyLimits(rateWindow(100, 300, BASE + 3600), rateWindow(100, 1440, BASE + 1440)), 0],
  ['weekly resetsAt in the past never consumes',
    weeklyLimits(rateWindow(10, 300, BASE + 300), rateWindow(100, 10080, BASE - 1)), 0],
]) test(`weekly guard: ${name}`, async t => {
  const f = await fixture(t);
  f.rpc.state.limits = limits;
  await f.select({ deltaSeconds: 7200 });
  await f.engine.run();
  assert.equal(f.calls().length, expectedCalls);
  const s = await f.store.read();
  assert.equal(s.requests.length, expectedCalls === 0 ? 0 : 1);
  if (expectedCalls === 1) assert.equal(s.requests[0].state, 'nothingToReset');
});

for (const [name, resetsAt, staleAt] of [
  ['weekly resetsAt reached during startup blocks the send', BASE + 150, BASE + 150],
  ['weekly evidence older than 300s blocks the send', BASE + 604800, BASE + 300],
]) test(`weekly guard: ${name}`, async t => {
  const f = await fixture(t);
  f.rpc.state.limits = weeklyLimits(rateWindow(10, 300, BASE + 300), rateWindow(100, 10080, resetsAt));
  await f.select({ deltaSeconds: 7200 });
  f.engine.checkpoint = async stage => { if (stage === 'afterReserve') f.setTime(staleAt); };
  await f.engine.run();
  assert.equal(f.calls().length, 0);
  const s = await f.store.read();
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].state, 'notSent');
  assert.equal(s.requests[0].reason, 'weekly_exhaustion_unconfirmed');
});

test('weekly option off never consumes; explicit weekly-auto command enables it durably', async t => {
  const f = await fixture(t, { initialize: false });
  await f.store.initialize();
  await f.select({ deltaSeconds: 7200 });
  await f.engine.run();
  assert.equal(f.calls().length, 0); // migration and default never enable automation by themselves
  assert.equal((await f.engine.status()).weeklyAutoReset, false);
  await f.command('weekly-auto', { enabled: true });
  assert.equal((await f.engine.status()).weeklyAutoReset, true);
  f.restart();
  assert.equal((await f.engine.status()).weeklyAutoReset, true);
  await f.engine.run();
  assert.equal(f.calls().length, 1);
});

// Global rules of the terminal UI (14 Oct): expiry window without the weekly guard, weekly rule
// on the earliest reset, watch window at 99%, manual apply-now without a prior select.
const calm = weeklyLimits(rateWindow(10, 300, BASE + 300), rateWindow(40, 10080, BASE + 604800), { rateLimitReachedType: null });
async function rules(t, { limits = calm, rows = [['a', BASE + 7200]], weekly = false, beforeExpiry = false } = {}) {
  const f = await fixture(t);
  f.rpc.state.rows = rows.map(([id, at]) => row(id, at)); f.rpc.state.count = rows.length;
  f.rpc.state.limits = limits;
  await f.store.update(s => { s.settings.weeklyAutoReset = weekly; s.settings.beforeExpiry = beforeExpiry; });
  return f;
}

test('expiry rule: off by default; on creates a window 30 minutes before expiry and consumes without weekly exhaustion', async t => {
  const f = await rules(t);
  await f.engine.refresh();
  assert.equal((await f.store.read()).cycles.length, 0);
  await f.command('before-expiry', { enabled: true });
  await f.engine.refresh();
  const [c] = (await f.engine.status()).cycles;
  assert.equal(c.trigger, 'expiry'); assert.equal(c.scheduledAt, BASE + 7200 - 1800); assert.equal(c.deadline, BASE + 7200);
  await f.engine.run(); assert.equal(f.calls().length, 0); // window not open yet
  f.setTime(BASE + 5400); await f.engine.run();
  assert.equal(f.calls().length, 1); assert.equal((await f.store.read()).requests[0].state, 'nothingToReset');
  await f.command('before-expiry', { enabled: false });
  f.setTime(BASE + 5800); const report = await f.engine.run();
  assert.equal(f.calls().length, 1); assert.equal(report.cycles[0].armed, false); assert.equal(report.cycles[0].nextAttemptAt, null);
  assert.deepEqual(activeWindows(await f.store.read(), BASE + 5800), []);
});

test('expiry rule takes one reset per calendar minute and never re-creates an applied one', async t => {
  const f = await rules(t, { beforeExpiry: true, rows: [['b', BASE + 7230], ['a', BASE + 7210], ['c', BASE + 9000]] });
  await f.engine.refresh();
  let cycles = (await f.store.read()).cycles;
  assert.deepEqual(cycles.map(c => c.creditId).sort(), ['a', 'c']);
  f.rpc.state.outcome = 'reset'; f.setTime(BASE + 5410); await f.engine.run();
  cycles = (await f.store.read()).cycles;
  assert.equal(cycles.find(c => c.creditId === 'a').status, 'applied');
  await f.engine.refresh();
  assert.equal((await f.store.read()).cycles.filter(c => c.creditId === 'a').length, 1);
  assert.ok(!(await f.store.read()).cycles.some(c => c.creditId === 'b'));
});

test('weekly rule applies the earliest reset at once; five-hour exhaustion or the option off do nothing', async t => {
  const exhausted = weeklyLimits(rateWindow(0, 300, BASE + 300), rateWindow(100, 10080, BASE + 86400));
  const fiveHour = weeklyLimits(rateWindow(100, 300, BASE + 3600), rateWindow(40, 10080, BASE + 604800));
  for (const [limits, weekly, expected] of [[exhausted, true, ['a']], [fiveHour, true, []], [exhausted, false, []]]) {
    const f = await rules(t, { limits, weekly, rows: [['b', BASE + 90000], ['a', BASE + 7200]] });
    await f.engine.refresh(); await f.engine.run();
    assert.deepEqual(f.calls().map(c => c.creditId), expected);
    if (expected.length) {
      const c = (await f.store.read()).cycles.find(c => c.current);
      assert.equal(c.trigger, 'weekly'); assert.equal(c.scheduledAt, BASE); assert.equal(c.deadline, BASE + 7200);
    }
  }
});

test('weekly rule ends at the weekly resetsAt and leaves an explicit select alone', async t => {
  const exhausted = weeklyLimits(rateWindow(0, 300, BASE + 300), rateWindow(100, 10080, BASE + 1200));
  const f = await rules(t, { limits: exhausted, weekly: true, rows: [['a', BASE + 90000]] });
  await f.engine.refresh();
  assert.equal((await f.store.read()).cycles[0].deadline, BASE + 1200);
  const g = await rules(t, { limits: exhausted, weekly: true, rows: [['a', BASE + 7200], ['b', BASE + 3600]] });
  await g.select({ deltaSeconds: 7200 });
  await g.engine.refresh(); await g.engine.run();
  assert.deepEqual((await g.store.read()).cycles.map(c => [c.creditId, c.trigger]), [['a', undefined]]);
  assert.deepEqual(g.calls().map(c => c.creditId), ['a']);
});

test('weekly watch: 99% arms an hour of timer windows, lower usage or the option off clears it', async t => {
  const at = percent => weeklyLimits(rateWindow(10, 300, BASE + 300), rateWindow(percent, 10080, BASE + 86400), { rateLimitReachedType: null });
  const f = await rules(t, { limits: at(99.2), weekly: true });
  await f.engine.refresh();
  let s = await f.store.read();
  assert.equal(s.weeklyWatchUntil, BASE + 3600); assert.equal(s.cycles.length, 0); assert.equal(f.calls().length, 0);
  assert.deepEqual(activeWindows(s, BASE), [{ start: BASE, end: BASE + 3600 }]);
  f.rpc.state.limits = at(60); await f.engine.refresh();
  assert.equal((await f.store.read()).weeklyWatchUntil, null);
  f.rpc.state.limits = at(99.5); await f.engine.refresh();
  await f.command('weekly-auto', { enabled: false });
  s = await f.store.read();
  assert.equal(s.weeklyWatchUntil, null); assert.deepEqual(activeWindows(s, BASE), []);
});

test('apply-now without a prior select consumes without weekly exhaustion and is refused while paused', async t => {
  const f = await rules(t, { rows: [['a', BASE + 90000]] });
  await f.command('disable');
  await assert.rejects(f.command('apply-now', { creditId: 'a' }), /installation_paused/);
  await f.command('resume');
  await assert.rejects(f.command('apply-now', { creditId: 'missing' }), /selected_credit_not_eligible/);
  await f.command('apply-now', { creditId: 'a' });
  const [c] = (await f.engine.status()).cycles;
  assert.equal(c.trigger, 'manual'); assert.equal(c.scheduledAt, BASE); assert.equal(c.deadline, BASE + 90000);
  await f.engine.run();
  assert.deepEqual(f.calls().map(c => c.creditId), ['a']);
});

test('apply-now after an ended weekly cycle starts a new manual cycle', async t => {
  const exhausted = weeklyLimits(rateWindow(0, 300, BASE + 300), rateWindow(100, 10080, BASE + 600));
  const f = await rules(t, { limits: exhausted, weekly: true, rows: [['a', BASE + 90000]] });
  await f.engine.refresh(); await f.engine.run();
  f.rpc.state.limits = calm; f.setTime(BASE + 700); await f.engine.run();
  await f.command('apply-now', { creditId: 'a' });
  const current = (await f.store.read()).cycles.filter(c => c.current);
  assert.deepEqual(current.map(c => [c.trigger, c.scheduledAt]), [['manual', BASE + 700]]);
  await f.engine.run(); assert.equal(f.calls().length, 2);
});

test('migration keeps the expiry rule off and old cycles keep the weekly guard', async t => {
  const f = await rules(t, { rows: [['a', BASE + 7200]] });
  const raw = JSON.parse(await readFile(f.path, 'utf8'));
  delete raw.settings.beforeExpiry;
  await writeFile(f.path, JSON.stringify(raw));
  assert.equal((await f.store.read()).settings.beforeExpiry, false);
  await f.store.update(s => { s.settings.weeklyAutoReset = true; });
  await f.select({ deltaSeconds: 7200 }); await f.engine.run();
  assert.equal(f.calls().length, 0); // calm week: an explicit select still needs weekly exhaustion
});
