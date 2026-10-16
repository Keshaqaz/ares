import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Installer } from '../src/installer.mjs';
import { spawnSync } from 'node:child_process';
import { privateWorkflowFixture, FakeActions, PROGRAM_COMMIT } from '../testing/private-workflow-fixture.mjs';
import { NOW } from '../testing/host-auth-fixture.mjs';
import { HostAuthAdmin } from '../src/auth-admin.mjs';
import { HostAuthSession } from '../src/host-auth-session.mjs';
import { CycleEngine } from '../src/reset-cycles.mjs';
import { renderPrivateWorkflow, acquireGitHubWriter, withInstallationWriter } from '../src/private-workflow.mjs';
import { readQuotaReceipt } from '../src/private-job.mjs';
import { readDispatchCommand, sealAdmin } from '../src/installer-admin.mjs';
import { readManagedSchedule } from '../src/github-schedule.mjs';
import { FALLBACK_CRON } from '../src/schedule-planner.mjs';
import { syntheticGrant } from '../testing/auth-fixture.mjs';
import { decodeBundle } from '../src/auth-bundle.mjs';

const start = f => f.actions.start();
const job = (f, options) => { f.enqueue(options); return start(f); };

test('private workflow pins program/actions/runtime and exposes no PR/push/source account trigger', async () => {
  const content = await renderPrivateWorkflow(PROGRAM_COMMIT);
  // Windows are in the timer plan; the only native trigger time is the static daily fallback.
  assert.deepEqual(readManagedSchedule(content), [FALLBACK_CRON]);
  assert.equal((content.match(/cron:/g) ?? []).length, 1);
  assert.ok(content.includes('queue: max') && content.includes('cancel-in-progress: false'));
  assert.match(content, /permissions:\n  contents: read\n/);
  assert.equal((content.match(/runs-on:/g) ?? []).length, 1);
  assert.ok(!/pull_request|repository_dispatch|\bpush:|upload-artifact|cache@|secrets: inherit|checkout@(?:main|v\d)/.test(content));
  assert.match(content, /persist-credentials: false/);
  assert.match(content, /package-manager-cache: false/);
  assert.ok([...content.matchAll(/uses: ([^\n]+)/g)].every(m => /@[a-f0-9]{40} /.test(m[1])));
  assert.match(content, /npm ci --ignore-scripts/);
  assert.match(content, /node-version: '26\.10\.0'/);
  assert.match(content, /event\.repository\.private == true/);
  assert.ok(!content.includes('run: ${{'));
  await assert.rejects(renderPrivateWorkflow('main'), /pinned_program_commit_required/);
  const cli = spawnSync(process.execPath, ['src/private-cli.mjs'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(cli.status, 1); assert.match(cli.stdout, /private_job_requires_linux_x64|live_pilot_gate_closed/);
});

test('writer admission rejects public/PR/fork/modified workflow; lease is released explicitly', async () => {
  const content = await renderPrivateWorkflow(PROGRAM_COMMIT);
  let repo = { private: true, full_name: 'synthetic/private', default_branch: 'main' };
  let run = { status: 'in_progress', event: 'schedule', path: '.github/workflows/auto-reset.yml', head_branch: 'main',
    head_sha: 'a'.repeat(40), repository: repo };
  let workflow = content;
  const storage = { repository: 'synthetic/private', api: async path => path === '' ? repo :
    path.startsWith('/actions/runs/') ? run : { type: 'file', encoding: 'base64', content: Buffer.from(workflow).toString('base64') } };
  const opts = { storage, runId: '17', eventName: 'schedule', ref: 'refs/heads/main', programCommit: PROGRAM_COMMIT };
  const lease = await acquireGitHubWriter(opts); await lease.assertOwner(); lease.release();
  await assert.rejects(withInstallationWriter(lease, () => {}), /writer_released/);
  repo.private = false; await assert.rejects(acquireGitHubWriter(opts), /private_default_branch_required/); repo.private = true;
  await assert.rejects(acquireGitHubWriter({ ...opts, eventName: 'pull_request' }), /private_writer_context_required/);
  await assert.rejects(acquireGitHubWriter({ ...opts, ref: 'refs/heads/attacker' }), /private_default_branch_required/);
  run.repository = { full_name: 'attacker/fork' }; await assert.rejects(acquireGitHubWriter(opts)); run.repository = repo;
  workflow = content.replace('cancel-in-progress: false', 'cancel-in-progress: true');
  await assert.rejects(acquireGitHubWriter(opts), /untrusted_private_workflow/);
  // A managed cron left by a pin before the timer plan, or the old empty region, is not this template.
  for (const stale of [content.replace(`- cron: '${FALLBACK_CRON}'`, `- cron: '${FALLBACK_CRON}'\n    - cron: '2 0,4,8,12,16,20 * * *'`),
    content.replace(`  schedule:\n    - cron: '${FALLBACK_CRON}'\n`, '')]) {
    workflow = stale; await assert.rejects(acquireGitHubWriter(opts), /untrusted_private_workflow/);
  }
  workflow = content; (await acquireGitHubWriter(opts)).release();
});

test('integrated fake GitHub + host OAuth + cycle + planner: selected consume journal before send, no model or leaked tokens', async t => {
  const f = await privateWorkflowFixture(t); await f.select();
  f.rpc.state.outcome = 'reset';
  f.afterResponse = async method => {
    if (method === 'account/rateLimitResetCredit/consume') assert.equal(f.github.state.requests[0].state, 'unconfirmed');
    if (method === 'account/rateLimits/read' && f.calls().length) assert.equal(f.github.state.requests[0].state, 'applied');
  };
  const result = await job(f);
  assert.equal(result.problem, null);
  assert.equal(f.calls().length, 1); assert.equal(f.github.state.requests[0].state, 'applied');
  assert.equal(f.github.state.groups[0].outcome, 'applied');
  assert.ok(f.schedule.expressions().every(e => !e.includes(' 8 10 '))); // only discovery remains
  assert.equal(f.github.state.scheduler.publication, 'confirmed');
  assert.match(result.summary, /Применение подтверждено/);
  assert.ok(f.events.indexOf('secret.put') < f.events.indexOf('child.login'));
  assert.ok(!/synthetic-refresh|synthetic-PAT|authBase64|refresh_token/.test(JSON.stringify(f.github.state) + result.summary + JSON.stringify(f.childTokens)));
  assert.ok(!f.events.some(e => /^(thread|turn|model)\//.test(e)));
  assert.ok(f.github.requests.filter(r => r.path.includes('state.json')).every(r => r.method === 'PUT' || r.query === '?ref=auto-reset-state'));
});

test('missed/late/duplicate runs keep original bounds and never catch up', async t => {
  for (const expiry of [NOW + 3600, null]) {
    const f = await privateWorkflowFixture(t, { expiry }); await f.select();
    // The initial refresh may also create a weekly-rule cycle; the explicit select supersedes it.
    const selected = () => f.github.state.cycles.find(c => c.current && c.trigger === undefined);
    f.clock = NOW + 999; await job(f); await job(f);
    assert.equal(f.calls().length, 1); assert.equal(selected().nextAttemptAt, NOW + 1299);
    f.clock = NOW + 3600; const result = await job(f);
    assert.equal(f.calls().length, 1); assert.equal(result.report.cycles.find(c => c.trigger === 'select').status, 'ended');
    assert.equal(selected().originalDeadline, NOW + 3600);
  }
});

test('nothingToReset uses new attempt only after cadence; partial list and manual redemption retain selected ID', async t => {
  const f = await privateWorkflowFixture(t); await f.select();
  await job(f); assert.equal(f.github.state.requests[0].state, 'nothingToReset');
  const first = f.calls()[0].idempotencyKey;
  f.clock += 300; f.rpc.state.count = 2; await job(f);
  assert.equal(f.calls().length, 2); assert.notEqual(f.calls()[1].idempotencyKey, first);
  f.clock += 300; f.rpc.state.rows[0].status = 'redeemed'; f.rpc.state.count = 1;
  await job(f); assert.equal(f.calls().length, 2); assert.equal(f.github.state.cycles[0].metadataProblem, 'selected_status_unverified');
  assert.ok(f.calls().every(r => r.creditId === 'selected-017'));
});

test('two manual commands are accepted by version, not dispatch order; duplicate delivery cannot resume twice', async t => {
  const f = await privateWorkflowFixture(t); await f.select();
  const first = f.command('disable', { commandId: 'first' });
  const second = f.command('disable', { commandId: 'second' });
  const one = f.enqueue({ command: first }), two = f.enqueue({ command: second });
  await f.actions.start(1); await start(f);
  assert.equal(two.result.commandResult.state, 'accepted'); assert.equal(one.result.problem, 'version_conflict');
  assert.equal(f.github.state.commands.filter(c => ['first', 'second'].includes(c.commandId)).length, 1);
  const version = f.github.state.version;
  const again = await job(f, { command: second });
  assert.equal(again.commandResult.duplicate, true); assert.equal(f.calls().length, 0);
  assert.ok(f.github.state.version >= version); assert.equal(f.github.state.disabled, true);
});

test('pending replacement and queue overflow leave command explicitly unconfirmed; no HTTP dispatch acceptance', async t => {
  const f = await privateWorkflowFixture(t, { queue: 'single' }); await f.select();
  const displaced = f.enqueue({ command: f.command('disable', { commandId: 'displaced' }) });
  f.enqueue({ command: f.command('disable', { commandId: 'survivor' }) });
  assert.equal(displaced.status, 'cancelled'); await start(f);
  assert.ok(!f.github.state.commands.some(c => c.commandId === 'displaced'));
  const max = new FakeActions();
  for (let i = 0; i < 100; i++) assert.equal(max.enqueue(() => {}).status, 'pending');
  assert.equal(max.enqueue(() => {}).status, 'cancelled');
  const receipt = await job(f, { command: f.command('disable', { commandId: 'displaced' }) });
  assert.equal(receipt.commandResult.state, 'accepted');
  assert.match(receipt.summary, /HTTP dispatch не подтверждает/);
});

// The timer app (Actions: write) can dispatch any input; only ciphertext may carry control.
const dispatch = async (f, raw) => job(f, { command: readDispatchCommand(raw,
  { repository: f.github.storage.repository, grant: syntheticGrant }) });

test('dispatch rejects open control without state change or consume; empty input and status work as before', async t => {
  const f = await privateWorkflowFixture(t); await f.select();
  f.rpc.state.outcome = 'reset';
  const before = JSON.stringify(f.github.state);
  for (const raw of [JSON.stringify(f.command('apply-now', { creditId: 'selected-017' })),
    JSON.stringify(f.command('resume')), JSON.stringify(f.command('weekly-auto', { enabled: true })),
    '{"command":"status","format":"json"}', '{"command":"run"}', '[]', 'null', '{']) {
    await assert.rejects(dispatch(f, raw), /open_command_rejected|invalid_command/);
  }
  assert.equal(JSON.stringify(f.github.state), before); assert.equal(f.calls().length, 0);
  const status = await dispatch(f, '{"command":"status"}');
  assert.equal(status.commandResult, null); assert.equal(f.calls().length, 0);
  const run = await dispatch(f, '');
  assert.equal(run.problem, null); assert.equal(f.calls().length, 1);
  assert.equal(f.github.state.requests[0].state, 'applied');
});

test('sealed control keeps the command ID journal; redelivery is duplicate; tampered or foreign envelopes are refused', async t => {
  const f = await privateWorkflowFixture(t); await f.select();
  const seal = (payload, { commandId = 'sealed-disable', expectedVersion = f.github.state.version,
    repository = 'synthetic/private', grant = syntheticGrant } = {}) => JSON.stringify(sealAdmin(repository, grant,
    { commandId, expectedVersion, action: 'control' }, payload));
  const before = JSON.stringify(f.github.state);
  const original = seal({ action: 'disable' }), tampered = JSON.parse(original);
  tampered.envelope = `${tampered.envelope.slice(0, -4)}AAA=`;
  for (const raw of [JSON.stringify(tampered), JSON.stringify({ ...JSON.parse(original), expectedVersion: 0 }),
    seal({ action: 'disable' }, { repository: 'attacker/private' }), seal({ action: 'disable' }, { grant: 'leaked-timer-token' }),
    seal({ action: 'disable', commandId: 'other' }), seal({ action: 'disable', command: 'admin' })]) {
    await assert.rejects(dispatch(f, raw), /invalid_admin_command/);
  }
  assert.equal(JSON.stringify(f.github.state), before);
  const accepted = await dispatch(f, original);
  assert.equal(accepted.commandResult.state, 'accepted'); assert.equal(f.github.state.disabled, true);
  assert.equal(f.github.state.commands.filter(c => c.commandId === 'sealed-disable').length, 1);
  // Resealing yields new ciphertext; identity stays the CycleEngine ID/fingerprint, not the envelope.
  const again = await dispatch(f, seal({ action: 'disable' }, { expectedVersion: JSON.parse(original).expectedVersion }));
  assert.equal(again.commandResult.duplicate, true);
  const reused = await dispatch(f, seal({ action: 'resume' }, { expectedVersion: JSON.parse(original).expectedVersion }));
  assert.equal(reused.problem, 'command_id_reused'); assert.equal(f.github.state.disabled, true);
  assert.equal(f.calls().length, 0);
});

test('installer monitor actions travel as sealed control; receipt is matched by the engine fingerprint', async t => {
  const f = await privateWorkflowFixture(t);
  // A calm week and the weekly option off: a manual apply-now still consumes.
  f.rpc.state.limits = { limitId: 'codex', rateLimitReachedType: null, spendControlReached: false,
    primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: NOW + 300 },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: NOW + 604800 } };
  await f.actions.writer(() => f.github.storage.update(v => { v.settings.weeklyAutoReset = false;
    v.installation = { programCommit: PROGRAM_COMMIT, seedSession: null, checkedSession: null, operation: null }; }));
  // An ordinary run stores the latest list the monitor shows; it never consumes by itself here.
  await job(f);
  assert.deepEqual(f.github.state.installation.metadata.credits.map(c => c.id), ['selected-017']); assert.equal(f.calls().length, 0);
  const dir = await mkdtemp(join(tmpdir(), 'installer-control-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let receipts = s => s.commands;
  const github = { repository: f.github.storage.repository, token: syntheticGrant,
    status: async () => { const s = structuredClone(f.github.state); s.commands = receipts(s); return s; },
    dispatch: async c => { await dispatch(f, JSON.stringify(c)); return { state: 'unconfirmed', commandId: c.commandId }; } };
  const installer = new Installer({ github, platform: 'darwin', journalPath: join(dir, 'journal.json') });
  const sent = await installer.control('apply-now', { creditId: 'selected-017' });
  assert.equal(sent.state, 'unconfirmed'); assert.equal(f.calls().length, 1);
  assert.equal(f.github.state.cycles.find(c => c.current).trigger, 'manual');
  const pending = installer.journal.pending;
  receipts = s => s.commands.map(c => c.commandId === pending.commandId ? { ...c, fingerprint: '0'.repeat(64) } : c);
  await assert.rejects(installer.resume(), /command_id_reused/);
  receipts = s => s.commands;
  const done = await installer.resume();
  assert.equal(done.state, 'accepted'); assert.equal(done.problem, null); assert.equal(installer.journal.pending, null);
  await installer.control('before-expiry', { enabled: true });
  assert.equal((await installer.resume()).state, 'accepted'); assert.equal(f.github.state.settings.beforeExpiry, true);
});

test('setup/admin and scheduled job get one writer; loser cannot write state or Secret, local installer has no lease', async t => {
  const f = await privateWorkflowFixture(t); await f.select();
  let entered, release;
  const paused = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  f.open = async () => { entered(); await barrier; };
  f.enqueue(); const running = start(f); await paused;
  const before = JSON.stringify(f.github.state), secret = f.github.secret;
  const admin = new HostAuthAdmin({ store: f.github.storage, secrets: f.github.storage, serialization: f.serialization, owner: 'admin-017' });
  await assert.rejects(admin.disable(f.github.state.version), /serialized_writer_required/);
  await assert.rejects(f.github.storage.publish(decodeBundle(secret)), /serialized_writer_required/);
  f.actions.enqueue(() => withInstallationWriter(f.serialization, () => admin.disable(f.github.state.version)));
  await assert.rejects(start(f), /writer_busy/);
  assert.equal(JSON.stringify(f.github.state), before); assert.equal(f.github.secret, secret);
  release(); await running; await start(f); assert.equal(f.github.state.disabled, true);
});

for (const failure of ['grant', 'stale-secret', 'local', 'inflight-state', 'secret', 'lost-oauth']) {
  test(`integrated auth ${failure} stops account calls and keeps recovery evidence`, async t => {
    const f = await privateWorkflowFixture(t);
    if (failure === 'grant') f.github.fail = 'grant';
    if (failure === 'stale-secret') {
      // The latest authoritative tuple differs from the queued job Secret snapshot.
      f.github.state.auth.committed.generation++;
    }
    if (failure === 'local') f.localFailed = true;
    if (failure === 'secret') f.github.fail = 'secret';
    if (failure === 'lost-oauth') f.responseLost = true;
    if (failure === 'inflight-state') f.hook = async e => { if (e === 'state.inflight') { f.github.fail = 'conflict'; } };
    let result;
    try { result = await job(f); } catch { /* expired PAT also prevents status readback */ }
    assert.equal(f.calls().length, 0);
    assert.ok(!f.events.includes('account/rateLimits/read'));
    if (failure === 'local' || failure === 'lost-oauth') assert.equal(f.github.state.auth.phase, 'inflight');
    if (failure === 'secret') assert.equal(f.github.state.auth.phase, 'publishing');
    if (result) assert.ok(!/synthetic-refresh|synthetic-PAT/.test(result.summary));
  });
}

for (const change of ['auth', 'foreign-command', 'deadline', 'disable']) {
  test(`final dispatch after reservation/startup: ${change}`, async t => {
    const f = await privateWorkflowFixture(t, { expiry: NOW + 9000 });
    // auth: the first rotation issues a nearly expiring access so the job must
    // service auth after the reservation, while the weekly evidence stays fresh.
    if (change === 'auth') f.identity = { exp: NOW + 400 };
    await f.select();
    if (change === 'auth') f.identity = { exp: NOW + 9000 };
    const checkpoint = async cut => {
      if (cut === 'afterReserve' && change === 'auth') f.clock = NOW + 240;
    };
    f.open = async () => {
      if (!f.github.state.requests.some(r => r.state === 'unconfirmed')) return;
      if (change === 'deadline') f.clock = NOW + 9000;
      if (change === 'foreign-command') await f.github.storage.update(s => { s.settings.deltaSeconds++; });
      if (change === 'disable') await f.github.storage.update(s => { s.disabled = true; });
    };
    await job(f, { checkpoint });
    const request = f.github.state.requests[0];
    assert.equal(f.calls().length, change === 'auth' ? 1 : 0);
    assert.equal(request.state, change === 'auth' ? 'nothingToReset' : 'notSent');
    if (change === 'auth') {
      assert.equal(f.refreshes, 2);
      assert.deepEqual(f.calls()[0], { creditId: request.creditId, idempotencyKey: request.idempotencyKey });
    }
  });
}

test('clock can cross deadline during final state read; guard still runs immediately before actual send', async t => {
  // A 240s cycle keeps the weekly evidence fresh while the deadline itself lapses,
  // isolating the final-send deadline guard.
  const f = await privateWorkflowFixture(t, { expiry: NOW + 240 }); await f.select();
  let startup = false, reads = 0;
  f.open = async () => { if (f.github.state.requests.some(r => r.state === 'unconfirmed')) startup = true; };
  const inspect = f.github.storage.inspect.bind(f.github.storage);
  f.github.storage.inspect = async fn => inspect(state => {
    // First read after startup is the bridge's auth check. The next is the
    // journal owner's final guard; cross the deadline only at that boundary.
    if (startup && ++reads === 2) f.clock = NOW + 240;
    return fn(state);
  });
  await job(f); assert.equal(f.calls().length, 0); assert.equal(f.github.state.requests[0].state, 'notSent');
  assert.equal(f.github.state.requests[0].reason, 'deadline_reached');
});

for (const cut of ['afterReserve', 'afterRpc']) {
  test(`consume crash ${cut} preserves unknown and prevents ID/key/reconnect/retry substitution`, async t => {
    const f = await privateWorkflowFixture(t); await f.select(); f.rpc.state.outcome = 'reset';
    await job(f, { checkpoint: async at => { if (at === cut) throw new Error('simulated_crash'); } });
    assert.equal(f.calls().length, cut === 'afterRpc' ? 1 : 0);
    const journal = structuredClone(f.github.state.requests);
    assert.equal(journal[0].state, 'unconfirmed');
    await job(f); assert.deepEqual(f.github.state.requests, journal);
    const retry = await job(f, { command: f.command('apply-now', { creditId: 'selected-017' }) });
    assert.equal(retry.problem, 'outcome_unconfirmed');
    await assert.rejects(f.actions.writer(async () => f.account().session.service({ force: true })), /consume_outcome_unknown/);
    assert.equal(f.calls().length, cut === 'afterRpc' ? 1 : 0);
  });
}

test('lost consume response stops all future IDs and refresh even after same-identity reconnect publication', async t => {
  const f = await privateWorkflowFixture(t); await f.select(); f.rpc.state.loss = true;
  await job(f); assert.equal(f.calls().length, 1); assert.equal(f.github.state.requests[0].state, 'unconfirmed');
  const refreshes = f.refreshes;
  await job(f); assert.equal(f.calls().length, 1); assert.equal(f.refreshes, refreshes);
  await f.actions.writer(async () => {
    const admin = new HostAuthAdmin({ store: f.github.storage, secrets: f.github.storage, serialization: f.serialization, owner: 'reconnect-017' });
    await admin.disable(f.github.state.version);
    const bytes = Buffer.from(f.secret.authBase64, 'base64');
    await admin.seed(bytes, syntheticGrant, f.github.state.version);
  });
  await job(f); assert.equal(f.calls().length, 1); assert.equal(f.github.state.groups[0].outcome, 'unconfirmed');
});

for (const failure of ['401', 'external-refresh', 'post-success-auth']) {
  test(`${failure} ends the interval without replay or undoing confirmed consume`, async t => {
    const f = await privateWorkflowFixture(t); await f.select();
    const realRequest = f.rpc.request.bind(f.rpc);
    f.rpc.request = async (method, params) => {
      if (method === 'account/rateLimits/read' && (failure !== 'post-success-auth' || f.calls().length)) {
        throw new Error(failure);
      }
      return realRequest(method, params);
    };
    f.rpc.state.outcome = 'reset'; await job(f); await job(f);
    assert.equal(f.calls().length, failure === 'post-success-auth' ? 1 : 0);
    if (failure === 'post-success-auth') assert.equal(f.github.state.requests[0].state, 'applied');
  });
}

for (const failure of ['unavailable', 'exhausted', 'cleanup-failure']) {
  test(`quota ${failure}: frequent cron removed or explicitly unconfirmed; late run cannot consume`, async t => {
    const f = await privateWorkflowFixture(t); await f.select();
    await job(f); const count = f.calls().length;
    const oldSchedule = f.schedule.plan;
    const quota = failure === 'unavailable' ? null : { ...f.quota, periods: [{ ...f.quota.periods[0], providerRemainingMinutes: 0 }] };
    if (failure === 'cleanup-failure') f.schedule.fail = 'write';
    f.clock += 300; const result = await job(f, { quota });
    assert.equal(f.calls().length, count); assert.equal(f.github.state.scheduler.mode, 'paused');
    if (failure === 'cleanup-failure') {
      assert.equal(f.schedule.plan, oldSchedule); assert.equal(f.github.state.scheduler.publication, 'unconfirmed');
      assert.equal(result.problem, 'schedule_write_unconfirmed');
      assert.match(result.summary, /Остановка\/установка расписания не подтверждена/);
    } else assert.deepEqual(f.schedule.expressions(), []);
    await job(f, { quota }); assert.equal(f.calls().length, count);
  });
}

test('remaining discovery jobs fit pause projection and no budget yields no schedule; fresh resume keeps deadline', async t => {
  const f = await privateWorkflowFixture(t); await f.select();
  const quota = { ...f.quota, periods: [{ ...f.quota.periods[0], usedMinutes: 893 }] };
  const result = await job(f, { quota });
  assert.equal(result.report.scheduler.mode, 'paused'); assert.equal(f.calls().length, 0);
  assert.ok(result.report.scheduler.desired.forecast.every(p => p.minutesWithReserve <= 1000));
  const deadline = f.github.state.cycles[0].deadline;
  await job(f, { command: f.command('resume') });
  assert.equal(f.calls().length, 1); assert.equal(f.github.state.cycles[0].deadline, deadline);
  const receipt = JSON.stringify({ observedAt: NOW, quota: f.quota });
  assert.deepEqual(readQuotaReceipt(receipt, NOW + 300), { ...f.quota, validUntil: NOW + 301 });
  assert.equal(readQuotaReceipt(receipt, NOW + 301), null); assert.equal(readQuotaReceipt(receipt, NOW - 1), null);
});

test('billing receipt expires during external startup: final guard prevents consume and removes schedule', async t => {
  const f = await privateWorkflowFixture(t); await f.select();
  const quota = readQuotaReceipt(JSON.stringify({ observedAt: NOW, quota: f.quota }), NOW);
  f.open = async () => { f.clock = NOW + 301; };
  const result = await job(f, { quota });
  assert.equal(f.calls().length, 0);
  assert.equal(result.report.scheduler.mode, 'paused');
  assert.deepEqual(f.schedule.expressions(), []);
});

test('disable/revoke during sent RPC preserves confirmed result and prevents new consume without cancelling send', async t => {
  for (const flag of ['disable', 'revoke']) {
    const f = await privateWorkflowFixture(t); await f.select(); f.rpc.state.outcome = 'reset';
    f.afterResponse = async method => {
      if (method === 'account/rateLimitResetCredit/consume') {
        const engine = new CycleEngine(f.github.storage, f.account(), { now: () => f.clock });
        const { command, ...control } = f.command(flag);
        await engine.command(control);
      }
    };
    await job(f); await job(f);
    assert.equal(f.calls().length, 1); assert.equal(f.github.state.requests[0].state, 'applied');
    assert.equal(f.github.state.groups[0].outcome, 'applied'); assert.deepEqual(f.schedule.expressions(), []);
  }
});

test('confirmed consume survives runtime cleanup failure; subsequent host intervals stop', async t => {
  const f = await privateWorkflowFixture(t); await f.select(); f.rpc.state.outcome = 'reset';
  const open = f.external.open;
  f.external.open = async tokens => {
    const handle = await open(tokens);
    const close = handle.close;
    handle.close = async () => {
      await close();
      if (f.calls().length) throw new Error('cleanup-secret-error');
    };
    return handle;
  };
  const result = await job(f);
  assert.equal(f.github.state.requests[0].state, 'applied');
  assert.equal(f.calls().length, 1); assert.match(result.summary, /Применение подтверждено/);
  await job(f); assert.equal(f.calls().length, 1);
});

for (const cut of ['state.publishing', 'state.ready', 'result']) {
  test(`integrated writeback failure at ${cut} preserves exact target or unknown journal`, async t => {
    const f = await privateWorkflowFixture(t);
    if (cut === 'result') {
      await f.select(); f.rpc.state.outcome = 'reset';
      f.afterResponse = async method => {
        if (method.endsWith('/consume')) f.github.fail = 'conflict';
      };
    } else f.hook = async e => {
      if (cut === 'state.publishing' && e === 'local.saved' || cut === 'state.ready' && e === 'secret.put') f.github.fail = 'conflict';
    };
    const result = await job(f);
    if (cut === 'result') {
      assert.equal(f.calls().length, 1); assert.equal(f.github.state.requests[0].state, 'unconfirmed');
      f.github.fail = null; await job(f); assert.equal(f.calls().length, 1);
    } else {
      assert.equal(f.calls().length, 0);
      assert.equal(f.github.state.auth.phase, cut === 'state.publishing' ? 'inflight' : 'publishing');
      if (cut === 'state.ready') {
        const refreshes = f.refreshes;
        f.github.fail = null; f.hook = async () => {};
        await job(f);
        assert.equal(f.github.state.auth.phase, 'ready'); assert.equal(f.refreshes, refreshes);
      }
    }
    assert.ok(!/secret-error|synthetic-refresh|synthetic-PAT/.test(result.summary));
  });
}

test('English Summary and status command never send consume; rejected partial auto-selection has no command receipt', async t => {
  const f = await privateWorkflowFixture(t, { language: 'en' }); await f.select();
  const status = await job(f, { command: { command: 'status' } });
  assert.equal(f.calls().length, 0); assert.match(status.summary, /Granted reset application/);
  f.rpc.state.count = 2;
  const command = f.command('select', { commandId: 'partial-auto', deltaSeconds: 3600 });
  const result = await job(f, { command });
  assert.equal(result.problem, 'auto_select_requires_complete_metadata');
  assert.ok(!f.github.state.commands.some(c => c.commandId === 'partial-auto'));
  assert.match(result.summary, /Command unconfirmed/);
});

test('expired hour can be retried explicitly; routine refresh/resume cannot extend its original deadline', async t => {
  const f = await privateWorkflowFixture(t, { expiry: null }); await f.select();
  f.clock = NOW + 3600; await job(f); assert.equal(f.calls().length, 0);
  await job(f, { command: f.command('resume') });
  assert.equal(f.github.state.cycles[0].originalDeadline, NOW + 3600);
  f.identity = { exp: NOW + 10000 };
  await job(f, { command: f.command('retry', { creditId: 'selected-017' }) });
  assert.equal(f.calls().length, 1);
  assert.equal(f.github.state.cycles.at(-1).originalDeadline, NOW + 7200);
});

test('stale grant fails before host OAuth/runtime while fresh storage remains authoritative', async t => {
  const f = await privateWorkflowFixture(t); await f.select();
  const original = f.account;
  f.account = () => { const a = original(); a.session.fingerprint = '0'.repeat(64); return a; };
  const refreshes = f.refreshes;
  const result = await job(f);
  assert.equal(result.problem, 'stale_grant'); assert.equal(f.calls().length, 0); assert.equal(f.refreshes, refreshes);
  assert.match(result.summary, /stale_grant/);
});

// Check the host transport boundary after the child runtime has started, not only
// the local afterReserve checkpoint: no async auth/startup work may outlive eligibility.
for (const [name, advance, expectedReason] of [
  ['weekly renewal', 120, 'weekly_exhaustion_unconfirmed'],
  ['weekly evidence freshness', 300, 'weekly_exhaustion_unconfirmed'],
  ['cycle deadline', 240, 'deadline_reached'],
]) test(`weekly guard at host runtime startup: ${name}`, async t => {
  const f = await privateWorkflowFixture(t, { expiry: NOW + (name === 'cycle deadline' ? 240 : 3600) }); await f.select();
  f.rpc.state.limits = { limitId: 'codex', rateLimitReachedType: 'rate_limit_reached', spendControlReached: false,
    primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: NOW + 5000 },
    secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: NOW + (name === 'weekly renewal' ? 120 : 604800) } };
  f.open = async () => { if (f.github.state.requests.some(r => r.state === 'unconfirmed')) f.clock = NOW + advance; };
  await job(f);
  assert.equal(f.calls().length, 0);
  assert.equal(f.github.state.requests.length, 1);
  assert.equal(f.github.state.requests[0].state, 'notSent');
  assert.equal(f.github.state.requests[0].reason, expectedReason);
});

test('timer wake is recorded; daily fallback reconciles without account access and reports a stale timer', async t => {
  const f = await privateWorkflowFixture(t); await f.select();
  // External timer: an empty dispatch is an ordinary run and records the wake.
  let result = await job(f, { event: 'workflow_dispatch' });
  assert.equal(result.timerProblem, null); assert.equal(f.calls().length, 1);
  assert.equal(f.github.state.scheduler.wokenAt, NOW);
  const since = f.github.state.scheduler.planSince; assert.ok(since >= NOW);
  f.clock = NOW + 60; await job(f, { event: 'workflow_dispatch', command: { command: 'status' } });
  assert.equal(f.github.state.scheduler.wokenAt, NOW); // Status is not a timer tick.
  // Fallback while the timer is healthy: reconcile only, the due attempt waits for the timer.
  f.clock = NOW + 300;
  result = await job(f, { event: 'schedule' });
  assert.equal(result.problem, null); assert.equal(result.timerProblem, null); assert.equal(f.calls().length, 1);
  assert.equal(f.github.state.scheduler.publication, 'confirmed');
  // Forty minutes without a wake while the window plan expects one every five.
  f.clock = NOW + 2400;
  result = await job(f, { event: 'schedule' });
  assert.equal(result.timerProblem, 'external_timer_stale'); assert.equal(f.calls().length, 1);
  assert.match(result.summary, /Резервный запуск: внешний таймер не будил установку/);
  assert.ok(f.schedule.expressions().length > 0); // Windows stay published for the timer.
  // The next wake clears the judgement; a late native run never catches up an attempt by itself.
  f.clock = NOW + 2700; await job(f, { event: 'workflow_dispatch' });
  assert.equal(f.calls().length, 2); assert.equal(f.github.state.scheduler.wokenAt, NOW + 2700);
  f.clock = NOW + 2800; result = await job(f, { event: 'schedule' });
  assert.equal(result.timerProblem, null); assert.equal(f.calls().length, 2);
});
