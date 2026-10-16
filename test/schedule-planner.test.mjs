import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FileStateStore, initialState, validateState } from '../src/state-store.mjs';
import { CycleEngine } from '../src/reset-cycles.mjs';
import { AccountAdapter } from '../src/account.mjs';
import { MockRpc } from '../testing/mock-rpc.mjs';
import { credit } from '../testing/fake-backend.mjs';
import { scheduleFixture } from '../testing/schedule-fixture.mjs';
import { readManagedSchedule, readTimerPlan, renderTimerPlan, TIMER_PLAN_PATH } from '../src/github-schedule.mjs';
import { SchedulePlanner, planSchedule, activeWindows, compileSlots, expandCron, windowSlots, admitObserverQuota, timerProblem,
  DISCOVERY_CRON, FALLBACK_CRON, TIMER_GRACE_SECONDS } from '../src/schedule-planner.mjs';
import { renderPrivateWorkflow } from '../src/private-workflow.mjs';
import { scheduleHash } from '../src/schedule-state.mjs';
import { HORIZON, firstSlot, slotCount } from '../src/schedule-time.mjs';
import { renderCycleReport } from '../src/cycle-report.mjs';

const utc = value => Date.parse(value) / 1000;
const BASE = utc('2026-10-08T00:00:00Z');
const row = (id, expiry) => credit(id, { expires_at: expiry === null ? null : new Date(expiry * 1000).toISOString() });
const period = (start = BASE, end = BASE + 30 * 86400, fields = {}) => ({ start, end, usedMinutes: 0,
  providerRemainingMinutes: null, paidUsageBlocked: true, ...fields });
const quota = (fields = {}, periods = [period()]) => ({ periods, queuedJobs: 0, cleanupDelaySeconds: 300, ...fields });

async function fixture(t, { expiry = BASE + 3600, start = BASE, plan } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'schedule-planner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json'), store = new FileStateStore(path);
  await store.initialize();
  await store.update(s => { s.settings.weeklyAutoReset = true; });
  const rpc = new MockRpc(); rpc.state.rows = [row('a', expiry)]; rpc.state.count = 1; rpc.state.outcome = 'nothing_to_reset';
  const work = scheduleFixture(plan === undefined ? {} : { plan }); let now = start;
  const f = { store, rpc, work, path, time: () => now, setTime: n => { now = n; } };
  f.restart = (options = {}) => {
    f.engine = new CycleEngine(new FileStateStore(path), new AccountAdapter(rpc, { now: f.time }), { now: f.time, ...options });
    f.planner = new SchedulePlanner(new FileStateStore(path), work.writer, { now: f.time, ...options });
  };
  f.restart();
  f.command = async (action, fields = {}) => f.engine.command({ action, commandId: randomUUID(), expectedVersion: (await store.read()).version, ...fields });
  f.select = (fields = {}) => f.command('select', { creditId: 'a', ...fields });
  return f;
}

test('compiler expands exact year/month/midnight slots without extra hour-minute products', () => {
  for (const [start, end] of [
    ['2026-12-31T23:54:20Z', '2027-01-01T00:09:20Z'],
    ['2026-10-31T23:54:20Z', '2026-11-01T00:09:20Z'],
    ['2028-02-28T23:54:20Z', '2028-02-29T00:09:20Z'],
    ['2026-10-08T10:54:20Z', '2026-10-08T11:04:20Z'],
  ]) {
    const a = utc(start), b = utc(end), slots = windowSlots([{ start: a, end: b }]);
    const cron = compileSlots(slots, { discovery: false });
    assert.deepEqual(expandCron(cron, Math.floor(a / 86400) * 86400, Math.ceil(b / 86400) * 86400), slots);
  }
  assert.deepEqual(compileSlots([utc('2026-10-08T10:57:00Z'), utc('2026-10-08T11:02:00Z')], { discovery: false }),
    ['2 11 8 10 *', '57 10 8 10 *']);
});

test('round-up/exclusive deadline for short delta; hours and days compress only exact sets', () => {
  const ten = utc('2026-10-08T10:00:00Z');
  assert.equal(slotCount(ten + 240, ten + 360), 0);
  assert.equal(slotCount(ten + 120, ten + 360), 1);
  assert.equal(slotCount(ten + 150, ten + 420), 0);
  assert.equal(slotCount(ten + 150, ten + 421), 1);
  for (let second = 0; second < 300; second++) {
    const slots = windowSlots([{ start: ten + second, end: ten + second + 3600 }]);
    assert.equal(slots.length, 12);
    assert.ok(slots.every(at => at >= ten + second && at < ten + second + 3600));
    assert.deepEqual(expandCron(compileSlots(slots, { discovery: false }), ten, ten + 7200), slots);
  }
});

test('empty queue: 180 timer discovery jobs + 30 daily fallback runs, 520 minutes including reserve; no separate OAuth jobs', () => {
  const p = planSchedule(initialState(), { now: BASE, quota: quota() });
  assert.equal(p.mode, 'active'); assert.deepEqual(p.expressions, [DISCOVERY_CRON]);
  assert.equal(p.forecast[0].runnerJobs, 180); assert.equal(p.forecast[0].fallbackJobs, 30);
  assert.equal(p.forecast[0].minutesWithReserve, 520); // ADR-0002: discovery 360 + fallback 60 + reserve 100.
  for (const w of ['provider_quota_unknown', 'runner_cost_includes_startup_oauth_publication', 'delivery_has_no_sla', 'windows_need_external_timer']) {
    assert.ok(p.warnings.includes(w), w);
  }
  // The fallback is charged in every supplied period, including a partial current one.
  const two = planSchedule(initialState(), { now: BASE + 6 * 3600, quota: quota({}, [period(), period(BASE + 30 * 86400, BASE + 60 * 86400)]) });
  assert.deepEqual(two.forecast.map(f => f.fallbackJobs), [29, 30]);
});

test('future windows published ahead of time; merged runners preserve distinct minute groups and dedup discovery', async t => {
  const f = await fixture(t, { expiry: BASE + 7200 });
  await f.select();
  f.rpc.state.rows.push(row('b', BASE + 7201)); f.rpc.state.count = 2;
  // Same-minute explicit selection replaces, rather than producing a second user group.
  await f.command('select', { creditId: 'b' });
  f.rpc.state.rows.push(row('c', BASE + 7261)); f.rpc.state.count = 3;
  await f.command('select', { creditId: 'c', deltaSeconds: 3661 });
  const before = await f.store.read();
  const result = await f.planner.reconcile({ quota: quota() });
  assert.equal(result.publication, 'confirmed'); assert.equal(result.mode, 'active'); assert.deepEqual(result.dueCycleIds, []);
  const groups = (await f.store.read()).groups;
  assert.deepEqual(groups, before.groups); assert.equal(groups.length, 2);
  const p = planSchedule(await f.store.read(), { now: BASE, quota: quota() });
  assert.equal(p.windows.length, 1);
  const jobs = expandCron(f.work.expressions(), BASE, BASE + 86400);
  assert.equal(new Set(jobs).size, jobs.length);
  await f.engine.run(); assert.equal(f.rpc.state.requests.length, 0);
});

test('compiler size limit rejects with explicit preserving fallback; never alters delta or emits permanent frequent cron', async t => {
  const f = await fixture(t, { expiry: BASE + 7200 }); await f.select();
  const before = (await f.store.read()).cycles;
  f.planner = new SchedulePlanner(f.store, f.work.writer, { now: f.time, maxExpressions: 1 });
  const p = await f.planner.reconcile({ quota: quota() });
  assert.equal(p.mode, 'paused'); assert.equal(p.reason, 'cron_compiler_limit_exceeded');
  assert.deepEqual((await f.store.read()).cycles, before);
  assert.deepEqual(f.work.expressions(), []); assert.ok(p.desired.warnings.includes('manual_quota_recovery_required'));
  assert.throws(() => compileSlots([], { maxExpressions: 0 }), /invalid_cron_limit/);
  assert.throws(() => compileSlots([], { maxExpressions: 4097 }), /invalid_cron_limit/);
});

test('long delta uses combined quota for every explicit billing period; no inferred calendar-month allowance', async t => {
  const f = await fixture(t, { expiry: BASE + 31 * 86400 });
  await f.select({ deltaSeconds: 24 * 3600 });
  let p = await f.planner.reconcile({ quota: quota() });
  assert.equal(p.reason, 'future_period_quota_required');
  const periods = [period(), period(BASE + 30 * 86400, BASE + 60 * 86400)];
  p = await f.planner.reconcile({ quota: quota({}, periods), resume: true });
  assert.equal(p.reason, 'service_quota_insufficient'); // 24h window + discovery exceeds 1000 in the next period.
  assert.equal((await f.store.read()).cycles[0].deltaSeconds, 86400);
  assert.equal((await f.store.read()).cycles[0].deadline, BASE + 31 * 86400);
});

test('24h long delta is rejected while overlapping windows and discovery are costed as union of actual triggers', async t => {
  const f = await fixture(t, { expiry: BASE + 86400 }); await f.select({ deltaSeconds: 86400 });
  const p = planSchedule(await f.store.read(), { now: BASE, quota: quota() });
  assert.equal(p.mode, 'paused'); assert.equal(p.reason, 'service_quota_insufficient');
  assert.equal(activeWindows(await f.store.read(), BASE).length, 1);
  const all = compileSlots(windowSlots([{ start: BASE, end: BASE + 30 * 86400 }]));
  assert.equal(expandCron(all, BASE, BASE + 30 * 86400).length, 8640);
});

test('unknown quota never costs zero; protection required even with known provider allowance', () => {
  for (const q of [undefined, { periods: [] }]) {
    const p = planSchedule(initialState(), { now: BASE, quota: q });
    assert.equal(p.reason, 'quota_unavailable'); assert.deepEqual(p.expressions, []);
  }
  const p = planSchedule(initialState(), { now: BASE, quota: quota({}, [period(BASE, BASE + 30 * 86400,
    { providerRemainingMinutes: 2000, paidUsageBlocked: false })]) });
  assert.equal(p.reason, 'paid_usage_protection_required'); assert.deepEqual(p.expressions, []);
  const protectedUnknown = planSchedule(initialState(), { now: BASE, quota: quota() });
  assert.equal(protectedUnknown.mode, 'active');
});

test('provider residual constrains admission and bounded recovery independently of service counter', () => {
  const p = planSchedule(initialState(), { now: BASE, quota: quota({}, [period(BASE, BASE + 30 * 86400,
    { providerRemainingMinutes: 166 })]) });
  assert.equal(p.reason, 'provider_quota_insufficient');
  // Recovery fits beside the fallback runs the planner cannot remove.
  assert.equal(p.forecast[0].runnerJobs, 3); assert.equal(p.forecast[0].fallbackJobs, 30); assert.equal(p.forecast[0].minutesWithReserve, 166);
  assert.ok(!p.warnings.includes('fallback_exceeds_quota'));
});

test('durable quota pause removes frequent cron before consumption; queued/delayed cleanup counted and stop job reserved', async t => {
  const f = await fixture(t); await f.select();
  const active = await f.planner.reconcile({ quota: quota() });
  assert.equal(active.mode, 'active'); assert.equal(active.desired.forecast[0].runnerJobs, 191);
  const original = structuredClone((await f.store.read()).cycles[0]);
  const old = f.work.expressions();
  const q = quota({ queuedJobs: 2, cleanupDelaySeconds: 600 }, [period(BASE, BASE + 30 * 86400, { usedMinutes: 824 })]);
  const paused = await f.planner.reconcile({ quota: q });
  assert.equal(paused.mode, 'paused'); assert.equal(paused.reason, 'service_quota_insufficient'); assert.equal(paused.publication, 'confirmed');
  const forecast = paused.desired.forecast[0];
  assert.equal(forecast.pendingJobs, 2 + expandCron(old, BASE, BASE + 600).length);
  assert.ok(forecast.minutesWithReserve <= 1000); assert.equal(forecast.fallbackJobs, 30);
  assert.ok(forecast.runnerJobs > 0 && forecast.runnerJobs < 6);
  assert.equal(forecast.runnerJobs, expandCron(f.work.expressions(), BASE, BASE + 30 * 86400).length);
  assert.ok(expandCron(f.work.expressions(), BASE, BASE + 86400).every(at => (at - 120) % 14400 === 0));
  assert.deepEqual((await f.store.read()).cycles[0], original);
  f.restart(); await f.engine.run(); assert.equal(f.rpc.state.requests.length, 0);
  const restored = await f.planner.reconcile({ quota: quota() });
  assert.equal(restored.mode, 'paused'); // No implicit resume after fresh quota arrives.
  const resumed = await f.planner.reconcile({ quota: quota(), resume: true });
  assert.equal(resumed.mode, 'active');
  assert.equal((await f.store.read()).cycles[0].deadline, original.deadline);
});

test('no budget for discovery disables everything and report supplies manual recovery path', async t => {
  const f = await fixture(t); await f.select(); await f.planner.reconcile({ quota: quota() });
  const p = await f.planner.reconcile({ quota: quota({}, [period(BASE, BASE + 30 * 86400, { usedMinutes: 900 })]) });
  assert.equal(p.mode, 'paused'); assert.deepEqual(p.desired.expressions, []); assert.deepEqual(f.work.expressions(), []);
  assert.ok(p.desired.warnings.includes('manual_quota_recovery_required'));
  // 900 + 30 fallback runs + reserve exceed 1000: only disabling the workflow stops them.
  assert.ok(p.desired.warnings.includes('fallback_exceeds_quota'));
  for (const language of ['ru', 'en']) {
    const r = await f.engine.status(); r.language = language;
    assert.match(renderCycleReport(r), /resume/);
  }
});

test('failed cleanup persists unconfirmed stopping; late old workflow never consumes; recovery does not restart hour', async t => {
  const f = await fixture(t, { expiry: null }); await f.select({ scheduledAt: BASE });
  await f.planner.reconcile({ quota: quota() });
  const old = f.work.expressions(); f.work.fail = 'write';
  let p = await f.planner.reconcile({ quota: quota({}, [period(BASE, BASE + 30 * 86400, { usedMinutes: 900 })]) });
  assert.equal(p.mode, 'paused'); assert.equal(p.publication, 'unconfirmed'); assert.equal(p.problem, 'schedule_write_unconfirmed');
  assert.deepEqual(f.work.expressions(), old);
  assert.ok(p.desired.forecast[0].pendingJobs >= 1);
  assert.equal(p.observed.forecast[0].runnerJobs, expandCron(old, BASE, BASE + 30 * 86400).length);
  assert.ok(p.observed.forecast[0].minutesWithReserve > 1000);
  assert.match(renderCycleReport(await f.engine.status()), /queued/);
  f.restart(); f.setTime(BASE + 1800); await f.engine.run(); assert.equal(f.rpc.state.requests.length, 0);
  f.work.fail = null;
  p = await f.planner.reconcile({ quota: quota(), resume: true });
  assert.equal(p.mode, 'active');
  await f.engine.run(); await f.engine.run(); assert.equal(f.rpc.state.requests.length, 1);
  f.setTime(BASE + 3600); await f.engine.run(); assert.equal(f.rpc.state.requests.length, 1);
  assert.equal((await f.store.read()).cycles[0].originalDeadline, BASE + 3600);
});

test('actual clock/nextAttemptAt: future, late, missed and boundary runs; admitted billing period also expires', async t => {
  const f = await fixture(t, { expiry: BASE + 7200 }); await f.select();
  await f.planner.reconcile({ quota: quota() });
  f.setTime(BASE + 3599); await f.engine.run(); assert.equal(f.rpc.state.requests.length, 0);
  f.setTime(BASE + 4600); assert.equal((await f.engine.status()).cycles[0].executionProblem, 'attempt_delayed_or_missed');
  f.setTime(BASE + 4600); await f.engine.run(); await f.engine.run(); assert.equal(f.rpc.state.requests.length, 1);
  f.restart(); f.setTime(BASE + 4899); await f.engine.run(); assert.equal(f.rpc.state.requests.length, 1);
  f.setTime(BASE + 6900); await f.engine.run(); assert.equal(f.rpc.state.requests.length, 2);
  assert.equal((await f.store.read()).cycles[0].nextAttemptAt, BASE + 7200);
  f.setTime(BASE + 7200); await f.engine.run(); assert.equal(f.rpc.state.requests.length, 2);
  await f.planner.reconcile({ quota: quota() }); assert.deepEqual(f.work.expressions(), [DISCOVERY_CRON]);
});

test('quota admission interval ends even when cycle boundary is later', async t => {
  const f = await fixture(t); await f.select(); await f.planner.reconcile({ quota: quota() });
  await f.store.update(s => { s.scheduler.admittedUntil = BASE + 60; });
  f.setTime(BASE + 60); await f.engine.run(); assert.equal(f.rpc.state.requests.length, 0);
});

test('publication refusal after success retains applied journal and next reconcile cleans without new consume', async t => {
  const f = await fixture(t); await f.select(); await f.planner.reconcile({ quota: quota() });
  f.rpc.state.outcome = 'reset'; await f.engine.run(); assert.equal(f.rpc.state.requests.length, 1);
  f.work.fail = 'write'; let p = await f.planner.reconcile({ quota: quota() }); assert.equal(p.publication, 'unconfirmed');
  assert.equal((await f.store.read()).requests[0].state, 'applied');
  f.restart(); await f.engine.run(); assert.equal(f.rpc.state.requests.length, 1);
  f.work.fail = null; p = await f.planner.reconcile({ quota: quota() });
  assert.equal(p.publication, 'confirmed'); assert.deepEqual(f.work.expressions(), [DISCOVERY_CRON]);
});

test('disable removes all schedule; select/apply-now/resume require fresh quota admission once planner configured', async t => {
  const f = await fixture(t); await f.select(); await f.planner.reconcile({ quota: quota() });
  await f.command('apply-now', { creditId: 'a' });
  assert.equal((await f.store.read()).scheduler.mode, 'needsAdmission');
  await f.engine.run(); assert.equal(f.rpc.state.requests.length, 0);
  await f.planner.reconcile({ quota: quota() });
  await f.command('disable'); await f.planner.reconcile({ quota: quota() });
  assert.deepEqual(f.work.expressions(), []);
  await f.command('resume'); await f.engine.run(); assert.equal(f.rpc.state.requests.length, 0);
  await f.planner.reconcile({ quota: quota(), resume: true }); await f.engine.run(); assert.equal(f.rpc.state.requests.length, 1);
});

test('quota pause during startup is rechecked at final dispatch, with no consume and no unresolved request', async t => {
  const f = await fixture(t); await f.select(); await f.planner.reconcile({ quota: quota() });
  f.restart({ checkpoint: async name => {
    if (name === 'afterReserve') await f.store.update(s => { s.scheduler.mode = 'paused'; s.scheduler.reason = 'service_quota_insufficient'; s.scheduler.admittedUntil = null; });
  } });
  await f.engine.run(); assert.equal(f.rpc.state.requests.length, 0);
  assert.equal((await f.store.read()).requests[0].state, 'notSent');
});

test('unknown outcome removes active windows but retains request/group history across reconcile', async t => {
  const f = await fixture(t); await f.select(); await f.planner.reconcile({ quota: quota() });
  f.restart({ checkpoint: async name => { if (name === 'afterReserve') throw new Error('crash'); } });
  await assert.rejects(f.engine.run(), /crash/);
  const before = await f.store.read(); f.restart(); await f.planner.reconcile({ quota: quota() });
  assert.deepEqual(f.work.expressions(), [DISCOVERY_CRON]);
  assert.deepEqual((await f.store.read()).requests, before.requests); assert.deepEqual((await f.store.read()).groups, before.groups);
  await f.engine.run(); assert.equal(f.rpc.state.requests.length, 0);
});

test('default branch/SHA checked; no identical workflow PUT; exact lost response readback; conflict and state race unconfirmed', async t => {
  const f = await fixture(t); await f.select(); f.work.branch = 'trunk';
  f.work.fail = 'lost-response'; let p = await f.planner.reconcile({ quota: quota() });
  assert.equal(p.publication, 'confirmed'); assert.equal(p.confirmed.branch, 'trunk');
  const puts = f.work.puts; f.work.fail = null;
  await f.planner.reconcile({ quota: quota() }); assert.equal(f.work.puts, puts);
  await f.command('disable'); f.work.fail = 'conflict'; p = await f.planner.reconcile({ quota: quota() });
  assert.equal(p.publication, 'unconfirmed');
  f.work.fail = null;
  f.planner = new SchedulePlanner(f.store, f.work.writer, { now: f.time, checkpoint: async name => {
    if (name === 'afterScheduleIntent') await f.store.update(s => { s.settings.language = 'en'; });
  } });
  p = await f.planner.reconcile({ quota: quota() }); assert.equal(p.publication, 'unconfirmed'); assert.equal(f.work.puts, puts);
});

test('pending intent survives interruption and reconstructs schedule from current state', async t => {
  const f = await fixture(t); await f.select();
  f.restart({ checkpoint: async name => { if (name === 'afterScheduleIntent') throw new Error('crash'); } });
  await assert.rejects(f.planner.reconcile({ quota: quota() }), /crash/);
  const s = await f.store.read(); assert.equal(s.scheduler.publication, 'pending'); assert.equal(f.work.puts, 0);
  f.restart(); const p = await f.planner.reconcile({ quota: quota() }); assert.equal(p.publication, 'confirmed');
  assert.equal((await f.store.read()).cycles[0].deadline, BASE + 3600);
});

test('unreadable timer plan pauses rather than using last confirmed cost as zero', async t => {
  const f = await fixture(t); await f.select(); await f.planner.reconcile({ quota: quota() });
  f.work.fail = 'read'; const p = await f.planner.reconcile({ quota: quota() });
  assert.equal(p.reason, 'published_schedule_unavailable'); assert.equal(p.publication, 'unconfirmed');
  await f.engine.run(); assert.equal(f.rpc.state.requests.length, 0);
  assert.ok(!JSON.stringify(await f.store.read()).includes('synthetic-secret'));
});

test('yearless stale triggers and queued jobs are charged even though state rejects early consume', async t => {
  const f = await fixture(t, { expiry: BASE + HORIZON }); await f.select();
  f.work.plan = renderTimerPlan(['2 0 8 10 *']);
  const p = await f.planner.reconcile({ quota: quota({ queuedJobs: 3, cleanupDelaySeconds: 3600 }, [
    period(BASE, BASE + 30 * 86400), ...Array.from({ length: 12 }, (_, i) => period(BASE + (30 + i * 30) * 86400, BASE + (60 + i * 30) * 86400)),
  ]) });
  assert.equal(p.mode, 'active'); assert.equal(p.desired.forecast[0].pendingJobs, 4);
  await f.engine.run(); assert.equal(f.rpc.state.requests.length, 0);
});

test('timer plan is one canonical JSON line in the restricted dialect; planner never edits the workflow', async t => {
  const plan = renderTimerPlan([DISCOVERY_CRON, '7,12 10 8 10 *']);
  assert.equal(plan, `{"schema":1,"expressions":["${DISCOVERY_CRON}","7,12 10 8 10 *"]}\n`);
  assert.deepEqual(readTimerPlan(plan), [DISCOVERY_CRON, '7,12 10 8 10 *']);
  assert.deepEqual(readTimerPlan(renderTimerPlan([])), []);
  for (const bad of ['*/5 * * * *', '2 0 1 1 1', '60 0 1 1 *']) assert.throws(() => renderTimerPlan([bad]));
  assert.throws(() => renderTimerPlan([DISCOVERY_CRON, DISCOVERY_CRON]), /invalid_timer_plan/);
  for (const bad of [plan.trimEnd(), plan.replace('"schema":1', '"schema":2'), plan.replace('}', ',"x":1}'),
    `${JSON.stringify({ expressions: [], schema: 1 })}\n`, 'null\n', '[]\n', '']) assert.throws(() => readTimerPlan(bad), /invalid_timer_plan/);
  assert.ok(!TIMER_PLAN_PATH.startsWith('.github/workflows/')); // Contents: write, not Workflows: write.
  const f = await fixture(t); await f.select(); await f.planner.reconcile({ quota: quota() });
  assert.ok(f.work.puts > 0); assert.equal(f.work.workflowPuts, 0);
  assert.ok(f.work.requests.filter(r => r.method === 'PUT').every(r => r.path === `/contents/${TIMER_PLAN_PATH}`));
});

test('template carries only the static daily fallback, readable by pre-37 Upgrade readback', async () => {
  const content = await renderPrivateWorkflow('1'.repeat(40));
  // readManagedSchedule is unchanged from the pins that perform the Upgrade into this template.
  assert.deepEqual(readManagedSchedule(content), [FALLBACK_CRON]);
  assert.equal((content.match(/- cron:/g) ?? []).length, 1);
  const [minute, hour] = FALLBACK_CRON.split(' ').map(Number);
  assert.notEqual((minute - 2) % 5, 0); // Off the timer grid: never shares a slot's duplicate check.
  assert.ok(minute >= 15 && minute <= 45 && hour !== 0); // Away from the start of the hour and midnight UTC.
  assert.throws(() => readManagedSchedule(content + '  # auto-reset:schedule:end\n'), /managed_schedule_region_missing/);
  assert.throws(() => readManagedSchedule(content.replace('on:', 'jobs:')), /managed_schedule_region_missing/);
  assert.throws(() => readManagedSchedule(content.replace('  workflow_dispatch:', '  schedule:\n  workflow_dispatch:')), /managed_schedule_region_missing/);
});

test('absent plan after Upgrade from a workflow-cron pin: old scheduler proof stays valid, empty plan created conditionally', async t => {
  const f = await fixture(t, { plan: null }); await f.select({ automation: false });
  // Scheduler written by a pin before 37: proof of the workflow file, forecast rows without fallbackJobs.
  await f.store.update(s => {
    const proof = { hash: scheduleHash([]), expressions: [], sha: 'e'.repeat(40), branch: 'main', confirmedAt: BASE - 60 };
    s.scheduler = { mode: 'paused', reason: 'installation_disabled', admittedUntil: null, publication: 'confirmed', problem: null,
      desired: { hash: proof.hash, expressions: [], sourceVersion: s.version, createdAt: BASE - 60, warnings: ['delivery_has_no_sla'],
        forecast: [{ start: BASE, end: BASE + 30 * 86400, runnerJobs: 0, pendingJobs: 0, minutesWithReserve: 100, providerRemainingMinutes: null }] },
      confirmed: proof, observed: { ...proof, forecast: [] } };
    s.disabled = true;
  });
  const before = await f.store.read(); validateState(before);
  assert.deepEqual(f.work.expressions(), []); assert.equal(f.work.plan, null);
  const p = await f.planner.reconcile({ quota: quota() });
  assert.equal(p.publication, 'confirmed'); assert.equal(f.work.plan, renderTimerPlan([]));
  assert.equal(p.confirmed.sha, f.work.planSha); assert.equal(p.planSince, BASE);
  const after = await f.store.read();
  for (const k of ['cycles', 'groups', 'requests', 'commands']) assert.deepEqual(after[k], before[k]);
  const puts = f.work.puts; f.setTime(BASE + 600);
  assert.equal((await f.planner.reconcile({ quota: quota() })).planSince, BASE); assert.equal(f.work.puts, puts);
  // A changed plan takes effect anew: its earlier slots never count against the timer.
  await f.store.update(s => { s.disabled = false; });
  const enabled = await f.planner.reconcile({ quota: quota(), resume: true });
  assert.deepEqual(enabled.confirmed.expressions, [DISCOVERY_CRON]); assert.equal(enabled.planSince, BASE + 600);
  // A plan that appears between read and conditional create is never overwritten.
  const g = await fixture(t, { plan: null });
  g.work.beforePut = async () => { g.work.plan = renderTimerPlan(['2 1 1 1 *']); g.work.planSha = 'f'.repeat(40); };
  const q = await g.planner.reconcile({ quota: quota() });
  assert.equal(q.publication, 'unconfirmed'); assert.deepEqual(g.work.expressions(), ['2 1 1 1 *']);
});

test('fallback judges the timer by planned slots since the plan took effect, with delivery grace', () => {
  const since = BASE, plan = [DISCOVERY_CRON, '7,12,17 10 8 10 *'];
  const s = { confirmed: { expressions: plan }, planSince: since };
  // Before any slot is older than the grace, nothing is due.
  assert.equal(timerProblem(s, BASE + 120 + TIMER_GRACE_SECONDS - 1), null);
  assert.equal(timerProblem(s, BASE + 120 + TIMER_GRACE_SECONDS), 'external_timer_stale');
  assert.equal(timerProblem({ ...s, wokenAt: BASE + 153 }, BASE + 120 + TIMER_GRACE_SECONDS), null);
  // Window slots 10:07–10:17: the wake must follow the latest slot older than the grace.
  const at = utc('2026-10-08T10:47:00Z');
  assert.equal(timerProblem({ ...s, wokenAt: utc('2026-10-08T10:12:40Z') }, at), 'external_timer_stale');
  assert.equal(timerProblem({ ...s, wokenAt: utc('2026-10-08T10:17:35Z') }, at), null);
  // A plan newer than its slots, an empty plan or a pre-37 scheduler is not judged.
  assert.equal(timerProblem({ ...s, planSince: utc('2026-10-08T10:20:00Z') }, at), null);
  assert.equal(timerProblem({ confirmed: { expressions: [] }, planSince: since }, at), null);
  assert.equal(timerProblem({ confirmed: { expressions: plan } }, at), null);
  assert.equal(timerProblem(undefined, at), null);
});

test('observer admission charges the daily fallback in every period', () => {
  const q = (usedMinutes, providerRemainingMinutes = 2000) => quota({ queuedJobs: 0 }, [period(BASE, BASE + 30 * 86400, { usedMinutes, providerRemainingMinutes })]);
  admitObserverQuota(q(840), BASE, 0); // 840 + 30 × 2 + 100 = 1000.
  assert.throws(() => admitObserverQuota(q(841), BASE, 0), /service_quota_insufficient/);
  admitObserverQuota(q(0, 170), BASE, 10);
  assert.throws(() => admitObserverQuota(q(0, 169), BASE, 10), /provider_quota_insufficient/);
});

test('schema rejects corrupted scheduling intent and preserves old schema-1 states and auth', async t => {
  validateState(initialState());
  const f = await fixture(t); await f.planner.reconcile({ quota: quota() });
  for (const mutate of [s => { s.scheduler.refresh_token = 'secret'; }, s => { s.scheduler.desired.hash = 'a'.repeat(64); },
    s => { s.scheduler.confirmed.sha = 'bad'; }, s => { s.scheduler.admittedUntil = null; }, s => { s.scheduler.wokenAt = '1'; },
    s => { s.scheduler.planSince = null; }, s => { s.scheduler.desired.forecast[0].fallbackJobs = -1; }]) {
    const s = await f.store.read(); mutate(s); assert.throws(() => validateState(s), /invalid_state/);
  }
  assert.equal(JSON.parse(await readFile(f.path, 'utf8')).schemaVersion, 1);
});

test('short intervals warn, reject zero slots and require risk acknowledgement for five to fifteen minutes', async t => {
  const f = await fixture(t, { expiry: BASE + 360 });
  const original = await f.store.read();
  await assert.rejects(f.select({ deltaSeconds: 120 }), /no_planned_slot_use_apply_now/);
  assert.deepEqual(await f.store.read(), original);
  await assert.rejects(f.select({ deltaSeconds: 300 }), /schedule_delay_risk_ack_required/);
  await assert.rejects(f.select({ deltaSeconds: 900 }), /schedule_delay_risk_ack_required/);
  await f.select({ deltaSeconds: 300, acknowledgeDelayRisk: true });
  const p = await f.planner.reconcile({ quota: quota() }); assert.ok(p.desired.warnings.includes('short_delta_delivery_risk'));
  const g = await fixture(t, { expiry: BASE + 240 }); await g.select({ deltaSeconds: 240 });
  const q = await g.planner.reconcile({ quota: quota() }); assert.ok(q.desired.warnings.includes('short_delta_may_have_no_slot'));
  assert.equal(firstSlot(BASE), BASE + 120);
});

test('365-day admission horizon rejects distant dates without clipping or deferred publication; retained old cycles untouched', async t => {
  const f = await fixture(t, { expiry: BASE + HORIZON + 1 }); const before = await f.store.read();
  await assert.rejects(f.select(), /schedule_horizon_exceeded/); assert.deepEqual(await f.store.read(), before);
  await f.select({ automation: false }); // Keeping an explicit ID without automation does not publish a distant deadline.
  const selected = await f.store.read();
  await assert.rejects(f.command('apply-now', { creditId: 'a' }), /schedule_horizon_exceeded/);
  assert.deepEqual(await f.store.read(), selected);
  const g = await fixture(t, { expiry: null });
  await assert.rejects(g.select({ scheduledAt: BASE + HORIZON + 1 }), /schedule_horizon_exceeded/);
  await g.select({ scheduledAt: BASE + HORIZON });
  const deadline = (await g.store.read()).cycles[0].deadline;
  g.setTime(BASE - 86400); // Previously accepted boundaries are not rewritten by reconcile.
  await g.planner.reconcile({ quota: quota({}, [period(BASE - 86400, BASE + 30 * 86400)]) });
  assert.equal((await g.store.read()).cycles[0].deadline, deadline);
});
