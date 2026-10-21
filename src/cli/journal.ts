// The worker journal (CONTEXT.md, «Журнал воркера») as the CLI reads it: one list of entries
// for both platforms, each saying when the run started, what started it, how it ended and how
// long it took. On Google the ring buffer comes with one `doPost status`; on GitHub the entries
// are built from what the Actions runs API lists and what the worker publishes in each run's
// job log (runLine, the outcome `status` reads too). How long the platform took to answer the
// poll comes back with the entries; the screen of the worker shows it as its live line.
import type { WorkflowRun } from '../github/api.ts';
import type { RunOutcome } from '../worker/run.ts';
import type { WouldApply } from '../worker/tick.ts';
import type { JournalEntry as RingEntry, RunKind } from '../apps-script/worker.ts';
import type { Worker, GoogleWorker, GitHubWorker } from './active-worker.ts';
import { loggedOutcome, WORKFLOW_FILE } from './common.ts';
import type { Logged } from './common.ts';

export type JournalKind = RunKind;
export interface JournalEntry {
  // ISO time the run started.
  at: string;
  kind: JournalKind;
  // null while the run is not finished or its outcome does not read.
  outcome: RunOutcome | null;
  durationMs: number;
  reason?: string;
  // What the rules would apply, for a trial run that found a reset for them.
  wouldApply?: WouldApply;
}

// The entries, oldest first as the ring buffer on Google keeps them, with the time of the poll.
export interface Journal { entries: JournalEntry[]; readAt: number; responseMs: number }

export interface JournalOptions { now?: () => number }

export async function readJournal(worker: Worker, { now = Date.now }: JournalOptions = {}): Promise<Journal> {
  return worker.platform === 'google' ? readGoogle(worker, now) : readGitHub(worker, now);
}

// One doPost status carries the whole ring buffer; the time it took is the poll's response time.
async function readGoogle(worker: GoogleWorker, now: () => number): Promise<Journal> {
  const readAt = now();
  const status = await worker.status();
  const responseMs = now() - readAt;
  const read = Array.isArray(status.journal) ? status.journal as RingEntry[] : [];
  const entries = read.map(({ at, kind, outcome, durationMs, reason, wouldApply }) =>
    ({ at, kind, outcome, durationMs, ...(reason !== undefined ? { reason } : {}), ...(wouldApply ? { wouldApply } : {}) }));
  return { entries, readAt, responseMs };
}

// The kind of a run by its event and its title: the workflow names each run (run-name), and the
// title of a dispatch names what started it. A run of an older workflow, titled with its commit
// message, reads as a dispatch from this Mac. null is a run that is no worker run: `uninstall`'s
// revoke, which the worker on Google journals no more than its own revoke.
function kindOf(run: WorkflowRun): JournalKind | null {
  if (run.event === 'schedule') return 'scheduled';
  if (run.display_title.startsWith('Apply now')) return 'apply_now';
  if (run.display_title === 'Trial run') return 'trial';
  if (run.display_title === 'Revoke session') return null;
  return 'mac';
}

// What the job log of a completed run gave, by the run's id, for as long as one worker stays
// open: the screen polls one worker, and the outcome of a run that completed no longer changes,
// so the later polls read the logs of new runs only. A log that did not read (null) is kept out
// — the next poll reads it again.
const logsRead = new WeakMap<GitHubWorker, Map<number, Logged | null>>();

// The outcome a completed run published in its job log: read from GitHub once, then from what
// that read gave for as long as the same worker is open.
async function loggedOnce(worker: GitHubWorker, id: number): Promise<Logged | null> {
  const { api, repo } = worker;
  const read = logsRead.get(worker) ?? new Map();
  logsRead.set(worker, read);
  const logged = read.get(id);
  if (logged !== undefined) return logged;
  const log = await api.runLog(repo.full_name, id).catch(() => null);
  if (log === null) return null;
  const outcome = loggedOutcome(log);
  read.set(id, outcome);
  return outcome;
}

// On GitHub the journal is what the Actions runs API lists, as many entries as the ring buffer
// on Google keeps, each with the outcome the worker published in the run's job log. The listing
// is the poll; reading the logs of the listed runs is not part of its response time. The log of
// a completed run is read once per open worker, of a run still going on every poll until it
// completes.
async function readGitHub(worker: GitHubWorker, now: () => number): Promise<Journal> {
  const { api, repo } = worker;
  const name = repo.full_name;
  const readAt = now();
  const runs = await api.runs(name, WORKFLOW_FILE);
  const responseMs = now() - readAt;
  const entries = (await Promise.all(runs.map(async run => {
    const kind = kindOf(run);
    if (!kind) return null;
    const logged = run.status === 'completed' ? await loggedOnce(worker, run.id) : null;
    const at = run.run_started_at || run.created_at;
    return { at, kind, outcome: logged?.outcome ?? null,
      durationMs: Math.max(0, Date.parse(run.updated_at) - Date.parse(at)),
      ...(logged?.reason ? { reason: logged.reason } : {}), ...(logged?.wouldApply ? { wouldApply: logged.wouldApply } : {}) } satisfies JournalEntry;
  }))).filter((entry): entry is JournalEntry => entry !== null);
  return { entries: entries.reverse(), readAt, responseMs };
}
