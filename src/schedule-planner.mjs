import { StateFailure, integer, validateState } from './state-store.mjs';
import { CADENCE, firstSlot, isDiscovery } from './schedule-time.mjs';
import { initialScheduler, scheduleHash, cycleArmed, watchWindow } from './schedule-state.mjs';
import { MAX_SECONDS, expandCron } from './managed-schedule.mjs';

export { expandCron };

export const DISCOVERY_CRON = '2 0,4,8,12,16,20 * * *';
// Static native fallback in templates/private-auto-reset.yml (ADR-0002): daily, off the timer grid
// and away from the start of the hour. Never rewritten, so it costs a job in every state.
export const FALLBACK_CRON = '41 5 * * *';
// Delivery delay tolerated before the fallback reports a planned slot without an external wake.
export const TIMER_GRACE_SECONDS = 1800;
// Timer probe (ticket 38): far enough ahead for a new Cloudflare Cron Trigger to propagate
// (up to 15 minutes) and for the admin job to publish the plan before the slot.
export const TIMER_PROBE_LEAD_SECONDS = 900;
export const timerProbeSlot = now => firstSlot(now + TIMER_PROBE_LEAD_SECONDS);
export const POLICY = Object.freeze({ limitMinutes: 1000, reserveMinutes: 100, minutesPerJob: 2, maxExpressions: 256 });
const fail = kind => { throw new StateFailure(kind); };
const terminal = c => ['applied', 'ended', 'superseded'].includes(c.status);
const sorted = values => [...new Set(values)].sort((a, b) => a - b);
const cap = value => { if (!integer(value) || value < 1 || value > 4096) fail('invalid_cron_limit'); return value; };

export function activeWindows(state, now) {
  if (state.disabled || state.revoked || state.reconnectRequested || state.requests.some(r => r.state === 'unconfirmed')) return [];
  const windows = state.cycles.filter(c => c.current && c.hasSchedule && !c.disabled && !terminal(c) && cycleArmed(state, c) &&
    !state.groups.some(g => c.groupKeys.includes(g.key) && (g.outcome !== 'selected' || g.selectedCreditId !== c.creditId)))
    .map(c => ({ start: Math.max(now, c.scheduledAt, c.nextAttemptAt ?? c.scheduledAt), end: c.deadline }))
    .concat(watchWindow(state, now) ?? [])
    .filter(w => w.start < w.end).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const w of windows) {
    const prior = merged.at(-1);
    if (prior && w.start <= prior.end) prior.end = Math.max(prior.end, w.end);
    else merged.push({ ...w });
  }
  return merged;
}

export function windowSlots(windows) {
  const slots = new Set();
  for (const w of windows) {
    if (!integer(w.start) || !integer(w.end) || w.end - w.start > MAX_SECONDS) fail('planner_range_exceeded');
    for (let at = firstSlot(w.start); at < w.end; at += CADENCE) slots.add(at);
  }
  return sorted(slots);
}

// Hours may share one expression only when their complete minute sets are identical.
// Never form a Cartesian product from unrelated hour/minute lists.
export function compileSlots(slots, { discovery = true, maxExpressions = POLICY.maxExpressions } = {}) {
  cap(maxExpressions);
  const days = new Map();
  for (const at of slots) {
    if (!integer(at) || at % 60 !== 0) fail('invalid_runner_slot');
    if (discovery && isDiscovery(at)) continue;
    const d = new Date(at * 1000);
    if (!Number.isFinite(d.getTime())) fail('invalid_runner_slot');
    const key = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    if (!days.has(key)) days.set(key, new Map());
    const hours = days.get(key), hour = d.getUTCHours();
    if (!hours.has(hour)) hours.set(hour, new Set());
    hours.get(hour).add(d.getUTCMinutes());
  }
  const expressions = discovery ? [DISCOVERY_CRON] : [];
  for (const [key, hours] of days) {
    const patterns = new Map();
    for (const [hour, minutes] of hours) {
      const pattern = sorted(minutes).join(',');
      if (!patterns.has(pattern)) patterns.set(pattern, []);
      patterns.get(pattern).push(hour);
    }
    const [month, day] = key.split('/');
    for (const [minutes, groupedHours] of patterns) expressions.push(`${minutes} ${sorted(groupedHours).join(',')} ${day} ${month} *`);
  }
  if (expressions.length > maxExpressions) fail('cron_compiler_limit_exceeded');
  return expressions.sort();
}

function validateQuota(quota, now) {
  if (!quota || !Array.isArray(quota.periods) || !quota.periods.length || quota.periods.length > 24 ||
    !integer(quota.queuedJobs) || quota.queuedJobs < 0 || !integer(quota.cleanupDelaySeconds) ||
    quota.cleanupDelaySeconds < 0 || quota.cleanupDelaySeconds > MAX_SECONDS) fail('quota_unavailable');
  if (quota.validUntil !== undefined && (!integer(quota.validUntil) || now >= quota.validUntil ||
      quota.validUntil > now + 301)) fail('quota_unavailable');
  let end;
  for (const p of quota.periods) {
    if (!integer(p.start) || !integer(p.end) || p.start >= p.end || !integer(p.usedMinutes) || p.usedMinutes < 0 ||
      (p.providerRemainingMinutes !== null && (!integer(p.providerRemainingMinutes) || p.providerRemainingMinutes < 0)) ||
      typeof p.paidUsageBlocked !== 'boolean' || (end !== undefined && p.start !== end)) fail('invalid_quota');
    end = p.end;
  }
  if (!(quota.periods[0].start <= now && now < quota.periods[0].end) || end - now > MAX_SECONDS) fail('invalid_quota');
  return quota;
}

// A timer dispatch is a paid job exactly like a schedule run; so is each fallback run.
function forecast(expressions, published, quota, now) {
  return quota.periods.map(p => {
    const start = Math.max(now, p.start);
    const runnerJobs = expandCron(expressions, start, p.end).length;
    const fallbackJobs = expandCron([FALLBACK_CRON], start, p.end).length;
    // Conservatively count all old triggers during cleanup, even ones also present in the
    // desired workflow. Queued jobs are additional; neither disappears with a successful PUT.
    // Queue delivery has no upper bound. Charge its possible cost in each supplied
    // period instead of assuming every queued job will start in the current one.
    const pendingJobs = quota.queuedJobs +
      expandCron(published, start, Math.min(p.end, Math.max(start, now + quota.cleanupDelaySeconds))).length;
    return { start: p.start, end: p.end, runnerJobs, fallbackJobs, pendingJobs,
      minutesWithReserve: p.usedMinutes + (runnerJobs + fallbackJobs + pendingJobs) * POLICY.minutesPerJob + POLICY.reserveMinutes,
      providerRemainingMinutes: p.providerRemainingMinutes };
  });
}

function budgetReason(rows, quota) {
  if (quota.periods.some(p => !p.paidUsageBlocked)) return 'paid_usage_protection_required';
  if (rows.some(p => p.minutesWithReserve > POLICY.limitMinutes)) return 'service_quota_insufficient';
  if (rows.some((p, i) => p.providerRemainingMinutes !== null &&
    (p.runnerJobs + p.fallbackJobs + p.pendingJobs) * POLICY.minutesPerJob + POLICY.reserveMinutes > quota.periods[i].providerRemainingMinutes)) {
    return 'provider_quota_insufficient';
  }
  return null;
}

function recoverySchedule(published, quota, now, maxExpressions) {
  if (!quota || quota.periods.some(p => !p.paidUsageBlocked)) return [];
  const base = forecast([], published, quota, now), slots = [];
  for (const [i, p] of quota.periods.entries()) {
    const remaining = Math.min(POLICY.limitMinutes - p.usedMinutes, p.providerRemainingMinutes ?? Infinity) -
      POLICY.reserveMinutes - (base[i].pendingJobs + base[i].fallbackJobs) * POLICY.minutesPerJob;
    const availableJobs = Math.max(0, Math.floor(remaining / POLICY.minutesPerJob));
    slots.push(...expandCron([DISCOVERY_CRON], Math.max(now, p.start), p.end).slice(0, availableJobs));
  }
  try { return compileSlots(slots, { discovery: false, maxExpressions }); }
  catch { return []; } // Explicit paused result; never substitute a permanent frequent cron.
}

export function planSchedule(state, { now, quota, published = [], resume = false, maxExpressions = POLICY.maxExpressions } = {}) {
  validateState(state); if (!integer(now)) fail('invalid_clock'); cap(maxExpressions);
  // Windows are woken only by the external timer; neither it nor GitHub dispatch has an SLA.
  const warnings = ['runner_cost_includes_startup_oauth_publication', 'delivery_has_no_sla', 'windows_need_external_timer'];
  const windows = activeWindows(state, now), slots = windowSlots(windows);
  for (const c of state.cycles.filter(c => c.current && c.hasSchedule && !terminal(c) && c.deltaSeconds !== null && c.deltaSeconds <= 900)) {
    warnings.push(c.deltaSeconds < 300 ? 'short_delta_may_have_no_slot' : 'short_delta_delivery_risk');
    if (firstSlot(Math.max(now, c.scheduledAt, c.nextAttemptAt ?? c.scheduledAt)) >= c.deadline) warnings.push('no_remaining_planned_slot');
  }
  let reason = null, validQuota;
  try { validQuota = validateQuota(quota, now); }
  catch (error) { reason = error.kind; }
  let expressions = [];
  const disabled = state.disabled || state.revoked;
  if (!disabled && !reason) {
    if (windows.some(w => w.end > validQuota.periods.at(-1).end)) reason = 'future_period_quota_required';
    try { expressions = compileSlots(slots, { maxExpressions }); }
    catch (error) { reason ??= error.kind; warnings.push(error.kind); }
    reason ??= budgetReason(forecast(expressions, published, validQuota, now), validQuota);
  }
  if (state.scheduler?.mode === 'paused' && !resume && !disabled) reason = state.scheduler.reason;
  if (reason && !disabled) expressions = recoverySchedule(published, validQuota, now, maxExpressions);
  if (disabled) expressions = [];
  const probe = pendingProbe(state, now);
  if (probe !== null) expressions = compileSlots([probe], { discovery: false, maxExpressions });
  if (reason && validQuota && expressions.length && budgetReason(forecast(expressions, published, validQuota, now), validQuota)) {
    expressions = [];
    warnings.push('recovery_projection_insufficient');
  }
  const rows = validQuota ? forecast(expressions, published, validQuota, now) : [];
  if (validQuota?.periods.some(p => p.providerRemainingMinutes === null)) warnings.push('provider_quota_unknown');
  if (reason && !expressions.length) warnings.push('manual_quota_recovery_required');
  // Only disabling the workflow in GitHub stops the fallback; the planner cannot unpublish it.
  const fallbackOnly = reason && validQuota ? budgetReason(forecast([], [], { ...validQuota, queuedJobs: 0 }, now), validQuota) : null;
  if (fallbackOnly && fallbackOnly !== 'paid_usage_protection_required') warnings.push('fallback_exceeds_quota');
  const dueCycleIds = !disabled && !reason ? state.cycles.filter(c => c.current && c.hasSchedule && !c.disabled && !terminal(c) && cycleArmed(state, c) &&
    now >= c.scheduledAt && now >= (c.nextAttemptAt ?? c.scheduledAt) && now < c.deadline && !c.metadataProblem &&
    !state.reconnectRequested && !state.requests.some(r => r.state === 'unconfirmed') &&
    !state.groups.some(g => c.groupKeys.includes(g.key) && (g.outcome !== 'selected' || g.selectedCreditId !== c.creditId)))
    .map(c => c.cycleId) : [];
  return { mode: disabled || reason ? 'paused' : 'active', reason: disabled ? 'installation_disabled' : reason,
    admittedUntil: !disabled && !reason ? Math.min(validQuota.periods.at(-1).end, validQuota.validUntil ?? Infinity) : null,
    expressions, hash: scheduleHash(expressions), forecast: rows, warnings: [...new Set(warnings)], windows, slots, dueCycleIds };
}

// storage must be the authoritative writer, and workflow implements read()/write({expected,
// expressions, assertCurrent}). 17 serializes the whole stream and dispatches dueCycleIds;
// publishing a schedule or returning those IDs never claims an attempt was sent.
export class SchedulePlanner {
  constructor(store, workflow, { now = () => Math.floor(Date.now() / 1000), maxExpressions = POLICY.maxExpressions,
    checkpoint = async () => {} } = {}) {
    this.store = store; this.workflow = workflow; this.now = now; this.maxExpressions = cap(maxExpressions); this.checkpoint = checkpoint;
  }

  async reconcile({ quota, resume = false } = {}) {
    if (typeof resume !== 'boolean') fail('invalid_resume');
    let published;
    try { published = await this.workflow.read(); }
    catch {
      // Cannot price an unreadable published schedule as zero. Pause before returning,
      // retaining confirmed evidence and requiring manual recovery of the unknown workflow.
      await this.store.update(s => {
        s.scheduler ??= initialScheduler();
        Object.assign(s.scheduler, { mode: 'paused', reason: 'published_schedule_unavailable', admittedUntil: null,
          publication: 'unconfirmed', problem: 'schedule_read_unconfirmed' });
      });
      return { ...(await this.store.read()).scheduler, dueCycleIds: [] };
    }
    const prepared = await this.store.update(s => {
      s.scheduler ??= initialScheduler();
      const plan = planSchedule(s, { now: this.now(), quota, published: published.expressions, resume, maxExpressions: this.maxExpressions });
      Object.assign(s.scheduler, { mode: plan.mode, reason: plan.reason, admittedUntil: plan.admittedUntil,
        desired: { hash: plan.hash, expressions: plan.expressions, sourceVersion: s.version + 1,
          createdAt: this.now(), forecast: plan.forecast, warnings: plan.warnings }, publication: 'pending', problem: null });
      let observedForecast = [];
      try {
        validateQuota(quota, this.now());
        observedForecast = forecast(published.expressions, [], quota, this.now());
      } catch { /* Unknown cost stays explicitly unknown, not a zero-minute projection. */ }
      // An absent plan (first run after Upgrade from a workflow-cron pin) has no proof to keep.
      s.scheduler.observed = published.sha === null ? null : { hash: scheduleHash(published.expressions),
        expressions: published.expressions, sha: published.sha, branch: published.branch, confirmedAt: this.now(), forecast: observedForecast };
      return plan;
    });
    const intent = prepared.state.scheduler.desired;
    await this.checkpoint('afterScheduleIntent', prepared.state);
    const assertCurrent = async () => this.store.inspect(s => {
      if (s.version !== prepared.state.version || s.scheduler?.desired?.hash !== intent.hash) fail('schedule_version_conflict');
    });
    try {
      await assertCurrent();
      // An absent plan is created even when empty: the timer fails closed on a missing file.
      const confirmed = published.sha !== null && published.expressions.length === intent.expressions.length &&
        scheduleHash(published.expressions) === intent.hash ? published :
        await this.workflow.write({ expected: published, expressions: intent.expressions, assertCurrent });
      await this.checkpoint('afterScheduleWrite', prepared.state);
      const { state } = await this.store.update(s => {
        if (s.version !== prepared.state.version || s.scheduler.desired.hash !== intent.hash) fail('schedule_version_conflict');
        if (scheduleHash(confirmed.expressions) !== intent.hash) fail('schedule_write_unconfirmed');
        // The fallback judges the timer only by slots of a plan that has been in effect since then.
        if (s.scheduler.confirmed?.hash !== intent.hash || s.scheduler.planSince === undefined) s.scheduler.planSince = this.now();
        s.scheduler.confirmed = { hash: intent.hash, expressions: confirmed.expressions, sha: confirmed.sha,
          branch: confirmed.branch, confirmedAt: this.now() };
        s.scheduler.observed = { ...s.scheduler.confirmed, forecast: intent.forecast };
        s.scheduler.publication = 'confirmed'; s.scheduler.problem = null;
      });
      return { ...state.scheduler, dueCycleIds: prepared.result.dueCycleIds };
    } catch {
      const { state } = await this.store.update(s => {
        if (s.scheduler?.desired?.sourceVersion === intent.sourceVersion && s.scheduler.desired.hash === intent.hash) {
          s.scheduler.publication = 'unconfirmed'; s.scheduler.problem = 'schedule_write_unconfirmed';
        }
      });
      return { ...state.scheduler, dueCycleIds: [] };
    }
  }
}

// Service check is already charged as outstanding×10 by the common provider.
// The caller supplies the remaining combined plan (all discovery/windows/probes);
// the static fallback runs regardless and is added here for every period.
export function admitObserverQuota(quota, now, futureMinutes) {
  validateQuota(quota, now);
  if (!integer(futureMinutes) || futureMinutes < 0 || quota.queuedJobs !== 0) fail('invalid_quota');
  if (quota.periods.some(p => !p.paidUsageBlocked)) fail('paid_usage_protection_required');
  const future = p => futureMinutes + POLICY.reserveMinutes +
    expandCron([FALLBACK_CRON], Math.max(now, p.start), p.end).length * POLICY.minutesPerJob;
  if (quota.periods.some(p => p.usedMinutes + future(p) > POLICY.limitMinutes)) fail('service_quota_insufficient');
  if (quota.periods.some(p => p.providerRemainingMinutes === null || future(p) > p.providerRemainingMinutes)) fail('provider_quota_insufficient');
}

// The only slot a paused installation publishes: the Worker wakes it with an empty dispatch,
// and that run confirms the timer before enable without any account access.
export function pendingProbe(state, now) {
  const t = state.installation?.timer;
  return state.disabled && !state.revoked && Number.isSafeInteger(t?.probeAt) && t.confirmedAt === null &&
    now < t.probeAt + CADENCE ? t.probeAt : null;
}
// An empty dispatch run that starts after the probe slot, within the fallback's delay tolerance.
export const probeConfirmed = (timer, now) => Number.isSafeInteger(timer?.probeAt) && timer.confirmedAt === null &&
  now >= timer.probeAt && now < timer.probeAt + TIMER_GRACE_SECONDS;

// The fallback cannot see Cloudflare. It compares the last empty dispatch with the latest slot
// the timer should already have woken from the plan in effect; null when nothing is due yet.
export function timerProblem(scheduler, now) {
  const plan = scheduler?.confirmed?.expressions ?? [], since = scheduler?.planSince;
  const end = now - TIMER_GRACE_SECONDS;
  if (!plan.length || !integer(since) || !integer(now) || since >= end) return null;
  const due = expandCron(plan, Math.max(since, end - 2 * 86400), end + 1).at(-1);
  return due !== undefined && !(scheduler.wokenAt >= due) ? 'external_timer_stale' : null;
}
