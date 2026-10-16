import { createHash, randomUUID } from 'node:crypto';
import { StateFailure, integer, identifier } from './state-store.mjs';
import { ConsumeNotSent } from '../account/account.mjs';
import { firstSlot, HORIZON } from '../schedule/schedule-time.mjs';
import { consumeAdmitted, invalidateAdmission, cycleArmed, weeklyGuarded } from '../schedule/schedule-state.mjs';

export const minuteGroup = expiresAt => `minute:${Math.floor(expiresAt / 60)}`;
// Global rules (terminal UI, 14 Oct): a fixed window before expiry; a weekly read at or above
// WEEKLY_WATCH_PERCENT arms a watch window of WEEKLY_WATCH_SECONDS woken by the external timer.
export const BEFORE_EXPIRY_SECONDS = 1800;
export const WEEKLY_WATCH_PERCENT = 99;
export const WEEKLY_WATCH_SECONDS = 3600;
const currentCycle = (s, creditId) => s.cycles.find(c => c.current && c.creditId === creditId);
// A finished rule/manual cycle does not hold its reset: apply-now starts a new manual cycle.
const heldCycle = (s, creditId, now) => {
  const c = currentCycle(s, creditId);
  return c && !(c.trigger !== undefined && c.status !== 'applied' && (terminal(c) || c.hasSchedule && now >= c.deadline)) ? c : null;
};
const uncertain = s => s.requests.some(r => r.state === 'unconfirmed');
const terminal = c => ['applied', 'ended', 'superseded'].includes(c.status);
const fail = kind => { throw new StateFailure(kind); };
const clock = () => Math.floor(Date.now() / 1000);
export const fingerprint = command => createHash('sha256').update(JSON.stringify(
  Object.fromEntries(Object.entries(command).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
const boundGroups = (s, c) => s.groups.filter(g => c.groupKeys.includes(g.key));

function updateGroups(s) {
  for (const g of s.groups) {
    const requests = s.requests.filter(r => r.groupKeys.includes(g.key));
    const applied = requests.find(r => r.state === 'applied');
    const unresolved = requests.find(r => r.state === 'unconfirmed');
    if (applied) { g.outcome = 'applied'; g.selectedCreditId = applied.creditId; }
    else if (unresolved) { g.outcome = 'unconfirmed'; g.selectedCreditId = unresolved.creditId; }
    else {
      const active = s.cycles.filter(c => c.current && !c.disabled && c.groupKeys.includes(g.key) && !terminal(c));
      g.outcome = new Set(active.map(c => c.creditId)).size > 1 ? 'conflict' : 'selected';
    }
  }
}

function bindGroup(s, c, key) {
  if (!c.groupKeys.includes(key)) c.groupKeys.push(key);
  let group = s.groups.find(g => g.key === key);
  if (!group) {
    group = { key, selectedCreditId: c.creditId, outcome: 'selected', creditIds: [] };
    s.groups.push(group);
  }
  if (!group.creditIds.includes(c.creditId)) group.creditIds.push(c.creditId);
  // Late expiry discovery binds ALL historical attempts of this ID, including old cycles.
  for (const previous of s.cycles.filter(row => row.creditId === c.creditId)) {
    if (!previous.groupKeys.includes(key)) previous.groupKeys.push(key);
  }
  for (const request of s.requests.filter(row => row.creditId === c.creditId)) {
    if (!request.groupKeys.includes(key)) request.groupKeys.push(key);
  }
}

function finishExpired(s, now) {
  for (const c of s.cycles.filter(c => c.current && !terminal(c))) {
    if (c.hasSchedule && now >= c.deadline && !s.requests.some(r => r.cycleId === c.cycleId && r.state === 'unconfirmed')) {
      c.status = 'ended';
      c.nextAttemptAt = null;
    }
  }
}

function observe(s, snapshot, now) {
  s.metadataProblem = ['details', 'empty'].includes(snapshot.kind) ? null : `metadata_${snapshot.kind}`;
  for (const c of s.cycles) {
    const row = snapshot.credits.find(row => row.id === c.creditId);
    c.metadataProblem = !row ? c.status === 'applied' ? null : 'selected_id_missing' : row.resetType !== 'codexRateLimits' ? 'reset_type_unverified' :
      row.status !== 'available' ? 'selected_status_unverified' :
        row.expiry.kind === 'unknown' ? 'expiry_unverified' : null;
    if (row?.expiry.kind === 'at') {
      bindGroup(s, c, minuteGroup(row.expiry.unixSeconds));
      c.expiry = { kind: 'at', unixSeconds: Math.min(c.expiry.kind === 'at' ? c.expiry.unixSeconds : Infinity,
        row.expiry.unixSeconds) };
      c.deadline = Math.min(c.deadline, c.expiry.unixSeconds);
    } else if (row?.expiry.kind === 'none' && c.expiry.kind === 'unknown') {
      c.expiry = { kind: 'none' };
    } else if (row?.expiry.kind === 'none' && c.expiry.kind === 'at') {
      c.metadataProblem = 'expiry_changed_unverified';
    }
    // Missing/partial/unknown metadata never erases a previously known expiry or schedule.
    if (c.current && !terminal(c) && c.status !== 'unconfirmed') {
      c.status = !c.hasSchedule ? 'notScheduled' : c.metadataProblem ? 'metadataBlocked' : s.reconnectRequested ? 'reconnectRequired' :
        c.lastResult === 'nothingToReset' ? 'waiting' : 'scheduled';
    }
  }
  updateGroups(s);
  for (const c of s.cycles.filter(c => c.current && !terminal(c) && c.status !== 'unconfirmed')) {
    if (boundGroups(s, c).some(g => g.outcome === 'conflict' || g.selectedCreditId !== c.creditId ||
      ['applied', 'unconfirmed'].includes(g.outcome))) c.status = 'groupConflict';
  }
  finishExpired(s, now);
}

const COMMAND_FIELDS = {
  select: ['creditId', 'deltaSeconds', 'scheduledAt', 'automation', 'acknowledgeDelayRisk', 'attemptUntil'],
  'apply-now': ['creditId'], retry: ['creditId'], disable: ['creditId'], resume: ['creditId'],
  reconnect: [], revoke: [], 'weekly-auto': ['enabled'], 'before-expiry': ['enabled'],
};
function validateCommand(cmd) {
  if (!cmd || Array.isArray(cmd) || !Object.hasOwn(COMMAND_FIELDS, cmd.action) ||
    !identifier(cmd.commandId) || !integer(cmd.expectedVersion) || cmd.expectedVersion < 0 ||
    Object.keys(cmd).some(key => !['action', 'commandId', 'expectedVersion', ...COMMAND_FIELDS[cmd.action]].includes(key)) ||
    (['weekly-auto', 'before-expiry'].includes(cmd.action) && typeof cmd.enabled !== 'boolean') ||
    (cmd.creditId !== undefined && !identifier(cmd.creditId)) ||
    (cmd.deltaSeconds !== undefined && (!integer(cmd.deltaSeconds) || cmd.deltaSeconds <= 0)) ||
    (cmd.scheduledAt !== undefined && !integer(cmd.scheduledAt)) ||
    (cmd.attemptUntil !== undefined && !integer(cmd.attemptUntil)) ||
    (cmd.automation !== undefined && typeof cmd.automation !== 'boolean') ||
    (cmd.acknowledgeDelayRisk !== undefined && typeof cmd.acknowledgeDelayRisk !== 'boolean') ||
    (cmd.deltaSeconds !== undefined && cmd.scheduledAt !== undefined)) fail('invalid_command');
}

function ruleCycle(s, row, { trigger, start, deadline, deltaSeconds }) {
  const key = minuteGroup(row.expiry.unixSeconds);
  const c = { cycleId: randomUUID(), creditId: row.id, expiry: row.expiry, groupKeys: [], scheduledAt: start,
    originalDeadline: row.expiry.unixSeconds, deadline, hourLimited: false, deltaSeconds, status: 'scheduled', current: true,
    disabled: false, hasSchedule: true, nextAttemptAt: start, lastAttemptAt: null, lastResult: null, metadataProblem: null, trigger };
  const group = s.groups.find(g => g.key === key);
  if (group) group.selectedCreditId = row.id;
  s.cycles.push(c); bindGroup(s, c, key);
  return c;
}

// Global rules create cycles only from a complete list, one ID per calendar-minute group, never
// over a success, an unknown outcome or a live cycle of another ID. Explicit choices are kept.
function applyRules(s, snapshot, now, weeklyNow) {
  if (s.disabled || s.revoked || s.reconnectRequested || uncertain(s) || !['details', 'empty'].includes(snapshot.kind)) return;
  const live = c => c.current && !terminal(c) && c.status !== 'unconfirmed';
  const taken = new Set();
  const eligible = snapshot.credits.filter(row => row.status === 'available' && row.resetType === 'codexRateLimits' &&
    row.expiry.kind === 'at' && row.expiry.unixSeconds > now && row.expiry.unixSeconds <= now + HORIZON &&
    !s.cycles.some(c => c.creditId === row.id && c.status === 'applied'))
    .sort((a, b) => a.expiry.unixSeconds - b.expiry.unixSeconds || a.id.localeCompare(b.id))
    .filter(row => {
      const key = minuteGroup(row.expiry.unixSeconds), group = s.groups.find(g => g.key === key);
      if (taken.has(key) || group && (['applied', 'unconfirmed'].includes(group.outcome) ||
          group.selectedCreditId !== row.id && s.cycles.some(c => live(c) && c.creditId === group.selectedCreditId))) return false;
      taken.add(key); return true;
    });
  // An explicit select or manual cycle takes precedence over the weekly rule.
  // A reset kept without automation (select automation:false) is skipped.
  if (s.settings.weeklyAutoReset && weeklyNow && !s.cycles.some(c => live(c) && c.trigger !== 'expiry' && c.hasSchedule && now < c.deadline)) {
    const row = eligible.find(row => !s.cycles.some(c => live(c) && c.creditId === row.id && c.trigger !== 'expiry'));
    if (row) {
      const old = currentCycle(s, row.id);
      if (old) { old.current = false; old.disabled = true; if (!terminal(old)) old.status = 'superseded'; }
      ruleCycle(s, row, { trigger: 'weekly', start: now, deadline: Math.min(row.expiry.unixSeconds, weeklyNow.resetsAt), deltaSeconds: null });
    }
  }
  if (s.settings.beforeExpiry) {
    for (const row of eligible) {
      const old = currentCycle(s, row.id), start = row.expiry.unixSeconds - BEFORE_EXPIRY_SECONDS;
      if (old && !terminal(old) || firstSlot(Math.max(start, now)) >= row.expiry.unixSeconds) continue;
      if (old) old.current = false;
      ruleCycle(s, row, { trigger: 'expiry', start, deadline: row.expiry.unixSeconds, deltaSeconds: BEFORE_EXPIRY_SECONDS });
    }
  }
  updateGroups(s);
}

function watchWeekly(s, snapshot, now) {
  const usage = snapshot.weeklyUsage;
  if (!usage || !s.settings.weeklyAutoReset) return;
  s.weeklyWatchUntil = usage.usedPercent >= WEEKLY_WATCH_PERCENT && usage.usedPercent < 100 && usage.resetsAt > now ?
    Math.min(now + WEEKLY_WATCH_SECONDS, usage.resetsAt) : null;
}

// All timestamps are Unix seconds. AccountAdapter owns response semantics; this module owns
// durable intent, cycle boundaries, manual command identity and restart safety.
export class CycleEngine {
  constructor(store, account, { now = clock, checkpoint = async () => {} } = {}) {
    this.store = store; this.account = account; this.now = now; this.checkpoint = checkpoint;
  }

  time() { const now = this.now(); if (!integer(now)) fail('invalid_clock'); return now; }

  async refresh() {
    const state = await this.store.read();
    if (state.revoked) fail('installation_revoked');
    let snapshot;
    try { snapshot = await this.account.read(); }
    catch { snapshot = { kind: 'unavailable', credits: [] }; }
    const weeklyNow = snapshot.weekly && this.account.weeklyReady?.(snapshot.weekly) === true ? snapshot.weekly : null;
    const { state: fresh } = await this.store.update(s => {
      if (s.revoked) return;
      const now = this.time();
      observe(s, snapshot, now);
      // The monitor lists the latest read; a failed read keeps the previous list.
      if (s.installation && snapshot.kind !== 'unavailable') {
        s.installation.metadata = { kind: snapshot.kind, availableCount: snapshot.availableCount, credits: snapshot.credits };
      }
      watchWeekly(s, snapshot, now);
      applyRules(s, snapshot, now, weeklyNow);
      finishExpired(s, now);
    });
    return this.report(fresh);
  }

  async command(cmd) {
    validateCommand(cmd);
    const digest = fingerprint(cmd);
    // Retry delivery must work even after metadata disappears or the installation is revoked.
    const initial = await this.store.read();
    const prior = initial.commands.find(c => c.commandId === cmd.commandId);
    if (prior) {
      if (prior.fingerprint !== digest) fail('command_id_reused');
      return { ...prior.result, duplicate: true, version: initial.version };
    }
    if (initial.version !== cmd.expectedVersion) fail('version_conflict');
    if (initial.revoked) fail('installation_revoked');
    let snapshot;
    // Apply-now on a reset without a cycle (terminal UI) starts from the stored latest list: a read here
    // would run host auth maintenance and change the version under the command. Without one it reads
    // like select. Eligibility is proven again by the fresh read before any consume.
    const fresh = cmd.action === 'apply-now' && !heldCycle(initial, cmd.creditId, this.time()) &&
      !initial.installation?.metadata?.credits.some(row => row.id === cmd.creditId);
    if (cmd.action === 'select' || fresh) {
      try { snapshot = await this.account.read(); }
      catch { fail('metadata_unavailable'); }
      // An incomplete list cannot prove which expiry is earliest. Reject before any
      // observation, group mutation or command journal entry; explicit visible IDs remain valid.
      if (!cmd.creditId && !['details', 'empty'].includes(snapshot.kind)) fail('auto_select_requires_complete_metadata');
    }
    const { state, result } = await this.store.update(s => {
      const duplicate = s.commands.find(c => c.commandId === cmd.commandId);
      if (duplicate) {
        if (duplicate.fingerprint !== digest) fail('command_id_reused');
        return { ...duplicate.result, duplicate: true };
      }
      if (s.version !== cmd.expectedVersion) fail('version_conflict');
      if (s.revoked) fail('installation_revoked');
      const now = this.time();
      let cycleId = null;
      if (cmd.action === 'select') {
        if (uncertain(s)) fail('outcome_unconfirmed');
        observe(s, snapshot, now);
        const row = cmd.creditId ? snapshot.credits.find(row => row.id === cmd.creditId) :
          snapshot.credits.filter(row => row.status === 'available' && row.resetType === 'codexRateLimits' &&
            row.expiry.kind === 'at' && row.expiry.unixSeconds > now &&
            !s.groups.some(g => g.key === minuteGroup(row.expiry.unixSeconds) &&
              (g.selectedCreditId !== row.id || ['applied', 'unconfirmed'].includes(g.outcome))))
            .sort((a, b) => a.expiry.unixSeconds - b.expiry.unixSeconds || a.id.localeCompare(b.id))[0];
        if (!row || row.resetType !== 'codexRateLimits' || row.status !== 'available') fail('selected_credit_not_eligible');
        const old = currentCycle(s, row.id);
        if (s.cycles.some(c => c.creditId === row.id && c.status === 'applied')) fail('credit_already_applied');
        const remembered = old?.expiry.kind === 'at' ? old.expiry : row.expiry;
        const effectiveExpiry = row.expiry.kind === 'at' && remembered.kind === 'at' ?
          { kind: 'at', unixSeconds: Math.min(row.expiry.unixSeconds, remembered.unixSeconds) } : remembered;
        if (effectiveExpiry.kind === 'at' && effectiveExpiry.unixSeconds <= now) fail('credit_expired');
        const hourLimited = effectiveExpiry.kind !== 'at';
        if (hourLimited && cmd.deltaSeconds !== undefined) fail('expiry_required_for_delta');
        if (hourLimited && cmd.scheduledAt === undefined && cmd.automation !== false) fail('chosen_start_required');
        const delta = hourLimited ? null : cmd.deltaSeconds ??
          (cmd.scheduledAt === undefined ? s.settings.deltaSeconds : effectiveExpiry.unixSeconds - cmd.scheduledAt);
        if (delta !== null && delta <= 0) fail('start_at_or_after_expiry');
        const start = cmd.scheduledAt ?? (hourLimited ? now : effectiveExpiry.unixSeconds - delta);
        if ((cmd.scheduledAt !== undefined || cmd.automation !== false) && start > now + HORIZON || cmd.automation !== false && effectiveExpiry.kind === 'at' &&
          effectiveExpiry.unixSeconds > now + HORIZON) fail('schedule_horizon_exceeded');
        const originalDeadline = hourLimited ? start + 3600 : effectiveExpiry.unixSeconds;
        const deadline = cmd.attemptUntil ?? originalDeadline;
        if (cmd.attemptUntil !== undefined && (deadline <= Math.max(start, now) || deadline > originalDeadline)) fail('invalid_attempt_window');
        if (cmd.automation !== false) {
          const end = deadline;
          if (firstSlot(Math.max(start, now)) >= end) fail('no_planned_slot_use_apply_now');
          if (delta !== null && delta >= 300 && delta <= 900 && cmd.acknowledgeDelayRisk !== true) fail('schedule_delay_risk_ack_required');
        }
        const keys = [...new Set(s.cycles.filter(c => c.creditId === row.id).flatMap(c => c.groupKeys))];
        if (effectiveExpiry.kind === 'at') keys.push(minuteGroup(effectiveExpiry.unixSeconds));
        for (const key of new Set(keys)) {
          const group = s.groups.find(g => g.key === key);
          if (group && ['applied', 'unconfirmed'].includes(group.outcome)) fail('group_locked');
          // Explicit selection is the sole way to replace a confirmed non-applied choice.
          for (const c of s.cycles.filter(c => c.current && c.groupKeys.includes(key))) {
            c.disabled = true; c.current = false; c.status = 'superseded';
          }
          if (group) group.selectedCreditId = row.id;
        }
        if (old) { old.current = false; old.disabled = true; old.status = 'superseded'; }
        const c = { cycleId: randomUUID(), creditId: row.id, expiry: effectiveExpiry, groupKeys: [],
          scheduledAt: start, originalDeadline,
          deadline, hourLimited, deltaSeconds: delta,
          status: cmd.automation === false ? 'notScheduled' : 'scheduled', current: true,
          disabled: cmd.automation === false, hasSchedule: cmd.automation !== false, nextAttemptAt: start,
          lastAttemptAt: null, lastResult: null, metadataProblem: row.expiry.kind === 'unknown' ? 'expiry_unverified' : null };
        s.cycles.push(c);
        for (const key of new Set(keys)) bindGroup(s, c, key);
        cycleId = c.cycleId;
      } else if (cmd.action === 'weekly-auto') {
        s.settings.weeklyAutoReset = cmd.enabled;
        if (!cmd.enabled) s.weeklyWatchUntil = null;
      } else if (cmd.action === 'before-expiry') {
        s.settings.beforeExpiry = cmd.enabled;
      } else if (cmd.action === 'apply-now' && !heldCycle(s, cmd.creditId, now)) {
        const source = snapshot ?? s.installation?.metadata;
        if (!source) fail('version_conflict'); // The stored list or cycle changed between the reads.
        if (uncertain(s)) fail('outcome_unconfirmed');
        if (s.disabled) fail('installation_paused');
        if (snapshot) observe(s, snapshot, now);
        const row = source.credits.find(row => row.id === cmd.creditId);
        if (!row || row.resetType !== 'codexRateLimits' || row.status !== 'available') fail('selected_credit_not_eligible');
        if (s.cycles.some(c => c.creditId === row.id && c.status === 'applied')) fail('credit_already_applied');
        if (row.expiry.kind === 'at' && row.expiry.unixSeconds <= now) fail('credit_expired');
        if (row.expiry.kind === 'at' && row.expiry.unixSeconds > now + HORIZON) fail('schedule_horizon_exceeded');
        const hourLimited = row.expiry.kind !== 'at', deadline = hourLimited ? now + 3600 : row.expiry.unixSeconds;
        const old = currentCycle(s, row.id);
        if (old) { old.current = false; if (!terminal(old)) { old.disabled = true; old.status = 'superseded'; } }
        const keys = row.expiry.kind === 'at' ? [minuteGroup(row.expiry.unixSeconds)] : [];
        for (const key of keys) {
          const group = s.groups.find(g => g.key === key);
          if (group && ['applied', 'unconfirmed'].includes(group.outcome)) fail('group_locked');
          // An explicit manual choice replaces the group's other live cycle, as select does.
          for (const c of s.cycles.filter(c => c.current && c.groupKeys.includes(key))) {
            c.disabled = true; c.current = false; c.status = 'superseded';
          }
          if (group) group.selectedCreditId = row.id;
        }
        const c = { cycleId: randomUUID(), creditId: row.id, expiry: row.expiry, groupKeys: [], scheduledAt: now,
          originalDeadline: deadline, deadline, hourLimited, deltaSeconds: null, status: 'scheduled', current: true,
          disabled: false, hasSchedule: true, nextAttemptAt: now, lastAttemptAt: null, lastResult: null,
          metadataProblem: row.expiry.kind === 'unknown' ? 'expiry_unverified' : null, trigger: 'manual' };
        s.cycles.push(c);
        for (const key of keys) bindGroup(s, c, key);
        cycleId = c.cycleId;
      } else if (['apply-now', 'retry'].includes(cmd.action)) {
        const c = currentCycle(s, cmd.creditId);
        if (!c) fail('selected_cycle_missing');
        if (uncertain(s)) fail('outcome_unconfirmed');
        if (s.disabled) fail('installation_paused');
        if (c.status === 'applied' || boundGroups(s, c).some(g => g.outcome === 'applied')) fail('group_locked');
        if (boundGroups(s, c).some(g => g.selectedCreditId !== c.creditId || g.outcome === 'conflict')) fail('group_conflict');
        const isRetry = cmd.action === 'retry';
        if (isRetry && (!c.hasSchedule || !c.hourLimited || now < c.deadline)) fail('retry_requires_ended_hour');
        if (c.expiry.kind === 'at' && c.expiry.unixSeconds <= now) fail('credit_expired');
        if (c.expiry.kind === 'at' && c.expiry.unixSeconds > now + HORIZON) fail('schedule_horizon_exceeded');
        // Both explicit actions replace the schedule; only retry may restart an ended hour.
        // Metadata/error/reconnect/resume never enter this path or extend a boundary.
        const hourLimited = isRetry || c.hourLimited;
        const originalDeadline = hourLimited ? now + 3600 : c.originalDeadline;
        if (!isRetry && c.hasSchedule && now >= c.deadline) fail('cycle_ended_use_retry');
        c.current = false;
        const next = { ...c, cycleId: randomUUID(), current: true, disabled: false, hasSchedule: true, scheduledAt: now,
          originalDeadline, deadline: Math.min(!isRetry && c.deadline < c.originalDeadline ? c.deadline : originalDeadline, c.expiry.kind === 'at' ? c.expiry.unixSeconds : Infinity),
          hourLimited, status: 'scheduled', nextAttemptAt: now, lastAttemptAt: null, lastResult: null, trigger: 'manual' };
        c.status = 'superseded'; c.disabled = true;
        s.cycles.push(next);
        cycleId = next.cycleId;
      } else if (['disable', 'resume'].includes(cmd.action)) {
        if (cmd.creditId) {
          const c = currentCycle(s, cmd.creditId);
          if (!c) fail('selected_cycle_missing');
          c.disabled = cmd.action === 'disable'; cycleId = c.cycleId;
        } else s.disabled = cmd.action === 'disable';
      } else if (cmd.action === 'reconnect') {
        s.reconnectRequested = true;
        if (s.installation) { s.installation.seedSession = null; s.installation.checkedSession = null; }
      } else if (cmd.action === 'revoke') {
        s.revoked = true; s.disabled = true;
        if (s.installation) { s.installation.seedSession = null; s.installation.checkedSession = null; }
      }
      if (['select', 'apply-now', 'retry', 'resume', 'weekly-auto', 'before-expiry'].includes(cmd.action)) invalidateAdmission(s);
      updateGroups(s);
      finishExpired(s, now);
      const accepted = { state: 'accepted', action: cmd.action, cycleId };
      s.commands.push({ commandId: cmd.commandId, fingerprint: digest, expectedVersion: cmd.expectedVersion,
        acceptedAt: now, result: accepted });
      return accepted;
    });
    return { ...result, version: state.version };
  }

  async reconnect() {
    const initial = await this.store.read();
    if (initial.revoked) fail('installation_revoked');
    if (!initial.reconnectRequested) return this.report(initial);
    let snapshot;
    try { snapshot = await this.account.reconnect(); }
    catch { return this.report((await this.store.update(s => {
      if (!s.revoked) {
        s.metadataProblem = 'reconnect_required';
        for (const c of s.cycles.filter(c => c.current && !terminal(c) && c.status !== 'unconfirmed')) c.status = 'reconnectRequired';
        finishExpired(s, this.time());
      }
    })).state); }
    const { state } = await this.store.update(s => {
      if (!s.revoked) { s.reconnectRequested = false; observe(s, snapshot, this.time()); }
    });
    return this.report(state);
  }

  async run(creditId) {
    let { state } = await this.store.update(s => finishExpired(s, this.time()));
    if (state.revoked || state.disabled || state.reconnectRequested || uncertain(state) || !consumeAdmitted(state, this.time())) return this.report(state);
    // Each cycle follows its own rule; the weekly option still gates selected cycles before any read.
    const due = s => s.cycles.filter(c => c.current && c.hasSchedule && !c.disabled && !terminal(c) && cycleArmed(s, c) &&
      (!weeklyGuarded(c) || s.settings.weeklyAutoReset) &&
      (!creditId || c.creditId === creditId) && this.time() >= c.scheduledAt &&
      this.time() >= (c.nextAttemptAt ?? c.scheduledAt) && this.time() < c.deadline &&
      !boundGroups(s, c).some(g => g.outcome !== 'selected' || g.selectedCreditId !== c.creditId));
    if (!due(state).length) return this.report(state);
    await this.refresh();
    const weekly = this.account.snapshot?.weekly;
    const reserve = () => this.store.update(s => {
      finishExpired(s, this.time());
      if (s.revoked || s.disabled || s.reconnectRequested || uncertain(s) || !consumeAdmitted(s, this.time())) return null;
      const c = due(s).find(c => !c.metadataProblem && (!weeklyGuarded(c) || this.account.weeklyReady?.(weekly)));
      if (!c) return null;
      const now = this.time();
      const request = { requestId: randomUUID(), cycleId: c.cycleId, creditId: c.creditId,
        groupKeys: [...c.groupKeys], idempotencyKey: randomUUID(), attemptAt: now,
        nextAttemptAt: now + 300, state: 'unconfirmed', reason: 'reserved_outcome_unconfirmed', finishedAt: null };
      s.requests.push(request);
      c.status = 'unconfirmed'; c.lastAttemptAt = now; c.lastResult = 'unconfirmed'; c.nextAttemptAt = request.nextAttemptAt;
      updateGroups(s);
      return request;
    });
    const reservation = this.account.reserveConsume ? await this.account.reserveConsume(reserve) : await reserve();
    const request = reservation.result;
    if (!request) return this.report(reservation.state);
    const guarded = weeklyGuarded(reservation.state.cycles.find(c => c.cycleId === request.cycleId));
    await this.checkpoint('afterReserve', request);
    let sent = false;
    let blocked = null;
    let response;
    try {
      response = await this.account.consume(request, { refreshAfter: false, requireWeekly: guarded, dispatch: async (send, context) => {
        // The store holds writer serialization until send() synchronously begins the RPC.
        // Do not await the network while holding the writer: manual disable/revoke may proceed.
        // AccountAdapter passes a pre-send validation function; HostAccountAdapter passes
        // the reservation proof context object. Both shapes guard the same final send.
        const validate = typeof context === 'function' ? context : null;
        const proof = validate ? undefined : context;
        let delivery;
        try { delivery = await this.store.inspect(s => {
          const c = s.cycles.find(c => c.cycleId === request.cycleId);
          const base = reservation.state.version;
          const ownVersions = proof === undefined || proof.baseVersion === base &&
            [0, 3].includes(proof.authVersions.length) && proof.expectedVersion === base + proof.authVersions.length &&
            proof.authVersions.every((v, i) => v === base + i + 1);
          const journal = s.requests.find(r => r.requestId === request.requestId);
          blocked = !ownVersions || s.version !== (proof?.expectedVersion ?? base) ? 'version_conflict' :
            !journal || journal.state !== 'unconfirmed' || journal.creditId !== request.creditId ||
              journal.idempotencyKey !== request.idempotencyKey || !c || !c.current ? 'reservation_changed' :
            s.revoked ? 'installation_revoked' : s.disabled || c.disabled ? 'disabled' :
              !cycleArmed(s, c) ? 'rule_disabled' :
              guarded && !s.settings.weeklyAutoReset ? 'weekly_option_disabled' :
              guarded && !this.account.weeklyReady?.(weekly) ? 'weekly_exhaustion_unconfirmed' :
              !consumeAdmitted(s, this.time()) ? 'quota_not_admitted' :
              this.time() >= c.deadline ? 'deadline_reached' :
                boundGroups(s, c).some(g => g.outcome !== 'unconfirmed' || g.selectedCreditId !== c.creditId) ? 'group_conflict' : null;
          if (blocked) return {};
          if (validate) validate();
          sent = true;
          const pending = Promise.resolve(send());
          // Attach rejection handling before releasing the file lock (which awaits filesystem IO).
          pending.catch(() => {});
          return { pending };
        }); } catch (error) {
          if (!sent) throw new ConsumeNotSent();
          throw error;
        }
        if (blocked) throw new ConsumeNotSent();
        return delivery.pending;
      } });
    } catch (error) {
      // A pre-dispatch ConsumeNotSent from the adapter means the weekly evidence lapsed
      // between the reservation and the send; keep the durable reason specific.
      if (error instanceof ConsumeNotSent && !blocked && guarded && !this.account.weeklyReady?.(weekly)) blocked = 'weekly_exhaustion_unconfirmed';
      response = { state: 'unconfirmed', reason: 'transport_failure' };
    }
    await this.checkpoint('afterRpc', request);
    if (!sent) response = { state: 'notSent', reason: blocked ?? 'selected_credit_not_eligible' };
    else if (response.creditId !== request.creditId || response.idempotencyKey !== request.idempotencyKey ||
      !['applied', 'nothingToReset', 'noCredit', 'unconfirmed'].includes(response.state)) {
      response = { state: 'unconfirmed', reason: 'response_identity_unverified' };
    }
    const completed = await this.store.update(s => {
      const r = s.requests.find(r => r.requestId === request.requestId);
      const c = s.cycles.find(c => c.cycleId === request.cycleId);
      r.state = response.state;
      // Never copy backend error bodies or arbitrary adapter diagnostics to durable state.
      r.reason = r.state === 'unconfirmed' ? 'outcome_unconfirmed' : r.state === 'notSent' ? blocked ?? 'not_sent' : null;
      r.finishedAt = this.time();
      c.lastResult = r.state;
      c.status = r.state === 'applied' ? 'applied' : r.state === 'unconfirmed' ? 'unconfirmed' :
        r.state === 'nothingToReset' ? 'waiting' : 'metadataBlocked';
      if (r.state === 'applied') c.nextAttemptAt = null;
      updateGroups(s);
      finishExpired(s, this.time());
    });
    // Persist success BEFORE best-effort metadata refresh and schedule cleanup by planner 16.
    if (response.state === 'applied' && !completed.state.revoked) return this.refresh();
    return this.report(completed.state);
  }

  report(s) {
    const now = this.time();
    return { schemaVersion: s.schemaVersion, version: s.version, language: s.settings.language,
      weeklyAutoReset: s.settings.weeklyAutoReset, beforeExpiry: s.settings.beforeExpiry,
      weeklyWatchUntil: s.weeklyWatchUntil ?? null,
      weeklyReady: this.account.weeklyReady?.() === true,
      disabled: s.disabled, revoked: s.revoked, reconnectRequested: s.reconnectRequested,
      metadataProblem: s.metadataProblem, outcomeUnconfirmed: uncertain(s), groups: s.groups,
      scheduler: s.scheduler ?? null,
      commands: s.commands.map(c => ({ commandId: c.commandId, ...c.result })),
      cycles: s.cycles.filter(c => c.current).map(c => {
        const groupBlocked = boundGroups(s, c).some(g => g.outcome !== 'selected' || g.selectedCreditId !== c.creditId);
        return { ...c,
          scheduledAt: c.hasSchedule ? c.scheduledAt : null,
          originalDeadline: c.hasSchedule ? c.originalDeadline : null,
          deadline: c.hasSchedule ? c.deadline : null,
          status: ['unconfirmed', 'applied'].includes(c.status) ? c.status : !c.hasSchedule ? 'notScheduled' :
            now >= c.deadline ? 'ended' : groupBlocked ? 'groupConflict' : c.status,
          trigger: c.trigger ?? 'select', armed: cycleArmed(s, c),
          nextAttemptAt: cycleArmed(s, c) && (!weeklyGuarded(c) || s.settings.weeklyAutoReset) && c.hasSchedule && !terminal(c) && !c.disabled && !s.disabled && !s.revoked && !s.reconnectRequested &&
            !uncertain(s) && consumeAdmitted(s, now) && !c.metadataProblem && !groupBlocked &&
            Math.max(c.nextAttemptAt ?? c.scheduledAt, now) < c.deadline ? c.nextAttemptAt : null,
          scheduledDelaySeconds: !c.hasSchedule ? 0 : c.lastAttemptAt === null ? Math.max(0, now - c.scheduledAt) :
            Math.max(0, c.lastAttemptAt - c.scheduledAt),
          executionProblem: !c.hasSchedule || ['applied', 'superseded'].includes(c.status) ? null :
            now >= c.deadline && c.lastAttemptAt === null ? 'attempt_window_missed' :
              now < c.deadline && now >= firstSlot(c.nextAttemptAt ?? c.scheduledAt) + 300 ? 'attempt_delayed_or_missed' : null,
          retryAvailable: c.hasSchedule && !s.revoked && !s.disabled && !groupBlocked && c.hourLimited &&
            now >= c.deadline && !uncertain(s) && c.status !== 'applied' &&
            (c.expiry.kind !== 'at' || c.expiry.unixSeconds > now),
        };
      }) };
  }

  async status() { return this.report(await this.store.read()); }
}
