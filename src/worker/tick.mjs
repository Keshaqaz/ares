import { usage, issuedResets } from '../chatgpt/client.mjs';
import { needsRefresh, refresh } from '../chatgpt/session.mjs';
import { SessionLost, TransientFailure } from '../chatgpt/http.mjs';

// One worker run: refresh the worker session if it is about to expire, then read quotas
// and issued resets. Pure apart from fetch: the caller persists the returned state
// whatever the outcome. A refresh has already rotated the refresh token, so onRefresh
// lets the caller persist the new session before anything else can fail.
export async function tick({ state, rules, now, fetch, onRefresh = async () => {} }) {
  let next = state;
  try {
    if (needsRefresh(next.session, now)) {
      next = { ...next, session: await refresh(fetch, next.session) };
      await onRefresh(next);
    }
    const [quotas, resets] = await Promise.all([usage(fetch, next.session), issuedResets(fetch, next.session)]);
    return { state: { ...next, observed: { at: now, ...quotas, resets } }, outcome: 'idle' };
  } catch (error) {
    if (error instanceof SessionLost) return { state: next, outcome: 'reauth_required' };
    if (error instanceof TransientFailure) return { state: next, outcome: 'transient_error' };
    throw error;
  }
}
