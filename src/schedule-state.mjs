import { createHash } from 'node:crypto';

export const scheduleHash = expressions => createHash('sha256').update(JSON.stringify(expressions)).digest('hex');
export const initialScheduler = () => ({ mode: 'needsAdmission', reason: 'quota_admission_required', admittedUntil: null,
  desired: null, confirmed: null, observed: null, publication: 'pending', problem: null });
export const consumeAdmitted = (s, now) => s.scheduler === undefined ||
  s.scheduler.mode === 'active' && now < s.scheduler.admittedUntil;
export function invalidateAdmission(s) {
  if (s.scheduler && s.scheduler.mode !== 'paused') {
    s.scheduler.mode = 'needsAdmission'; s.scheduler.reason = 'quota_admission_required'; s.scheduler.admittedUntil = null;
  }
}
// Global rules (terminal UI, 14 Oct). A rule-created cycle is armed only while its rule is on;
// manual and explicitly selected cycles always are. Only the weekly rule and an explicit
// select keep the weekly-exhaustion guard; the expiry rule and a manual apply-now do not.
export const cycleArmed = (s, c) => c.trigger === 'expiry' ? s.settings.beforeExpiry :
  c.trigger === 'weekly' ? s.settings.weeklyAutoReset : true;
export const weeklyGuarded = c => c.trigger === undefined || c.trigger === 'weekly';
// Watch window armed by a weekly read at or above WEEKLY_WATCH_PERCENT: the timer wakes reads
// so exhaustion is seen within one slot instead of the next discovery.
export const watchWindow = (s, now) => s.settings.weeklyAutoReset && Number.isSafeInteger(s.weeklyWatchUntil) &&
  s.weeklyWatchUntil > now ? { start: now, end: s.weeklyWatchUntil } : null;
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v, keys) => obj(v) && Object.keys(v).every(k => keys.includes(k));
const time = v => v === null || Number.isSafeInteger(v);
const code = v => v === null || typeof v === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const expressions = v => Array.isArray(v) && v.length <= 4096 && new Set(v).size === v.length &&
  v.every(x => typeof x === 'string' && /^[0-9,* ]{9,256}$/.test(x));
// fallbackJobs (ticket 37) is absent in forecasts written by earlier pins.
const validForecast = rows => Array.isArray(rows) && rows.length <= 24 && rows.every(p => only(p,
  ['start', 'end', 'runnerJobs', 'fallbackJobs', 'pendingJobs', 'minutesWithReserve', 'providerRemainingMinutes']) &&
  ['start', 'end', 'runnerJobs', 'pendingJobs', 'minutesWithReserve'].every(k => Number.isSafeInteger(p[k])) &&
  (p.fallbackJobs === undefined || Number.isSafeInteger(p.fallbackJobs) && p.fallbackJobs >= 0) &&
  p.start < p.end && ['runnerJobs', 'pendingJobs', 'minutesWithReserve'].every(k => p[k] >= 0) &&
  (p.providerRemainingMinutes === null || Number.isSafeInteger(p.providerRemainingMinutes) && p.providerRemainingMinutes >= 0));
const validProof = v => hash(v.hash) && expressions(v.expressions) && v.hash === scheduleHash(v.expressions) &&
  typeof v.sha === 'string' && /^[a-f0-9]{40,64}$/.test(v.sha) &&
  typeof v.branch === 'string' && v.branch.length > 0 && v.branch.length <= 256 && Number.isSafeInteger(v.confirmedAt);
// Optional timer evidence (ticket 37): planSince — when the confirmed plan took effect;
// wokenAt — start of the last empty workflow_dispatch run.
export function validScheduler(v) {
  if (!only(v, ['mode', 'reason', 'admittedUntil', 'desired', 'confirmed', 'observed', 'publication', 'problem', 'planSince', 'wokenAt']) ||
    !['needsAdmission', 'active', 'paused'].includes(v.mode) || !code(v.reason) || !time(v.admittedUntil) ||
    ['planSince', 'wokenAt'].some(k => v[k] !== undefined && !Number.isSafeInteger(v[k])) ||
    (v.mode === 'active' && v.admittedUntil === null) ||
    !['pending', 'confirmed', 'unconfirmed'].includes(v.publication) || !code(v.problem)) return false;
  if (v.desired !== null && (!only(v.desired, ['hash', 'expressions', 'sourceVersion', 'createdAt', 'forecast', 'warnings']) ||
    !hash(v.desired.hash) || !expressions(v.desired.expressions) || v.desired.hash !== scheduleHash(v.desired.expressions) ||
    !Number.isSafeInteger(v.desired.sourceVersion) || v.desired.sourceVersion < 0 || !Number.isSafeInteger(v.desired.createdAt) ||
    !validForecast(v.desired.forecast) ||
    !Array.isArray(v.desired.warnings) || !v.desired.warnings.every(w => w !== null && code(w)))) return false;
  if (v.confirmed !== null && (!only(v.confirmed, ['hash', 'expressions', 'sha', 'branch', 'confirmedAt']) ||
    !validProof(v.confirmed))) return false;
  if (v.observed !== null && (!only(v.observed, ['hash', 'expressions', 'sha', 'branch', 'confirmedAt', 'forecast']) ||
    !validProof(v.observed) || !validForecast(v.observed.forecast))) return false;
  return v.publication !== 'confirmed' || v.desired !== null && v.confirmed !== null && v.desired.hash === v.confirmed.hash;
}
