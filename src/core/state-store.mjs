import { validInstallation } from './installation-state.mjs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { validateAuth } from '../session/auth-bundle.mjs';
import { validScheduler } from '../schedule/schedule-state.mjs';
import { StateFailure, integer } from './state-failure.mjs';

export { StateFailure, integer };
export const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const expiry = value => only(value, ['kind', 'unixSeconds']) &&
  (['none', 'unknown'].includes(value.kind) && value.unixSeconds === undefined ||
    value.kind === 'at' && integer(value.unixSeconds));
const optionalTime = value => value === null || integer(value);
const unique = rows => new Set(rows).size === rows.length;
export const CYCLE_STATUSES = ['notScheduled', 'scheduled', 'waiting', 'unconfirmed', 'applied', 'ended', 'superseded',
  'metadataBlocked', 'reconnectRequired', 'groupConflict'];
// Absent trigger: an explicit select (weekly guard applies). Rule-created and manual cycles name their source.
export const CYCLE_TRIGGERS = ['expiry', 'weekly', 'manual'];

export function initialState(language = 'ru') {
  if (!['ru', 'en'].includes(language)) throw new StateFailure('invalid_language');
  return { schemaVersion: 1, version: 0, settings: { language, deltaSeconds: 3600, weeklyAutoReset: false, beforeExpiry: false }, disabled: false,
    revoked: false, reconnectRequested: false, metadataProblem: null, cycles: [], groups: [], requests: [], commands: [] };
}

// v0 is the pre-command-journal layout. All consume/group history is retained.
export function migrateState(value) {
  if (value?.schemaVersion === 0 && !Object.hasOwn(value, 'commands')) {
    value = { ...value, schemaVersion: 1, commands: [] };
  }
  if (value?.schemaVersion !== 1) throw new StateFailure('incompatible_state');
  if (object(value.settings) && !Object.hasOwn(value.settings, 'weeklyAutoReset')) {
    value = { ...value, settings: { ...value.settings, weeklyAutoReset: false } };
  }
  // Global rules (terminal UI, 14 Oct): migration never turns the expiry rule on.
  if (object(value.settings) && !Object.hasOwn(value.settings, 'beforeExpiry')) {
    value = { ...value, settings: { ...value.settings, beforeExpiry: false } };
  }
  validateState(value);
  return value;
}

export function validateState(s) {
  const fail = () => { throw new StateFailure('invalid_state'); };
  if (!only(s, ['schemaVersion', 'version', 'settings', 'disabled', 'revoked', 'reconnectRequested',
    'metadataProblem', 'cycles', 'groups', 'requests', 'commands', 'auth', 'scheduler', 'installation', 'weeklyWatchUntil']) || s.schemaVersion !== 1 ||
    !integer(s.version) || s.version < 0 || !only(s.settings, ['language', 'deltaSeconds', 'weeklyAutoReset', 'beforeExpiry']) ||
    !['weeklyAutoReset', 'beforeExpiry'].every(key => typeof s.settings[key] === 'boolean') ||
    !(s.weeklyWatchUntil === undefined || optionalTime(s.weeklyWatchUntil)) ||
    !['ru', 'en'].includes(s.settings.language) || !integer(s.settings.deltaSeconds) || s.settings.deltaSeconds <= 0 ||
    !['disabled', 'revoked', 'reconnectRequested'].every(key => typeof s[key] === 'boolean') ||
    !(s.metadataProblem === null || identifier(s.metadataProblem)) ||
    !['cycles', 'groups', 'requests', 'commands'].every(key => Array.isArray(s[key]))) fail();
  if (s.installation !== undefined && !validInstallation(s.installation)) fail();
  if (s.auth !== undefined) {
    try { validateAuth(s.auth); } catch { fail(); }
  }
  if (s.scheduler !== undefined && !validScheduler(s.scheduler)) fail();
  for (const c of s.cycles) {
    if (!only(c, ['cycleId', 'creditId', 'expiry', 'groupKeys', 'scheduledAt', 'originalDeadline', 'deadline',
      'hourLimited', 'deltaSeconds', 'status', 'current', 'disabled', 'hasSchedule', 'nextAttemptAt', 'lastAttemptAt',
      'lastResult', 'metadataProblem', 'trigger']) || !(c.trigger === undefined || CYCLE_TRIGGERS.includes(c.trigger)) || !identifier(c.cycleId) || !identifier(c.creditId) || !expiry(c.expiry) ||
      !Array.isArray(c.groupKeys) || !c.groupKeys.every(identifier) || !unique(c.groupKeys) ||
      !integer(c.scheduledAt) || !integer(c.originalDeadline) || !integer(c.deadline) ||
      c.deadline > c.originalDeadline || !optionalTime(c.deltaSeconds) ||
      !['current', 'disabled', 'hourLimited', 'hasSchedule'].every(key => typeof c[key] === 'boolean') ||
      !CYCLE_STATUSES.includes(c.status) || !optionalTime(c.nextAttemptAt) || !optionalTime(c.lastAttemptAt) ||
      !(c.lastResult === null || identifier(c.lastResult)) || !(c.metadataProblem === null || identifier(c.metadataProblem))) fail();
  }
  for (const g of s.groups) {
    if (!only(g, ['key', 'selectedCreditId', 'outcome', 'creditIds']) || !identifier(g.key) ||
      !identifier(g.selectedCreditId) || !['selected', 'unconfirmed', 'applied', 'conflict'].includes(g.outcome) ||
      !Array.isArray(g.creditIds) || !g.creditIds.every(identifier) || !unique(g.creditIds) || !g.creditIds.includes(g.selectedCreditId)) fail();
  }
  for (const r of s.requests) {
    if (!only(r, ['requestId', 'cycleId', 'creditId', 'groupKeys', 'idempotencyKey', 'attemptAt', 'nextAttemptAt',
      'state', 'reason', 'finishedAt']) || !['requestId', 'cycleId', 'creditId', 'idempotencyKey'].every(key => identifier(r[key])) ||
      !Array.isArray(r.groupKeys) || !r.groupKeys.every(identifier) || !unique(r.groupKeys) || !integer(r.attemptAt) ||
      r.nextAttemptAt !== r.attemptAt + 300 || !optionalTime(r.finishedAt) ||
      !['unconfirmed', 'applied', 'nothingToReset', 'noCredit', 'notSent'].includes(r.state) ||
      !(r.reason === null || identifier(r.reason))) fail();
    const cycle = s.cycles.find(c => c.cycleId === r.cycleId);
    if (!cycle || cycle.creditId !== r.creditId || r.groupKeys.some(key => !cycle.groupKeys.includes(key)) ||
      r.state !== 'unconfirmed' && r.finishedAt === null) fail();
  }
  for (const cmd of s.commands) {
    if (!only(cmd, ['commandId', 'fingerprint', 'expectedVersion', 'acceptedAt', 'result']) ||
      !identifier(cmd.commandId) || !/^[a-f0-9]{64}$/.test(cmd.fingerprint) || !integer(cmd.expectedVersion) ||
      !integer(cmd.acceptedAt) || !only(cmd.result, ['state', 'action', 'cycleId']) ||
      !identifier(cmd.result.state) || !identifier(cmd.result.action) ||
      !(cmd.result.cycleId === null || identifier(cmd.result.cycleId))) fail();
  }
  if (!unique(s.cycles.map(c => c.cycleId)) || !unique(s.cycles.filter(c => c.current).map(c => c.creditId)) ||
      !unique(s.groups.map(g => g.key)) || !unique(s.requests.map(r => r.requestId)) ||
      !unique(s.requests.map(r => r.idempotencyKey)) || !unique(s.commands.map(c => c.commandId))) fail();
  for (const c of s.cycles) {
    if (c.status === 'applied' && !s.requests.some(r => r.cycleId === c.cycleId && r.state === 'applied')) fail();
    if (c.expiry.kind === 'at' && c.deadline > c.expiry.unixSeconds) fail();
    if (c.hourLimited && c.originalDeadline !== c.scheduledAt + 3600) fail();
    if (c.groupKeys.some(key => !s.groups.some(g => g.key === key && g.creditIds.includes(c.creditId)))) fail();
  }
}

// Local boundary for 14. Private CI must implement the same inspect/update contract against
// its durable authoritative state after writer serialization (15/17), never a checkout snapshot.
export class FileStateStore {
  constructor(path) { this.path = path; this.lockPath = `${path}.lock`; }

  async locked(fn) {
    await mkdir(dirname(this.path), { recursive: true });
    try { await mkdir(this.lockPath, { mode: 0o700 }); }
    catch (error) { throw new StateFailure(error.code === 'EEXIST' ? 'state_busy' : 'persistence_failed'); }
    try {
      await writeLockOwner(this.lockPath);
      return await fn();
    }
    finally { await rm(this.lockPath, { recursive: true, force: true }); }
  }

  // Recovery itself requires one serialized operator (the CI writer in 17). Never break a
  // live/remote/ownerless lock or guess from elapsed time; PID reuse safely leaves it blocked.
  async recoverInterruptedWriter({ expectedPid, serialized = false } = {}) {
    if (!serialized || !integer(expectedPid) || expectedPid <= 0) throw new StateFailure('serialized_recovery_required');
    let owner;
    try { owner = JSON.parse(await readFile(`${this.lockPath}/owner.json`, 'utf8')); }
    catch { throw new StateFailure('writer_identity_unverified'); }
    if (owner.pid !== expectedPid || owner.host !== hostname()) throw new StateFailure('writer_identity_unverified');
    try { process.kill(owner.pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') { await rm(this.lockPath, { recursive: true }); return; }
      throw new StateFailure('writer_identity_unverified');
    }
    throw new StateFailure('writer_still_running');
  }

  async load() {
    try {
      if ((await stat(this.path)).size > 16 * 1024 * 1024) throw new StateFailure('invalid_state');
      return migrateState(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (error instanceof StateFailure) throw error;
      throw new StateFailure(error.code === 'ENOENT' ? 'state_missing' : 'invalid_state');
    }
  }

  async persist(state) {
    validateState(state);
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temp, 'wx', 0o600);
      await file.writeFile(`${JSON.stringify(state)}\n`);
      await file.sync();
      await file.close(); file = null;
      await rename(temp, this.path);
      const directory = await open(dirname(this.path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { throw new StateFailure('persistence_failed'); }
    finally { await file?.close(); await rm(temp, { force: true }); }
  }

  async initialize(language = 'ru') {
    return this.locked(async () => {
      try { await stat(this.path); }
      catch (error) {
        if (error.code !== 'ENOENT') throw new StateFailure('persistence_failed');
        const state = initialState(language);
        await this.persist(state);
        return state;
      }
      throw new StateFailure('state_exists');
    });
  }

  async read() { return this.inspect(s => s); }
  async inspect(fn) { return this.locked(async () => fn(await this.load())); }
  async update(fn) {
    return this.locked(async () => {
      const state = await this.load();
      const before = JSON.stringify(state);
      const result = fn(state);
      if (result instanceof Promise) throw new StateFailure('async_state_mutation');
      if (JSON.stringify(state) !== before) {
        state.version++;
        await this.persist(state);
      }
      return { state, result };
    });
  }
}

async function writeLockOwner(path) {
  const owner = await open(`${path}/owner.json`, 'wx', 0o600);
  try { await owner.writeFile(JSON.stringify({ pid: process.pid, host: hostname() })); await owner.sync(); }
  finally { await owner.close(); }
}
