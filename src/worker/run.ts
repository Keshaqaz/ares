import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tick } from './tick.ts';
import { revoke as revokeSession } from '../chatgpt/session.ts';
import { TransientFailure, object } from '../chatgpt/http.ts';
import type { Fetch, TransientReason } from '../chatgpt/http.ts';
import { sealState, openState, readRules, readLogin, BrokenState } from './state-file.ts';
import type { State, Rules, BrokenStateReason } from './state-file.ts';
import type { TickOutcome } from './tick.ts';
import { openSummary, stepSummary } from './summary.ts';
import type { StepSummaryFields } from './summary.ts';
import { FILES } from './layout.ts';

const BOT = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898333+github-actions[bot]@users.noreply.github.com'];
const PUSH_ATTEMPTS = 3;

const run = promisify(execFile);
const git = (dir: string, ...args: string[]) => run('git', args, { cwd: dir });

// State or summary did not reach the remote; the run fails so that GitHub writes to the user.
class CommitFailed extends Error {
  reason: 'push_failed';
  constructor(reason: 'push_failed') { super(reason); this.reason = reason; }
}

// Every commit goes straight to the remote: a refreshed session that stays local is lost
// with the runner. The CLI may have pushed rules meanwhile; they touch other files, so a
// rebase never conflicts.
async function commit(dir: string, paths: string[], message: string): Promise<void> {
  await git(dir, 'add', '--', ...paths);
  await git(dir, ...BOT, 'commit', '--quiet', '-m', message);
  const branch = (await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim();
  for (let attempt = 1; ; attempt++) {
    try {
      await git(dir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
      return;
    } catch {
      if (attempt >= PUSH_ATTEMPTS) throw new CommitFailed('push_failed');
    }
    try { await git(dir, ...BOT, 'pull', '--quiet', '--rebase', 'origin', branch); } catch { throw new CommitFailed('push_failed'); }
  }
}

// Key order is not a change, and neither is the read time, which moves on every tick.
const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted) : object(value) ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const comparable = (state: State): string => JSON.stringify(sorted({ ...state, observed: state.observed && { ...state.observed, at: undefined } }));

export interface RunOptions {
  dir: string;
  key: string | undefined;
  now: number;
  fetch: Fetch;
  applyNow?: string | null;
  login?: string | null;
  revoke?: boolean;
  stepSummaryPath?: string | null;
}
export type RunOutcome = TickOutcome | 'broken_state' | 'revoked' | 'revoke_failed' | 'commit_failed';
export interface RunResult { outcome: RunOutcome; reason?: BrokenStateReason | TransientReason | 'push_failed'; exitCode: 0 | 1 }

// One worker run inside a checkout of the worker repository: decrypt state, tick,
// encrypt and commit what changed. Fails (exitCode 1) only when the user has to act.
// login is the text of the login secret, if the repository has one. revoke makes the run
// revoke the worker session in OpenAI instead of a tick, before `uninstall` deletes the
// repository; the run does not fail when OpenAI does not confirm it, uninstall reports that.
export async function runWorker({ dir, key, now, fetch, applyNow = null, login = null, revoke = false,
  stepSummaryPath = null }: RunOptions): Promise<RunResult> {
  const report = async (fields: Omit<StepSummaryFields, 'now'>) => {
    if (stepSummaryPath) await appendFile(stepSummaryPath, stepSummary({ now, ...fields }));
  };
  const path = (name: keyof typeof FILES) => join(dir, FILES[name]);
  let state: State, rules: Rules | null = null;
  try {
    const read = (name: 'state' | 'rules') => readFile(path(name), 'utf8').catch(() => { throw new BrokenState(`${name}_missing`); });
    state = openState(await read('state'), key);
    if (!revoke) rules = readRules(await read('rules'));
  } catch (error) {
    if (!(error instanceof BrokenState)) throw error;
    await report({ outcome: 'broken_state', reason: error.reason });
    return { outcome: 'broken_state', reason: error.reason, exitCode: 1 };
  }

  // Only a revoke run leaves the rules unread.
  if (revoke || !rules) {
    try {
      await revokeSession(fetch, state.session);
    } catch (error) {
      if (!(error instanceof TransientFailure)) throw error;
      await report({ outcome: 'revoke_failed', reason: error.reason });
      return { outcome: 'revoke_failed', reason: error.reason, exitCode: 0 };
    }
    await report({ outcome: 'revoked' });
    return { outcome: 'revoked', exitCode: 0 };
  }

  let saved = comparable(state);
  const writeState = (next: State) => writeFile(path('state'), sealState(next, key));
  const persist = async (next: State) => {
    await writeState(next);
    await commit(dir, [FILES.state], 'Save worker state');
    saved = comparable(next);
  };
  try {
    const result = await tick({ state, rules, now, fetch, applyNow, login: login ? readLogin(login) : null, persist });
    const summary = openSummary({ state: result.state, rules });
    const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
    const previousSummary = await readFile(path('summary'), 'utf8').catch(() => null);
    const changed: string[] = [];
    if (comparable(result.state) !== saved) {
      await writeState(result.state);
      changed.push(FILES.state);
    }
    // Before the first successful read there is nothing true to publish, except the verdict
    // on a login that `login` waits for.
    if ((result.state.observed || result.state.login) && summaryText !== previousSummary) {
      await writeFile(path('summary'), summaryText);
      changed.push(FILES.summary);
    }
    if (changed.length) await commit(dir, changed, `Worker tick: ${result.outcome}`);
    await report({ outcome: result.outcome, summary });
    return { outcome: result.outcome, exitCode: result.outcome === 'reauth_required' ? 1 : 0 };
  } catch (error) {
    if (!(error instanceof CommitFailed)) throw error;
    // A refreshed session that did not reach the remote is lost with the runner.
    await report({ outcome: 'commit_failed', reason: error.reason });
    return { outcome: 'commit_failed', reason: error.reason, exitCode: 1 };
  }
}
