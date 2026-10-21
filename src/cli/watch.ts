import { usage } from '../chatgpt/client.ts';
import { needsRefresh, refresh } from '../chatgpt/session.ts';
import { SessionLost, TransientFailure, asObject } from '../chatgpt/http.ts';
import { GitHubApi, GitHubFailure } from '../github/api.ts';
import { GoogleFailure } from '../google/api.ts';
import { SAME_WINDOW_MS } from '../worker/tick.ts';
import { KeychainUnavailable } from './keychain.ts';
import type { Keychain } from './keychain.ts';
import type { WatchFiles, WatchState, GoogleWorker } from './watch-files.ts';
import type { Quota } from '../chatgpt/client.ts';
import type { Fetch } from '../chatgpt/http.ts';
import type { Summary } from '../worker/summary.ts';
import { askWorker, readSecret } from './google.ts';
import { CommandFailed, WORKFLOW_FILE, workerRepository } from './common.ts';
import { FILES } from '../worker/layout.ts';

// A worker run is asked for again while the same weekly window stays exhausted: the run may have
// met a temporary ChatGPT error or read the quota a moment too early. REPEAT_AFTER_MS[i] is the
// pause after the (i + 1)th run, so a window gets at most DISPATCHES runs.
export const REPEAT_AFTER_MS = [15 * 60_000, 60 * 60_000];
export const DISPATCHES = REPEAT_AFTER_MS.length + 1;
// Below NEAR_PERCENT, and once every run for an exhausted window is asked for, a pass reads the
// quota only when the last read is QUIET_MS old: every fifth pass, ten minutes apart. A quota
// that runs out from below NEAR_PERCENT is noticed up to ten minutes later.
export const NEAR_PERCENT = 80;
export const QUIET_MS = 9 * 60_000;

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const sameWindow = (a: unknown, b: number): boolean => finite(a) && Math.abs(a - b) < SAME_WINDOW_MS;
// How many runs were asked for the window in state.dispatched; a watch.json of an older version has no count.
const asked = ({ dispatched }: WatchState): number => Number.isInteger(dispatched?.count) && Number(dispatched?.count) >= 1 ?
  Number(dispatched?.count) : 1;

// Whether this pass asks for an out-of-schedule check, the first for the exhausted weekly
// window or a repeat. state.dispatched.renewsAt is the window already asked for; two reads of
// one window differ by seconds. A plan without a weekly window (weeklyQuota null) never asks.
export type Dispatch = 'first' | 'repeat' | null;
export function decide(weeklyQuota: Quota | null, state: WatchState, now: number): { dispatch: Dispatch; nextState: WatchState } {
  if (!weeklyQuota?.exhausted || weeklyQuota.renewsAt <= now) return { dispatch: null, nextState: state };
  const { dispatched } = state;
  const count = sameWindow(dispatched?.renewsAt, weeklyQuota.renewsAt) ? asked(state) : 0;
  if (count) {
    const pause = REPEAT_AFTER_MS[count - 1];
    if (pause === undefined || !finite(dispatched?.at) || now - dispatched.at < pause) return { dispatch: null, nextState: state };
  }
  return { dispatch: count ? 'repeat' : 'first',
    nextState: { ...state, dispatched: { renewsAt: weeklyQuota.renewsAt, at: now, count: count + 1 } } };
}

// Whether this pass leaves the quota unread: the last read is recent, and it was far from the
// end, or it was an exhausted window that has had all its runs.
export function quiet({ read, ...state }: WatchState, now: number): boolean {
  if (!read || !finite(read.at) || now < read.at || now - read.at >= QUIET_MS) return false;
  if (read.usedPercent === null) return true;
  if (!finite(read.usedPercent)) return false;
  if (read.usedPercent < NEAR_PERCENT) return true;
  return read.usedPercent >= 100 && finite(read.renewsAt) && read.renewsAt > now &&
    sameWindow(state.dispatched?.renewsAt, read.renewsAt) && asked(state) >= DISPATCHES;
}

// `aures watch`, run by the launchd agent every 2 minutes: one pass that reads the
// weekly quota with the computer session (or leaves it unread, see quiet) and, once the quota is
// exhausted, starts a worker run as the cron does, repeated while the window stays exhausted.
// The worker of this install is woken wherever it runs (ADR-0007): a dispatch on GitHub, a
// doPost wake on Apps Script; a worker on pause is woken by no pass. The worker decides on its
// own session whether to apply a reset. The pass never asks the user or logs in anywhere; every
// outcome is one log line and exit code 0.
// The watch files a pass reads and writes.
export type PassFiles = Pick<WatchFiles, 'readSession' | 'writeSession' | 'readState' | 'writeState' | 'readInstall'>;
export interface WatchOptions {
  fetch: Fetch;
  keychain: Pick<Keychain, 'read'>;
  // The doPost secret of the worker on Apps Script, read only.
  secretKeychain: Pick<Keychain, 'read'>;
  files: PassFiles;
  log: (line: string) => void;
  now?: () => number;
}
export async function watch({ fetch, keychain, secretKeychain, files, log, now = Date.now }: WatchOptions): Promise<number> {
  let state: WatchState = {}, outcome: string;
  try {
    state = await files.readState();
    ({ state, outcome } = await pass({ fetch, keychain, secretKeychain, files, state, now: now() }));
  } catch (error) { outcome = `error: ${errorName(error) ?? 'unknown'}`; }
  try { await files.writeState({ ...state, lastPass: { at: now(), outcome } }); } catch { outcome += ' (watch.json not saved)'; }
  log(outcome);
  return 0;
}

const errorName = (error: unknown): unknown => typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;

interface Pass { state: WatchState; outcome: string }
async function pass({ fetch, keychain, secretKeychain, files, state, now }:
  { fetch: Fetch; keychain: Pick<Keychain, 'read'>; secretKeychain: Pick<Keychain, 'read'>; files: PassFiles; state: WatchState; now: number }): Promise<Pass> {
  // A lost session stays lost until setup opens a new one and clears the mark.
  if (state.sessionLost) return { state, outcome: 'reauth_required' };
  // The install record names the worker to wake: a paused worker has no schedule, so the
  // out-of-schedule check rests too — no quota read, no run (ADR-0007).
  const install = await files.readInstall();
  if (install?.paused) return { state, outcome: 'paused' };
  // Mid-switch of platform no worker is active: the old one may be quenched, the new one has no schedule yet.
  if (install?.switching) return { state, outcome: 'switching' };
  let session = await files.readSession();
  if (!session) return { state, outcome: 'no_session' };
  if (quiet(state, now)) return { state, outcome: 'quiet' };
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
  const { weeklyQuota } = quotas;
  const read = { ...state, read: { at: now, usedPercent: weeklyQuota?.usedPercent ?? null, renewsAt: weeklyQuota?.renewsAt ?? null } };
  const { dispatch, nextState } = decide(weeklyQuota, read, now);
  if (!dispatch || !weeklyQuota) return { state: read, outcome: 'idle' };
  // The window is recorded only after the worker took the run, so a failed one is retried.
  const failure = install?.platform === 'google'
    ? await wakeGoogle({ fetch, keychain: secretKeychain, google: install.google, repeat: dispatch === 'repeat' })
    : await dispatchWorker({ fetch, keychain, repeat: dispatch === 'repeat' });
  // Without a reset to apply, more runs for this window would only spend the platform's minutes.
  if (failure === 'no_resets') return { state: { ...read, dispatched: { renewsAt: weeklyQuota.renewsAt, at: now, count: DISPATCHES } }, outcome: failure };
  if (failure) return { state: read, outcome: failure };
  const count = nextState.dispatched?.count ?? 1;
  return { state: nextState, outcome: count > 1 ? `dispatched (${count} of ${DISPATCHES})` : 'dispatched' };
}

// Whether the worker's last summary lists no reset at all; an unreadable one is not taken for none.
async function noResets(api: GitHubApi, repo: string): Promise<boolean> {
  const file = await api.file(repo, FILES.summary);
  let resets: unknown;
  try { resets = file && asObject(JSON.parse(file.text))?.resets; } catch { return false; }
  return Array.isArray(resets) && resets.length === 0;
}

// What a doPost reply that is not ok tells the log; null is the page of a script that has no
// access yet. A wrong secret is answered 'forbidden' with no detail, whoever asks.
const refused = (reply: Record<string, unknown> | null): string =>
  reply === null ? 'no_access' : reply.error === 'forbidden' ? 'forbidden' : `refused: ${String(reply.error)}`;

// One run of the worker on Google (ADR-0007): doPost wake, a run as the schedule makes, with
// the secret from the Keychain and the web app from the install record. Returns why the run did
// not start, or null. As on GitHub, a repeat is not asked for when the worker's summary lists no
// resets: 'no_resets'.
async function wakeGoogle({ fetch, keychain, google, repeat }:
  { fetch: Fetch; keychain: Pick<Keychain, 'read'>; google: GoogleWorker | undefined; repeat: boolean }): Promise<string | null> {
  const { url, deploymentId } = google ?? {};
  if (!url || !deploymentId) return 'no_worker';
  const secret = await readSecret(keychain);
  if (!secret) return 'no_secret';
  const ask = (action: string, extra?: Record<string, unknown>) => askWorker({ fetch, url, secret }, action, extra);
  try {
    if (repeat) {
      const status = await ask('status');
      if (status?.ok !== true) return refused(status);
      const resets = (status.summary as Summary | null | undefined)?.resets;
      if (resets !== undefined && resets.length === 0) return 'no_resets';
    }
    const woken = await ask('wake');
    return woken?.ok === true ? null : refused(woken);
  } catch (error) {
    if (error instanceof GoogleFailure) return `google_error: ${error.reason}`;
    throw error;
  }
}

// One worker run with empty inputs, like a scheduled tick. Returns why it did not start, or
// null. A repeat is not asked for when the worker's summary has no resets: 'no_resets'.
async function dispatchWorker({ fetch, keychain, repeat }: { fetch: Fetch; keychain: Pick<Keychain, 'read'>; repeat: boolean }):
  Promise<string | null> {
  let token: string | null = null;
  try { token = await keychain.read(); } catch (error) { if (!(error instanceof KeychainUnavailable)) throw error; }
  if (!token) return 'no_github_token';
  try {
    const api = new GitHubApi({ fetch, token });
    const repo = await workerRepository({ api, login: await api.login() });
    if (!repo) return 'no_worker';
    if (repeat && await noResets(api, repo.full_name)) return 'no_resets';
    const started = await api.dispatch(repo.full_name, WORKFLOW_FILE, { ref: repo.default_branch, inputs: { apply_now: '' } });
    return started ? null : 'dispatch_refused';
  } catch (error) {
    if (error instanceof GitHubFailure) return `github_error: ${error.reason}`;
    if (error instanceof CommandFailed) return 'foreign_repository';
    throw error;
  }
}
