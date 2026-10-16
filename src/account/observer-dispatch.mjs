import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { StateFailure } from '../core/state-store.mjs';
import { renderPrivateWorkflow, WORKFLOW_PATH } from '../workflow/private-workflow.mjs';

// Older pinned admin code ignores unknown payload fields and may refresh.
// Verify the actual workflow AND its immutable source pin before dispatch.
export async function verifyObserverRuntime(github, state, manifest = null) {
  return verifyRuntime(github, state, manifest, false);
}
export async function verifyRevokeRuntime(github, state) {
  return verifyRuntime(github, state, null, true);
}
async function verifyRuntime(github, state, manifest, revoke) {
  const fail = () => { throw new StateFailure('observer_runtime_not_published'); };
  const pin = state.installation?.programCommit;
  if (!/^[a-f0-9]{40}$/.test(pin ?? '')) fail();
  const paths = ['src/account/check-observer.mjs', 'src/session/host-auth-session.mjs', 'src/installer/installer-admin.mjs',
    'src/workflow/private-cli.mjs', 'src/installer/installer-report.mjs', 'src/schedule/schedule-planner.mjs', 'runtime-lock.json'];
  if (revoke) paths.push('src/session/revoke-verifier.mjs', 'src/session/auth-admin.mjs', 'src/session/host-oauth.mjs',
    'src/session/external-auth-runtime.mjs', 'src/account/stdio.mjs', 'src/session/auth-bundle.mjs', 'src/workflow/private-job.mjs',
    'src/github/github-quota.mjs', 'src/github/github-billing.mjs');
  if (manifest !== null && (manifest?.schema !== 1 || manifest.programCommit !== pin ||
      !manifest.sourceHashes || Object.keys(manifest.sourceHashes).length !== paths.length ||
      paths.some(path => !/^[a-f0-9]{64}$/.test(manifest.sourceHashes[path] ?? '')))) fail();
  const repo = await github.repositoryInfo();
  const workflow = await github.file(WORKFLOW_PATH, repo.default_branch);
  if (workflow.encoding !== 'base64' || Buffer.from(workflow.content, 'base64').toString('utf8') !== await renderPrivateWorkflow(pin)) fail();
  for (const path of paths) {
    const remote = await github.file(path, pin);
    if (remote.encoding !== 'base64') fail();
    const content = Buffer.from(remote.content, 'base64').toString('utf8');
    if (manifest !== null) {
      if (createHash('sha256').update(content).digest('hex') !== manifest.sourceHashes[path]) fail();
    } else if (content !== await readFile(new URL(`../../${path}`, import.meta.url), 'utf8')) fail();
  }
}
