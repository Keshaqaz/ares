import { randomUUID } from 'node:crypto';
import { usage, issuedResets, consume } from '../chatgpt/client.mjs';
import { needsRefresh, refresh } from '../chatgpt/session.mjs';
import { SessionLost, TransientFailure } from '../chatgpt/http.mjs';

// The before-expiry rule makes its first attempt on the first tick inside this window.
export const BEFORE_EXPIRY_MS = 8 * 3600_000;
// A reset renews the weekly window and moves its renewsAt by days; two reads of one window
// differ by seconds at most.
const SAME_WINDOW_MS = 3600_000;

// Group of matching deadlines: resets whose deadline falls on one calendar minute.
const minuteGroup = expiresAt => expiresAt === null ? null : Math.floor(expiresAt / 60_000);
const byDeadline = (a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || a.id.localeCompare(b.id);

// The reset the general rules apply on this tick, if any: one per group of matching
// deadlines. An application made while the weekly quota was exhausted records the window
// it recovered, so a later read of the same exhaustion does not spend a second reset.
function chooseByRules({ weeklyQuota, resets }, applied, rules, now) {
  const spent = new Set(applied.map(a => minuteGroup(a.expiresAt)).filter(g => g !== null));
  const candidates = resets.filter(r => (r.expiresAt === null || r.expiresAt > now) && !spent.has(minuteGroup(r.expiresAt)))
    .sort(byDeadline);
  const exhausted = weeklyQuota?.exhausted &&
    !applied.some(a => a.recovers !== null && Math.abs(a.recovers - weeklyQuota.renewsAt) < SAME_WINDOW_MS);
  if (rules.weeklyAutoApply && exhausted && candidates.length) return { reset: candidates[0], reason: 'weekly' };
  if (rules.beforeExpiry) {
    const due = candidates.find(r => r.expiresAt !== null && r.expiresAt - now <= BEFORE_EXPIRY_MS);
    if (due) return { reset: due, reason: 'before_expiry' };
  }
  return null;
}

// One worker run: refresh the worker session if it is about to expire, read quotas and
// issued resets, then apply at most one reset: the general rules choose it, or applyNow
// names it (a reset id from «Применить сейчас») regardless of the rules. The caller
// persists the returned state whatever the outcome. persist(state) is awaited after a
// refresh (it has already rotated the refresh token) and before a consume POST (its
// redeem_request_id must survive a lost reply), so the caller commits those states first.
export async function tick({ state, rules, now, fetch, applyNow = null, persist = async () => {} }) {
  let next = { pending: null, applied: [], ...state };
  try {
    if (needsRefresh(next.session, now)) {
      next = { ...next, session: await refresh(fetch, next.session) };
      await persist(next);
    }
    const [quotas, resets] = await Promise.all([usage(fetch, next.session), issuedResets(fetch, next.session)]);
    next = { ...next, observed: { at: now, ...quotas, resets } };
    // An unknown result is settled before anything new: a reset gone from the list was
    // applied, one still listed is retried with the same redeem_request_id. Past its
    // deadline a reset leaves the list anyway, so its disappearance proves nothing.
    const { pending } = next;
    if (pending) {
      if (resets.some(r => r.id === pending.creditId)) return await attempt(fetch, next, now);
      if (pending.expiresAt !== null && pending.expiresAt <= now) {
        return { state: { ...next, pending: null, lastAttempt: lastAttempt(pending, now, 'unknown') }, outcome: 'idle' };
      }
      return { state: recordApplied({ ...next, pending: null }, pending, now), outcome: 'applied' };
    }
    let choice = null;
    if (applyNow) {
      const reset = resets.find(r => r.id === applyNow);
      if (reset) choice = { reset, reason: 'apply_now' };
      else next = { ...next, lastAttempt: lastAttempt({ creditId: applyNow, reason: 'apply_now' }, now, 'missing') };
    }
    choice ??= chooseByRules(next.observed, next.applied, rules, now);
    if (!choice) return { state: next, outcome: 'idle' };
    next = { ...next, pending: { creditId: choice.reset.id, expiresAt: choice.reset.expiresAt, reason: choice.reason,
      redeemRequestId: randomUUID(), at: now, recovers: quotas.weeklyQuota?.exhausted ? quotas.weeklyQuota.renewsAt : null } };
    await persist(next);
    return await attempt(fetch, next, now);
  } catch (error) {
    if (error instanceof SessionLost) return { state: next, outcome: 'reauth_required' };
    if (error instanceof TransientFailure) return { state: next, outcome: 'transient_error' };
    throw error;
  }
}

// POST consume for state.pending. An unknown result keeps it for the next tick.
async function attempt(fetch, state, now) {
  const { pending } = state;
  let result;
  try {
    result = await consume(fetch, state.session, pending);
  } catch (error) {
    if (error instanceof TransientFailure) return { state, outcome: 'pending' };
    throw error;
  }
  if (result === 'already_redeemed') return { state, outcome: 'pending' };
  const done = { ...state, pending: null, lastAttempt: lastAttempt(pending, now, result) };
  if (result !== 'reset') return { state: done, outcome: 'idle' };
  return { state: recordApplied(done, pending, now), outcome: 'applied' };
}

const lastAttempt = ({ creditId, reason }, at, result) => ({ creditId, reason, at, result });

// Keeps the latest application and those that still matter for a rule: a deadline whose
// group could still be applied, or a weekly window not yet renewed. recovers is the
// renewsAt of the exhausted weekly window the application restored.
function recordApplied(state, pending, now) {
  const { creditId, expiresAt, reason, recovers } = pending;
  const list = [...state.applied, { creditId, expiresAt, reason, at: now, recovers }];
  return { ...state, applied: list.filter((a, i) => i === list.length - 1 || a.expiresAt > now || a.recovers > now) };
}
