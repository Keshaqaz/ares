import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tick } from './tick.mjs';
import { sealState, openState, readRules, BrokenState } from './state-file.mjs';
import { openSummary, stepSummary } from './summary.mjs';
import { FILES } from './layout.mjs';

const BOT = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898333+github-actions[bot]@users.noreply.github.com'];
const PUSH_ATTEMPTS = 3;

const run = promisify(execFile);
const git = (dir, ...args) => run('git', args, { cwd: dir });

// State or summary did not reach the remote; the run fails so that GitHub writes to the user.
class CommitFailed extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

// Every commit goes straight to the remote: a refreshed session that stays local is lost
// with the runner. The CLI may have pushed rules meanwhile; they touch other files, so a
// rebase never conflicts.
async function commit(dir, paths, message) {
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
const sorted = value => Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const comparable = state => JSON.stringify(sorted({ ...state, observed: state.observed && { ...state.observed, at: undefined } }));

// One worker run inside a checkout of the worker repository: decrypt state, tick,
// encrypt and commit what changed. Fails (exitCode 1) only when the user has to act.
export async function runWorker({ dir, key, now, fetch, applyNow = null, stepSummaryPath = null }) {
  const report = async fields => {
    if (stepSummaryPath) await appendFile(stepSummaryPath, stepSummary({ now, ...fields }));
  };
  const path = name => join(dir, FILES[name]);
  let state, rules;
  try {
    const read = name => readFile(path(name), 'utf8').catch(() => { throw new BrokenState(`${name}_missing`); });
    state = openState(await read('state'), key);
    rules = readRules(await read('rules'));
  } catch (error) {
    if (!(error instanceof BrokenState)) throw error;
    await report({ outcome: 'broken_state', reason: error.reason });
    return { outcome: 'broken_state', reason: error.reason, exitCode: 1 };
  }

  let saved = comparable(state);
  const writeState = next => writeFile(path('state'), sealState(next, key));
  const persist = async next => {
    await writeState(next);
    await commit(dir, [FILES.state], 'Save worker state');
    saved = comparable(next);
  };
  try {
    const result = await tick({ state, rules, now, fetch, applyNow, persist });
    const summary = openSummary({ state: result.state, rules });
    const summaryText = `${JSON.stringify(summary, null, 2)}\n`;
    const previousSummary = await readFile(path('summary'), 'utf8').catch(() => null);
    const changed = [];
    if (comparable(result.state) !== saved) {
      await writeState(result.state);
      changed.push(FILES.state);
    }
    // Before the first successful read there is nothing true to publish.
    if (result.state.observed && summaryText !== previousSummary) {
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
