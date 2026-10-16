import { StateFailure } from '../core/state-store.mjs';
import { TIMER_PLAN_PATH, readManagedSchedule, readTimerPlan, renderTimerPlan } from '../schedule/managed-schedule.mjs';

export { TIMER_PLAN_PATH, readManagedSchedule, readTimerPlan, renderTimerPlan };
const fail = kind => { throw new StateFailure(kind); };

// A file on the current default branch of the private repository; null content when absent.
export async function readDefaultBranchFile(storage, path) {
  await storage.assertOwner();
  const repo = await storage.api('');
  if (repo.private !== true || repo.full_name?.toLowerCase() !== storage.repository.toLowerCase()) fail('private_repository_required');
  if (typeof repo.default_branch !== 'string' || !repo.default_branch || repo.default_branch.length > 256) fail('default_branch_unavailable');
  const branch = repo.default_branch;
  let file;
  try { file = await storage.api(`/contents/${path}?ref=${encodeURIComponent(branch)}`); }
  catch (error) { if (error.kind === 'storage_missing') return { branch, sha: null, content: null }; throw error; }
  if (file?.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' ||
    !/^[a-f0-9]{40,64}$/.test(file.sha ?? '') || file.content.length > 2 * 1024 * 1024) fail('invalid_repository_file');
  return { branch, sha: file.sha, content: Buffer.from(file.content, 'base64').toString('utf8') };
}

// Reuses the single PAT/serialized API transport. Publishes the timer plan (ADR-0002), not
// workflow cron: daily work needs Contents: write only, and the Worker reads the same file.
// An absent plan is an empty one; its creation is conditional like any other PUT.
export class GitHubScheduleWriter {
  constructor(storage) { this.storage = storage; this.path = TIMER_PLAN_PATH; }
  async read() {
    const file = await readDefaultBranchFile(this.storage, this.path);
    return { ...file, expressions: file.content === null ? [] : readTimerPlan(file.content) };
  }
  async write({ expected, expressions, assertCurrent }) {
    await this.storage.assertOwner();
    const fresh = await this.read();
    if (fresh.branch !== expected.branch || fresh.sha !== expected.sha || fresh.content !== expected.content) fail('workflow_version_conflict');
    const content = renderTimerPlan(expressions);
    await assertCurrent();
    let failure;
    try {
      await this.storage.api(`/contents/${this.path}`, { method: 'PUT', statuses: [200, 201], body: {
        message: 'Reconcile auto-reset timer plan', branch: fresh.branch, ...(fresh.sha ? { sha: fresh.sha } : {}),
        content: Buffer.from(content).toString('base64'),
      } });
    } catch (error) { failure = error; }
    const confirmed = await this.read();
    if (confirmed.branch !== fresh.branch || confirmed.content !== content) throw failure ?? new StateFailure('schedule_write_unconfirmed');
    return confirmed;
  }
}
