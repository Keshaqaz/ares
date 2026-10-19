import { usage } from '../chatgpt/client.mjs';
import { needsRefresh, refresh } from '../chatgpt/session.mjs';
import { SessionLost, TransientFailure } from '../chatgpt/http.mjs';
import { GitHubApi, GitHubFailure } from '../github/api.mjs';
import { SAME_WINDOW_MS } from '../worker/tick.mjs';
import { KeychainUnavailable } from './keychain.mjs';
import { CommandFailed, WORKFLOW_FILE, workerRepository } from './common.mjs';

// Whether this pass asks for an out-of-schedule check: once per exhausted weekly window.
// state.dispatched.renewsAt is the window already asked for; two reads of one window differ
// by seconds. A plan without a weekly window (weeklyQuota null) never asks.
export function decide(weeklyQuota, state, now) {
  const asked = state.dispatched?.renewsAt;
  const dispatch = Boolean(weeklyQuota?.exhausted) && weeklyQuota.renewsAt > now &&
    !(Number.isFinite(asked) && Math.abs(asked - weeklyQuota.renewsAt) < SAME_WINDOW_MS);
  return { dispatch, nextState: dispatch ? { ...state, dispatched: { renewsAt: weeklyQuota.renewsAt, at: now } } : state };
}

// `aures watch`, run by the launchd agent every 2 minutes: one pass that reads the
// weekly quota with the computer session and, once the quota is exhausted, starts a worker run
// as the cron does. The worker decides on its own session whether to apply a reset. The pass
// never asks the user or logs in anywhere; every outcome is one log line and exit code 0.
export async function watch({ fetch, keychain, files, log, now = Date.now }) {
  let state = {}, outcome;
  try {
    state = await files.readState();
    ({ state, outcome } = await pass({ fetch, keychain, files, state, now: now() }));
  } catch (error) { outcome = `error: ${error?.name ?? 'unknown'}`; }
  try { await files.writeState({ ...state, lastPass: { at: now(), outcome } }); } catch { outcome += ' (watch.json not saved)'; }
  log(outcome);
  return 0;
}

async function pass({ fetch, keychain, files, state, now }) {
  // A lost session stays lost until setup opens a new one and clears the mark.
  if (state.sessionLost) return { state, outcome: 'reauth_required' };
  let session = await files.readSession();
  if (!session) return { state, outcome: 'no_session' };
  let quotas;
  try {
    if (needsRefresh(session, now)) {
      session = await refresh(fetch, session);
      // The old refresh token is spent: the new one is saved before anything else can fail.
      await files.writeSession(session);
    }
    quotas = await usage(fetch, session);
  } catch (error) {
    if (error instanceof SessionLost) return { state: { ...state, sessionLost: true }, outcome: `reauth_required: ${error.reason}` };
    if (error instanceof TransientFailure) return { state, outcome: `transient_error: ${error.reason}` };
    throw error;
  }
  const { dispatch, nextState } = decide(quotas.weeklyQuota, state, now);
  if (!dispatch) return { state, outcome: 'idle' };
  // The window is recorded only after GitHub took the dispatch, so a failed one is retried.
  const failure = await dispatchWorker({ fetch, keychain });
  return failure ? { state, outcome: failure } : { state: nextState, outcome: 'dispatched' };
}

// One worker run with empty inputs, like a scheduled tick. Returns why it did not start, or null.
async function dispatchWorker({ fetch, keychain }) {
  let token = null;
  try { token = await keychain.read(); } catch (error) { if (!(error instanceof KeychainUnavailable)) throw error; }
  if (!token) return 'no_github_token';
  try {
    const api = new GitHubApi({ fetch, token });
    const repo = await workerRepository({ api, login: await api.login() });
    if (!repo) return 'no_worker';
    const started = await api.dispatch(repo.full_name, WORKFLOW_FILE, { ref: repo.default_branch, inputs: { apply_now: '' } });
    return started ? null : 'dispatch_refused';
  } catch (error) {
    if (error instanceof GitHubFailure) return `github_error: ${error.reason}`;
    if (error instanceof CommandFailed) return 'foreign_repository';
    throw error;
  }
}
