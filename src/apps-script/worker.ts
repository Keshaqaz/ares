import pkg from '../../package.json' with { type: 'json' };
import { tick } from '../worker/tick.ts';
import type { TickOutcome, WouldApply } from '../worker/tick.ts';
import { revoke as revokeSession } from '../chatgpt/session.ts';
import { TransientFailure, object } from '../chatgpt/http.ts';
import type { TransientReason } from '../chatgpt/http.ts';
import { migrateState, readRules, readLogin, BrokenState, STATE_FORMAT_VERSION, RULES_FORMAT_VERSION } from '../worker/state-file.ts';
import type { State, Rules, Login, BrokenStateReason } from '../worker/state-file.ts';
import { openSummary } from '../worker/summary.ts';
import type { Summary } from '../worker/summary.ts';
import { settle } from './sync-promise.ts';
import { urlFetch } from './runtime.ts';
import type { AppsScript, Properties, TextOutput, WebAppEvent } from './runtime.ts';
import { BEFORE_EXPIRY_MS, TICK_MINUTES, TICK_FUNCTION } from './layout.ts';

// Script Properties: state and rules as plain JSON (ADR-0007: a key would lie next to them),
// and the journal. Apps Script keeps at most 9 KB in one value.
export const PROPERTIES = { state: 'state', rules: 'rules', journal: 'journal' } as const;
// The journal keeps this many latest runs.
export const JOURNAL_SIZE = 30;
// A run waits this long for another one to finish: two ticks in one minute happen (probe 01).
const LOCK_WAIT_MS = 30_000;

// What started a run: the schedule, the Mac, a trial run, «Применить сейчас» or `login`.
export type RunKind = 'scheduled' | 'mac' | 'trial' | 'apply_now' | 'login';
export type RunOutcome = TickOutcome | 'broken_state';
// One run in the journal; at is ISO time.
// A trial run that found a reset for the rules names it and why: what they would apply.
export interface JournalEntry {
  at: string; kind: RunKind; outcome: RunOutcome; durationMs: number; reason?: BrokenStateReason; wouldApply?: WouldApply;
}
// What a run tells doPost: never the state itself.
interface Ran { outcome: RunOutcome; reason?: BrokenStateReason; wouldApply: WouldApply | null; summary: Summary | null }

export interface Worker {
  tick(): void;
  doGet(event?: WebAppEvent): TextOutput;
  doPost(event?: WebAppEvent): TextOutput;
}
export interface WorkerOptions {
  gas: () => AppsScript;
  // The secret doPost requires, from the project's secret file; null when there is none.
  secret: () => string | null;
}

// The message of the failed trigger run, which Google mails to the user.
const FAILURES: Partial<Record<RunOutcome, string>> = {
  reauth_required: 'aures: the worker lost its ChatGPT sign-in. Sign in again: `aures login`.',
  broken_state: 'aures: the worker data does not read. What to do: `aures status`.',
};
// The one reply to a request without the right secret, whatever else it holds.
const FORBIDDEN = { ok: false, error: 'forbidden' };
const BUSY = Symbol('busy');

const iso = (ms: number): string => new Date(ms).toISOString();
// Compares in time that does not depend on where the first difference is.
function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < given.length; i++) difference |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

// The worker on Apps Script: the same tick as on GitHub, with state in Script Properties. A
// tick and every doPost that changes something run under the script lock. The tick throws when
// only the user can help, so that Google mails them; a temporary failure waits for the next tick.
export function appsScriptWorker({ gas, secret }: WorkerOptions): Worker {
  const locked = <T>(g: AppsScript, work: () => T): T | typeof BUSY => {
    const lock = g.LockService.getScriptLock();
    if (!lock.tryLock(LOCK_WAIT_MS)) return BUSY;
    try { return work(); } finally { lock.releaseLock(); }
  };

  // State and rules as the tick takes them. A login brings the first session when there is no state yet.
  const load = (props: Properties, login: Login | null = null): { state: State; rules: Rules } => {
    const stateText = props.getProperty(PROPERTIES.state);
    let state: unknown = login ? { formatVersion: STATE_FORMAT_VERSION, session: login.session } : null;
    if (stateText !== null) {
      try { state = JSON.parse(stateText); } catch { throw new BrokenState('state_unreadable'); }
    } else if (!state) throw new BrokenState('state_missing');
    const rulesText = props.getProperty(PROPERTIES.rules);
    if (rulesText === null) throw new BrokenState('rules_missing');
    return { state: migrateState(state), rules: readRules(rulesText) };
  };

  const journal = (props: Properties): JournalEntry[] => {
    try {
      const entries: unknown = JSON.parse(props.getProperty(PROPERTIES.journal) ?? '[]');
      return Array.isArray(entries) ? entries.filter(object).map(entry => entry as unknown as JournalEntry) : [];
    } catch { return []; }
  };

  const runTick = (g: AppsScript, kind: RunKind, { applyNow = null, trial = false, login = null }:
    { applyNow?: string | null; trial?: boolean; login?: Login | null } = {}): Ran => {
    const started = Date.now();
    const props = g.PropertiesService.getScriptProperties();
    const save = (state: State) => { props.setProperty(PROPERTIES.state, JSON.stringify(state)); };
    let ran: Ran;
    try {
      const { state, rules } = load(props, login);
      const { fetch, flush } = urlFetch(g);
      const result = settle(tick({ state, rules, now: started, fetch, beforeExpiryMs: BEFORE_EXPIRY_MS, applyNow, trial, login,
        persist: async next => save(next) }), flush);
      save(result.state);
      ran = { outcome: result.outcome, wouldApply: result.wouldApply ?? null, summary: openSummary({ state: result.state, rules }) };
    } catch (error) {
      if (!(error instanceof BrokenState)) throw error;
      ran = { outcome: 'broken_state', reason: error.reason, wouldApply: null, summary: null };
    }
    const entry: JournalEntry = { at: iso(started), kind, outcome: ran.outcome, durationMs: Date.now() - started,
      ...ran.reason ? { reason: ran.reason } : {}, ...ran.wouldApply ? { wouldApply: ran.wouldApply } : {} };
    props.setProperty(PROPERTIES.journal, JSON.stringify([...journal(props), entry].slice(-JOURNAL_SIZE)));
    return ran;
  };

  const schedule = (g: AppsScript, on: boolean) => {
    for (const trigger of g.ScriptApp.getProjectTriggers()) {
      if (trigger.getHandlerFunction() === TICK_FUNCTION) g.ScriptApp.deleteTrigger(trigger);
    }
    if (on) g.ScriptApp.newTrigger(TICK_FUNCTION).timeBased().everyMinutes(TICK_MINUTES).create();
  };
  const scheduled = (g: AppsScript): boolean => g.ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === TICK_FUNCTION);

  // Revokes the worker session in OpenAI; the state keeps it, and the next tick finds it lost.
  const revoke = (g: AppsScript): { outcome: 'revoked' | 'revoke_failed' | 'no_session'; reason?: TransientReason } => {
    let state: State;
    try { state = load(g.PropertiesService.getScriptProperties()).state; } catch (error) {
      if (error instanceof BrokenState) return { outcome: 'no_session' };
      throw error;
    }
    const { fetch, flush } = urlFetch(g);
    try {
      settle(revokeSession(fetch, state.session), flush);
      return { outcome: 'revoked' };
    } catch (error) {
      if (error instanceof TransientFailure) return { outcome: 'revoke_failed', reason: error.reason };
      throw error;
    }
  };

  const view = ({ outcome, reason, wouldApply, summary }: Ran) => ({ ok: true, outcome, ...reason ? { reason } : {}, wouldApply, summary });

  // Each action takes the parsed request; null means the request is malformed.
  type Action = (g: AppsScript, request: Record<string, unknown>) => object | null;
  const ACTIONS: Record<string, { locked: boolean; act: Action }> = {
    status: { locked: false, act: g => {
      const props = g.PropertiesService.getScriptProperties();
      let summary: Summary | null = null, rules: Summary['rules'] | null = null;
      try { summary = openSummary(load(props)); } catch (error) { if (!(error instanceof BrokenState)) throw error; }
      // Without rules there is no summary either; setup asks for them before the first login.
      const rulesText = props.getProperty(PROPERTIES.rules);
      try {
        const read = rulesText === null ? null : readRules(rulesText);
        rules = read && { beforeExpiry: read.beforeExpiry, weeklyAutoApply: read.weeklyAutoApply };
      } catch (error) { if (!(error instanceof BrokenState)) throw error; }
      return { ok: true, version: pkg.version, schedule: scheduled(g), rules, summary, journal: journal(props) };
    } },
    trial: { locked: true, act: g => view(runTick(g, 'trial', { trial: true })) },
    wake: { locked: true, act: g => view(runTick(g, 'mac')) },
    apply_now: { locked: true, act: (g, { creditId }) =>
      typeof creditId === 'string' && creditId ? view(runTick(g, 'apply_now', { applyNow: creditId })) : null },
    // A worker without a schedule is not the active one yet (setup, a switch of platform), so
    // its login spends nothing: it goes as a trial run.
    login: { locked: true, act: (g, request) => {
      const login = readLogin(JSON.stringify(request.login ?? null));
      return login && view(runTick(g, 'login', { login, trial: !scheduled(g) }));
    } },
    rules: { locked: true, act: (g, request) => {
      const given = object(request.rules) ? request.rules : {};
      let rules: Rules;
      try {
        rules = readRules(JSON.stringify({ formatVersion: RULES_FORMAT_VERSION, beforeExpiry: given.beforeExpiry,
          weeklyAutoApply: given.weeklyAutoApply }));
      } catch { return null; }
      g.PropertiesService.getScriptProperties().setProperty(PROPERTIES.rules, JSON.stringify(rules));
      return { ok: true, rules: { beforeExpiry: rules.beforeExpiry, weeklyAutoApply: rules.weeklyAutoApply } };
    } },
    schedule: { locked: true, act: (g, { on }) => {
      if (typeof on !== 'boolean') return null;
      schedule(g, on);
      return { ok: true, schedule: on };
    } },
    revoke: { locked: true, act: g => ({ ok: true, ...revoke(g) }) },
    // Leaves nothing that runs or holds a session: the project itself only the user can delete.
    // A revocation OpenAI did not confirm keeps the state, so that a repeated uninstall retries it.
    uninstall: { locked: true, act: g => {
      for (const trigger of g.ScriptApp.getProjectTriggers()) g.ScriptApp.deleteTrigger(trigger);
      const revoked = revoke(g);
      if (revoked.outcome === 'revoke_failed') return { ok: true, ...revoked };
      g.PropertiesService.getScriptProperties().deleteAllProperties();
      g.ScriptApp.invalidateAuth();
      return { ok: true, ...revoked };
    } },
  };

  return {
    tick() {
      const g = gas();
      const ran = locked(g, () => runTick(g, 'scheduled'));
      // Another run holds the lock; it reads and applies what this one would.
      if (ran === BUSY) return;
      const failure = FAILURES[ran.outcome];
      if (failure) throw new Error(ran.reason ? `${failure} (${ran.reason})` : failure);
    },
    // Opened in the browser once, for the user to grant the script its scopes.
    doGet() {
      return gas().ContentService.createTextOutput('aures: done, go back to the terminal. Готово, вернитесь в терминал.');
    },
    // A JSON request { secret, action, … } from the CLI; the reply is JSON and never holds tokens or the state.
    doPost(event) {
      const g = gas();
      const reply = (body: object) => g.ContentService.createTextOutput(JSON.stringify(body)).setMimeType(g.ContentService.MimeType.JSON);
      let request: unknown = null;
      try { request = JSON.parse(event?.postData?.contents ?? ''); } catch { /* answered as forbidden below */ }
      const expected = secret();
      if (!object(request) || !expected || !sameSecret(request.secret, expected)) return reply(FORBIDDEN);
      const action = typeof request.action === 'string' && Object.prototype.hasOwnProperty.call(ACTIONS, request.action) ? ACTIONS[request.action] : null;
      if (!action) return reply({ ok: false, error: 'unknown_action' });
      const result = action.locked ? locked(g, () => action.act(g, request)) : action.act(g, request);
      if (result === BUSY) return reply({ ok: false, error: 'busy' });
      return reply(result ?? { ok: false, error: 'bad_request' });
    },
  };
}
