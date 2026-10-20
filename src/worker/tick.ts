import { randomUUID } from 'node:crypto';
import { usage, issuedResets, consume } from '../chatgpt/client.ts';
import { needsRefresh, refresh } from '../chatgpt/session.ts';
import { SessionLost, TransientFailure } from '../chatgpt/http.ts';
import type { Fetch } from '../chatgpt/http.ts';
import type { IssuedReset, ConsumeResult } from '../chatgpt/client.ts';
import { migrateState, STATE_MIGRATIONS } from './state-file.ts';
import type { State, Rules, Login, Migration, Observed, Pending, Applied, ApplyReason, LastAttempt, AttemptResult } from './state-file.ts';

// The before-expiry rule makes its first attempt on the first tick inside this window.
export const BEFORE_EXPIRY_MS = 8 * 3600_000;
// A reset renews the weekly window and moves its renewsAt by days; two reads of one window
// differ by seconds at most.
export const SAME_WINDOW_MS = 3600_000;
// An attempt the server keeps calling already redeemed while it still lists the reset is let
// go after this long, so that it does not hold back every later application: a boundary that
// ends the cycle of attempts (CONTEXT.md, «Цикл попыток применения»).
export const ALREADY_REDEEMED_LIMIT_MS = 24 * 3600_000;

// Group of matching deadlines: resets whose deadline falls on one calendar minute.
const minuteGroup = (expiresAt: number | null): number | null => expiresAt === null ? null : Math.floor(expiresAt / 60_000);
const byDeadline = (a: IssuedReset, b: IssuedReset): number => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.id.localeCompare(b.id);

// The reset the general rules apply on this tick, if any: one per group of matching
// deadlines. An application made while the weekly quota was exhausted records the window
// it recovered, so a later read of the same exhaustion does not spend a second reset.
interface Choice { reset: IssuedReset; reason: ApplyReason }
function chooseByRules({ weeklyQuota, resets }: Observed, applied: Applied[], rules: Rules, now: number): Choice | null {
  const spent = new Set<number | null>(applied.map(a => minuteGroup(a.expiresAt)).filter(g => g !== null));
  const candidates = resets.filter(r => (r.expiresAt === null || r.expiresAt > now) && !spent.has(minuteGroup(r.expiresAt)))
    .sort(byDeadline);
  // A window past its renewal time starts over by itself; the check from the Mac skips it too.
  const exhausted = weeklyQuota?.exhausted && weeklyQuota.renewsAt > now &&
    !applied.some(a => a.recovers !== null && Math.abs(a.recovers - weeklyQuota.renewsAt) < SAME_WINDOW_MS);
  if (rules.weeklyAutoApply && exhausted && candidates[0]) return { reset: candidates[0], reason: 'weekly' };
  if (rules.beforeExpiry) {
    const due = candidates.find(r => r.expiresAt !== null && r.expiresAt - now <= BEFORE_EXPIRY_MS);
    if (due) return { reset: due, reason: 'before_expiry' };
  }
  return null;
}

// Whether a tick that failed for now is worth repeating within the run: the next scheduled
// run comes hours later (ADR-0004), and a reset may expire or the user may wait meanwhile. It
// is, for a consume in doubt, for «Применить сейчас» and for a reset the rules want now, by the
// last read; otherwise the next run checks again.
export function worthRetrying({ state, outcome }: TickResult, rules: Rules, now: number, applyNow: string | null): boolean {
  if (outcome !== 'transient_error' && outcome !== 'pending') return false;
  return Boolean(state.pending || applyNow || state.observed && chooseByRules(state.observed, state.applied, rules, now));
}

export type TickOutcome = 'idle' | 'applied' | 'pending' | 'transient_error' | 'reauth_required';
// The state as a tick works on it: pending and applied always present.
export type Ticked = State & { pending: Pending | null; applied: Applied[] };
export interface TickResult { state: Ticked; outcome: TickOutcome }
export interface TickOptions {
  state: State;
  rules: Rules;
  now: number;
  fetch: Fetch;
  applyNow?: string | null;
  login?: Login | null;
  persist?: (state: Ticked) => Promise<unknown>;
  migrations?: Migration[];
}

// One worker run: refresh the worker session if it is about to expire, read quotas and
// issued resets, then apply at most one reset: the general rules choose it, or applyNow
// names it (a reset id from «Применить сейчас») regardless of the rules. login is a new
// worker session from `aures login`, { id, session }: it replaces the session
// once, and only for the same ChatGPT account. The caller persists the returned state
// whatever the outcome. persist(state) is awaited after a new session (a refresh has
// already rotated the refresh token, a login must not be lost) and before a consume POST
// (its redeem_request_id must survive a lost reply), so the caller commits those states first.
// A state of an older formatVersion is migrated first, and the returned state is in the
// current one; migrations are the format steps (state-file.ts).
export async function tick({ state, rules, now, fetch, applyNow = null, login = null, persist = async () => {},
  migrations = STATE_MIGRATIONS }: TickOptions): Promise<TickResult> {
  let next: Ticked = { pending: null, applied: [], ...migrateState(state, migrations) };
  try {
    // The login secret outlives its use; its tokens are rotated away after the first tick.
    if (login && login.id !== next.login?.id) {
      const accepted = login.session.accountId === next.session.accountId;
      next = { ...next, session: accepted ? login.session : next.session,
        login: { id: login.id, result: accepted ? 'accepted' : 'rejected', at: now } };
      if (accepted) await persist(next);
    }
    if (needsRefresh(next.session, now)) {
      next = { ...next, session: await refresh(fetch, next.session) };
      await persist(next);
    }
    const [quotas, resets] = await Promise.all([usage(fetch, next.session), issuedResets(fetch, next.session)]);
    const observed = { at: now, ...quotas, resets };
    next = { ...next, observed };
    // An unknown result is settled before anything new: a reset gone from the list was
    // applied, one still listed is retried with the same redeem_request_id. Past its
    // deadline a reset leaves the list anyway, so its disappearance proves nothing.
    const { pending } = next;
    if (pending) {
      if (resets.some(r => r.id === pending.creditId)) return await attempt(fetch, { ...next, pending }, now);
      if (pending.expiresAt !== null && pending.expiresAt <= now) {
        return unsettled(next, pending, now);
      }
      return { state: recordApplied({ ...next, pending: null }, pending, now), outcome: 'applied' };
    }
    let choice: Choice | null = null;
    if (applyNow) {
      const reset = resets.find(r => r.id === applyNow);
      if (reset) choice = { reset, reason: 'apply_now' };
      else next = { ...next, lastAttempt: lastAttempt({ creditId: applyNow, reason: 'apply_now' }, now, 'missing') };
    }
    choice ??= chooseByRules(observed, next.applied, rules, now);
    if (!choice) return { state: next, outcome: 'idle' };
    const chosen = { ...next, pending: { creditId: choice.reset.id, expiresAt: choice.reset.expiresAt, reason: choice.reason,
      redeemRequestId: randomUUID(), at: now, recovers: quotas.weeklyQuota?.exhausted ? quotas.weeklyQuota.renewsAt : null } };
    next = chosen;
    await persist(next);
    return await attempt(fetch, chosen, now);
  } catch (error) {
    if (error instanceof SessionLost) return { state: next, outcome: 'reauth_required' };
    if (error instanceof TransientFailure) return { state: next, outcome: 'transient_error' };
    throw error;
  }
}

// POST consume for state.pending. An unknown result keeps it for the next tick, except an
// already_redeemed one past ALREADY_REDEEMED_LIMIT_MS.
async function attempt(fetch: Fetch, state: Ticked & { pending: Pending }, now: number): Promise<TickResult> {
  const { pending } = state;
  let result: ConsumeResult;
  try {
    result = await consume(fetch, state.session, pending);
  } catch (error) {
    if (error instanceof TransientFailure) return { state, outcome: 'pending' };
    throw error;
  }
  if (result === 'already_redeemed') {
    if (now - pending.at < ALREADY_REDEEMED_LIMIT_MS) return { state, outcome: 'pending' };
    return unsettled(state, pending, now);
  }
  const done = { ...state, pending: null, lastAttempt: lastAttempt(pending, now, result) };
  if (result !== 'reset') return { state: done, outcome: 'idle' };
  return { state: recordApplied(done, pending, now), outcome: 'applied' };
}

const lastAttempt = ({ creditId, reason }: { creditId: string; reason: ApplyReason }, at: number,
  result: AttemptResult): LastAttempt => ({ creditId, reason, at, result });
// Lets the attempt go without knowing whether it applied the reset.
const unsettled = (state: Ticked, pending: Pending, now: number): TickResult =>
  ({ state: { ...state, pending: null, lastAttempt: lastAttempt(pending, now, 'unknown') }, outcome: 'idle' });

// Keeps the latest application and those that still matter for a rule: a deadline whose
// group could still be applied, or a weekly window not yet renewed. recovers is the
// renewsAt of the exhausted weekly window the application restored.
function recordApplied(state: Ticked, pending: Pending, now: number): Ticked {
  const { creditId, expiresAt, reason, recovers } = pending;
  const list = [...state.applied, { creditId, expiresAt, reason, at: now, recovers }];
  return { ...state, applied: list.filter((a, i) => i === list.length - 1 ||
    a.expiresAt !== null && a.expiresAt > now || a.recovers !== null && a.recovers > now) };
}
