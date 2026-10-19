import { usage } from '../chatgpt/client.ts';
import { needsRefresh, refresh } from '../chatgpt/session.ts';
import { SessionLost, TransientFailure } from '../chatgpt/http.ts';
import { GitHubApi, GitHubFailure } from '../github/api.ts';
import { SAME_WINDOW_MS } from '../worker/tick.ts';
import { KeychainUnavailable } from './keychain.ts';
import type { Keychain } from './keychain.ts';
import type { WatchFiles, WatchState } from './watch-files.ts';
import type { Quota } from '../chatgpt/client.ts';
import type { Fetch } from '../chatgpt/http.ts';
import { CommandFailed, WORKFLOW_FILE, workerRepository } from './common.ts';

// Whether this pass asks for an out-of-schedule check: once per exhausted weekly window.
// state.dispatched.renewsAt is the window already asked for; two reads of one window differ
// by seconds. A plan without a weekly window (weeklyQuota null) never asks.
export function decide(weeklyQuota: Quota | null, state: WatchState, now: number): { dispatch: boolean; nextState: WatchState } {
  const asked = state.dispatched?.renewsAt;
  const dispatch = weeklyQuota?.exhausted === true && weeklyQuota.renewsAt > now &&
    !(typeof asked === 'number' && Number.isFinite(asked) && Math.abs(asked - weeklyQuota.renewsAt) < SAME_WINDOW_MS);
  return { dispatch, nextState: dispatch && weeklyQuota ? { ...state, dispatched: { renewsAt: weeklyQuota.renewsAt, at: now } } : state };
}

// `aures watch`, run by the launchd agent every 2 minutes: one pass that reads the
// weekly quota with the computer session and, once the quota is exhausted, starts a worker run
// as the cron does. The worker decides on its own session whether to apply a reset. The pass
// never asks the user or logs in anywhere; every outcome is one log line and exit code 0.
// The watch files a pass reads and writes.
export type PassFiles = Pick<WatchFiles, 'readSession' | 'writeSession' | 'readState' | 'writeState'>;
export interface WatchOptions {
  fetch: Fetch;
  keychain: Pick<Keychain, 'read'>;
  files: PassFiles;
  log: (line: string) => void;
  now?: () => number;
}
export async function watch({ fetch, keychain, files, log, now = Date.now }: WatchOptions): Promise<number> {
  let state: WatchState = {}, outcome: string;
  try {
    state = await files.readState();
    ({ state, outcome } = await pass({ fetch, keychain, files, state, now: now() }));
  } catch (error) { outcome = `error: ${errorName(error) ?? 'unknown'}`; }
  try { await files.writeState({ ...state, lastPass: { at: now(), outcome } }); } catch { outcome += ' (watch.json not saved)'; }
  log(outcome);
  return 0;
}

const errorName = (error: unknown): unknown => typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;

interface Pass { state: WatchState; outcome: string }
async function pass({ fetch, keychain, files, state, now }:
  { fetch: Fetch; keychain: Pick<Keychain, 'read'>; files: PassFiles; state: WatchState; now: number }): Promise<Pass> {
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
async function dispatchWorker({ fetch, keychain }: { fetch: Fetch; keychain: Pick<Keychain, 'read'> }): Promise<string | null> {
  let token: string | null = null;
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
