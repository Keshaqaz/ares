import { readFile } from 'node:fs/promises';
import { StateFailure } from './state-store.mjs';

export const WRITER_GROUP = 'auto-reset-installation-writer';
export const WORKFLOW_PATH = '.github/workflows/auto-reset.yml';
export async function renderPrivateWorkflow(programCommit) {
  if (!/^[a-f0-9]{40}$/.test(programCommit ?? '')) throw new StateFailure('pinned_program_commit_required');
  return (await readFile(new URL('../templates/private-auto-reset.yml', import.meta.url), 'utf8'))
    .replaceAll('__PROGRAM_COMMIT__', programCommit);
}

// The job already owns the GitHub concurrency slot. Authenticate that it came
// from the trusted one-writer workflow, rather than trusting an environment flag.
// Local installers must dispatch this workflow; they never acquire this lease.
export async function acquireGitHubWriter({ storage, runId, eventName, ref, programCommit }) {
  if (!/^\d+$/.test(runId ?? '') || !['schedule', 'workflow_dispatch'].includes(eventName)) {
    throw new StateFailure('private_writer_context_required');
  }
  const repo = await storage.api('');
  if (repo.private !== true || repo.full_name?.toLowerCase() !== storage.repository.toLowerCase() ||
      ref !== `refs/heads/${repo.default_branch}`) throw new StateFailure('private_default_branch_required');
  const run = await storage.api(`/actions/runs/${runId}`);
  if (run.status !== 'in_progress' || run.event !== eventName || run.path !== WORKFLOW_PATH ||
      run.head_branch !== repo.default_branch || !/^[a-f0-9]{40}$/.test(run.head_sha ?? '') ||
      run.repository?.full_name?.toLowerCase() !== storage.repository.toLowerCase()) {
    throw new StateFailure('private_writer_context_required');
  }
  const workflow = await storage.api(`/contents/${WORKFLOW_PATH}?ref=${run.head_sha}`);
  if (workflow.type !== 'file' || workflow.encoding !== 'base64' || typeof workflow.content !== 'string' ||
      workflow.content.length > 2 * 1024 * 1024) throw new StateFailure('untrusted_private_workflow');
  // Exact template: windows live in the timer plan, the only cron is the static fallback.
  // A leftover managed cron from an earlier pin is refused before any state or Secret write.
  if (Buffer.from(workflow.content, 'base64').toString('utf8') !== await renderPrivateWorkflow(programCommit)) {
    throw new StateFailure('untrusted_private_workflow');
  }
  let active = true;
  return { assertOwner: () => { if (!active) throw new StateFailure('writer_released'); },
    release: () => { active = false; } };
}

export async function withInstallationWriter(serialization, work) {
  await serialization.assertOwner();
  return work();
}
