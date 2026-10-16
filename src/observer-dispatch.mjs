import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { StateFailure } from './state-store.mjs';
import { renderPrivateWorkflow, WORKFLOW_PATH } from './private-workflow.mjs';

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
  const paths = ['src/check-observer.mjs', 'src/host-auth-session.mjs', 'src/installer-admin.mjs',
    'src/private-cli.mjs', 'src/installer-report.mjs', 'src/schedule-planner.mjs', 'runtime-lock.json'];
  if (revoke) paths.push('src/revoke-verifier.mjs', 'src/auth-admin.mjs', 'src/host-oauth.mjs',
    'src/external-auth-runtime.mjs', 'src/stdio.mjs', 'src/auth-bundle.mjs', 'src/private-job.mjs',
    'src/github-quota.mjs', 'src/github-billing.mjs');
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
    } else if (content !== await readFile(new URL(`../${path}`, import.meta.url), 'utf8')) fail();
  }
}
