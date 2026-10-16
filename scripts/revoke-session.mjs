// FUTURE LIVE DISPATCH ONLY: explicit confirmation string is required. No local CI vault.
import { readFile } from 'node:fs/promises';
import { Installer } from '../src/installer/installer.mjs';
import { InstallerGitHub } from '../src/installer/installer-github.mjs';
import { StateFailure } from '../src/core/state-store.mjs';
import { verifyRevokeRuntime } from '../src/account/observer-dispatch.mjs';
import { validateRevokePlan } from '../src/session/revoke-verifier.mjs';
import { readGitHubQuota } from '../src/github/github-quota.mjs';
import { readQuotaReceipt } from '../src/workflow/private-job.mjs';
import { admitObserverQuota } from '../src/schedule/schedule-planner.mjs';
const pins = JSON.parse(await readFile(new URL('../src/runtime-lock.json', import.meta.url), 'utf8'));
try {
  if (process.version !== `v${pins.node}`) throw new StateFailure('node_version_mismatch');
  if (process.argv.length !== 5 || process.argv[2] !== '--authorized-current-ci-revoke' ||
      !/^\d+$/.test(process.argv[3]) || !['no-refresh-probe', 'one-refresh-probe'].includes(process.argv[4])) {
    throw new StateFailure('explicit_revoke_scope_required');
  }
  const plan = { schema: 1, futureMinutes: Number(process.argv[3]), oldRefresh: process.argv[4] === 'one-refresh-probe',
    ...(process.argv[4] === 'one-refresh-probe' ? { quarantinePublicKey: process.env.AUTO_RESET_QUARANTINE_PUBLIC_KEY } : {}) };
  validateRevokePlan(plan);
  if (!process.env.AUTO_RESET_INSTALLER_JOURNAL) throw new StateFailure('installer_journal_required');
  const github = new InstallerGitHub({ repository: process.env.GITHUB_REPOSITORY, token: process.env.AUTO_RESET_GITHUB_TOKEN });
  const installer = new Installer({ github, journalPath: process.env.AUTO_RESET_INSTALLER_JOURNAL });
  await installer.load();
  const s = await github.status();
  if (!s.disabled || s.revoked || s.auth?.phase !== 'ready' || s.installation?.operation?.phase === 'pending') {
    throw new StateFailure('revoke_requires_disabled');
  }
  await verifyRevokeRuntime(github, s); // Exact published immutable files and workflow, before dispatch.
  const now = () => Math.floor(Date.now() / 1000);
  const receipt = await readGitHubQuota({ storage: github.storage, policy: process.env.AUTO_RESET_BILLING_POLICY, now });
  // Before dispatch this job is future, not yet in provider outstanding reserves.
  const quota = readQuotaReceipt(JSON.stringify(receipt), now());
  admitObserverQuota(quota, now(), plan.futureMinutes + 10);
  if (JSON.stringify(await github.status()) !== JSON.stringify(s) || now() >= quota.validUntil) {
    throw new StateFailure('revoke_preflight_changed');
  }
  const result = await installer.send('revoke-session', plan, s.version);
  process.stdout.write(`${JSON.stringify({ state: result.state ?? 'dispatched' })}\n`);
} catch (error) {
  const kinds = new Set(['node_version_mismatch', 'explicit_revoke_scope_required', 'installer_journal_required',
    'revoke_requires_disabled', 'observer_runtime_not_published', 'resume_pending_command_first']);
  process.stdout.write(`${JSON.stringify({ error: kinds.has(error?.kind) ? error.kind : 'revoke_dispatch_failed' })}\n`);
  process.exitCode = 1;
}
