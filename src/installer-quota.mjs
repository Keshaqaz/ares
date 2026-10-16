import { readGitHubQuota } from './github-quota.mjs';
import { readQuotaReceipt } from './private-job.mjs';
import { StateFailure } from './state-store.mjs';

const fail = kind => { throw new StateFailure(kind); };
const variable = '/actions/variables/AUTO_RESET_BILLING_POLICY';
async function readPolicy(storage) {
  try { return await storage.api(variable); }
  catch (error) { if (error.kind === 'storage_missing') return null; throw error; }
}

// Runs under the installation writer. The encrypted command retains the exact policy across
// interrupted publication. Billing is read with the installation token (ADR-0003): no credential.
export async function configureQuota({ storage, workflow, payload, runId, fetchImpl, now }) {
  await storage.assertOwner();
  const s = await storage.read();
  if (!s.disabled) fail('pause_before_quota_setup');
  const policy = payload.policy;
  if (Object.keys(payload).some(k => k !== 'policy') ||
      !policy || Object.keys(policy).some(k => !['schema', 'repository', 'budget', 'stopUsage', 'verifiedAt', 'plan'].includes(k)) ||
      !Number.isSafeInteger(policy.verifiedAt) || policy.verifiedAt < 0) fail('billing_policy_invalid');
  const published = await workflow.read();
  if (published.expressions.length) fail('schedule_cleanup_unconfirmed');
  const receipt = await readGitHubQuota({ storage, policy: JSON.stringify(policy), runId, now, fetchImpl });
  if (!readQuotaReceipt(JSON.stringify(receipt), now())) fail('quota_unavailable');
  // Check Variables access before touching the existing policy.
  await readPolicy(storage);
  await storage.update(v => {
    v.installation.operation.quotaPublication = true;
    v.installation.quota = { policy, verified: false };
  });
  const existing = await readPolicy(storage), value = JSON.stringify(policy);
  if (existing?.value !== value) {
    await storage.api(existing ? variable : '/actions/variables', {
      method: existing ? 'PATCH' : 'POST', statuses: existing ? [204] : [201],
      body: { name: 'AUTO_RESET_BILLING_POLICY', value },
    });
  }
  if ((await readPolicy(storage))?.value !== value) fail('billing_policy_publication_unconfirmed');
  // A Variable write cannot prove what a subsequent job receives.
  // check-quota in a new job is required before enabling this configuration.
}

// Ticket 40 migration, run by the first admin command of a program with one installation token:
// the separate billing Secret is removed and a check made with it no longer counts (b again).
// State written before 40 is recognised by the absent grant. Returns whether state changed.
export async function migrateBillingToken(storage) {
  const s = await storage.read();
  if (!s.installation || s.installation.grant !== undefined) return false;
  await storage.api('/actions/secrets/AUTO_RESET_BILLING_TOKEN', { method: 'DELETE', statuses: [204, 404] });
  await storage.update(v => {
    v.installation.grant = null;
    if (v.installation.quota) { v.installation.quota.verified = false; delete v.installation.quota.checkedAt; }
  });
  return true;
}

export async function verifyQuota({ storage, quotaProvider, quotaPolicy, now }) {
  await storage.assertOwner();
  const s = await storage.read();
  if (!s.disabled) fail('pause_before_quota_setup');
  if (s.installation.quota) await storage.update(v => { v.installation.quota.verified = false; });
  if (!s.installation.quota || !quotaProvider ||
      JSON.stringify(s.installation.quota.policy) !== quotaPolicy ||
      (await readPolicy(storage))?.value !== quotaPolicy) fail('quota_setup_check_required');
  const receipt = await quotaProvider();
  if (!readQuotaReceipt(JSON.stringify(receipt), now())) fail('quota_unavailable');
  await storage.update(v => {
    v.installation.quota.verified = true;
    v.installation.quota.checkedAt = now();
  });
}
