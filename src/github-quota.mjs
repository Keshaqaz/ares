import { GitHubBilling } from './github-billing.mjs';
import { StateFailure } from './state-store.mjs';

const fail = kind => { throw new StateFailure(kind); };
const time = value => {
  const at = Date.parse(value) / 1000;
  if (typeof value !== 'string' || !Number.isSafeInteger(at)) fail('quota_history_invalid');
  return at;
};
const id = value => Number.isSafeInteger(value) && value > 0;

// The hard-stop budget is a user-confirmed installation setting, not a billing
// API fact. The installation token (Plan: read, ADR-0003) reads billing and all
// workflow/job attempts for this dedicated installation.
export async function readGitHubQuota({ storage, billingToken = storage.token, policy: rawPolicy, runId = null,
  now = () => Math.floor(Date.now() / 1000), fetchImpl = fetch }) {
  let policy;
  try { policy = JSON.parse(rawPolicy); } catch { fail('billing_policy_required'); }
  const owner = storage.repository.split('/')[0];
  if (policy?.schema !== 1 || policy.repository !== storage.repository || policy.budget !== 0 ||
      policy.stopUsage !== true || !Number.isSafeInteger(policy.verifiedAt) || policy.verifiedAt > now() ||
      !['free', 'pro'].includes(policy.plan)) fail('billing_policy_invalid');
  const billing = await new GitHubBilling({ owner, token: billingToken, now, fetchImpl }).read();
  if (billing.plan !== policy.plan || billing.unsupportedSkus.length || billing.reportedPaidActionsAmount !== 0) {
    fail('billing_policy_conflict');
  }
  const paginate = async (path, key) => {
    const items = []; let total;
    for (let page = 1; page <= 100; page++) {
      const response = await storage.api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Number.isSafeInteger(response?.total_count) || response.total_count < 0 || response.total_count > 10_000 ||
          !Array.isArray(response[key]) || response[key].length > 100 ||
          total !== undefined && total !== response.total_count) fail('quota_history_incomplete');
      total = response.total_count; items.push(...response[key]);
      if (items.length === total) return items;
      if (items.length > total || response[key].length !== 100) fail('quota_history_incomplete');
    }
    fail('quota_history_incomplete');
  };
  const runs = await paginate('/actions/runs', 'workflow_runs');
  const runIds = new Set();
  for (const run of runs) {
    if (!id(run.id) || runIds.has(run.id) || typeof run.status !== 'string') fail('quota_history_invalid');
    if (run.status !== 'completed' && run.path !== '.github/workflows/auto-reset.yml') fail('quota_workflow_unsupported');
    runIds.add(run.id);
    time(run.updated_at); time(run.created_at);
  }
  if (runId !== null && (!/^\d+$/.test(runId) || !runIds.has(Number(runId)))) fail('quota_current_job_missing');
  // updated_at includes reruns of runs created in earlier months. Do not filter
  // the run list by created_at, or their unreported cost could disappear.
  const relevant = runs.filter(r => r.status !== 'completed' || time(r.updated_at) >= billing.period.start);
  const jobs = [];
  for (let offset = 0; offset < relevant.length; offset += 8) {
    const results = await Promise.allSettled(relevant.slice(offset, offset + 8).map(r =>
      paginate(`/actions/runs/${r.id}/jobs?filter=all`, 'jobs')));
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      jobs.push(...result.value);
    }
  }
  let completedMinutes = 0, outstandingMinutes = 0;
  const jobIds = new Set();
  for (const job of jobs) {
    if (!id(job.id) || jobIds.has(job.id)) fail('quota_history_invalid');
    jobIds.add(job.id);
    if (job.status !== 'completed') {
      if (!['queued', 'waiting', 'pending', 'in_progress', 'requested'].includes(job.status)) fail('quota_history_invalid');
      outstandingMinutes += 10; // Includes current setup/job, not just future queue.
      continue;
    }
    if (job.started_at === null && ['skipped', 'cancelled'].includes(job.conclusion)) continue;
    const start = time(job.started_at), end = time(job.completed_at);
    if (end < start || end > now()) fail('quota_history_invalid');
    if (end <= billing.period.start || start >= billing.period.end) continue;
    if (!Array.isArray(job.labels) || !job.labels.some(label => /^ubuntu(?:-|$)/.test(label) || label === 'Linux') ||
        job.labels.some(label => /^(?:windows|macos)/i.test(label))) fail('quota_runner_unsupported');
    completedMinutes += Math.ceil((end - start) / 60);
  }
  if (relevant.some(r => r.status !== 'completed' && !jobs.some(j => j.run_id === r.id && j.status !== 'completed'))) {
    // A queued workflow may not yet have materialized jobs. Reserve one timeout.
    outstandingMinutes += relevant.filter(r => r.status !== 'completed' &&
      !jobs.some(j => j.run_id === r.id && j.status !== 'completed')).length * 10;
  }
  // Intentionally additive: billing may lag without a coverage watermark. Charge
  // all completed installation jobs again rather than treating max(A,B) as a
  // proof that unreported jobs or other repositories were included.
  const usedMinutes = billing.reportedLinuxMinutes + completedMinutes + outstandingMinutes;
  if (!Number.isSafeInteger(usedMinutes)) fail('quota_history_invalid');
  const includedMinutes = policy.plan === 'free' ? 2000 : 3000;
  const periods = [];
  let start = billing.period.start;
  const horizon = now() + 365 * 86400;
  while (start <= horizon) {
    const date = new Date(start * 1000), end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000;
    const used = start === billing.period.start ? usedMinutes : outstandingMinutes;
    periods.push({ start, end, usedMinutes: used, providerRemainingMinutes: Math.max(0, includedMinutes - used), paidUsageBlocked: true });
    start = end;
  }
  if (now() - billing.observedAt > 300 || now() >= billing.period.end) fail('quota_observation_expired');
  return { observedAt: billing.observedAt,
    quota: { periods, queuedJobs: 0, cleanupDelaySeconds: 600 },
    evidence: { completedMinutes, outstandingMinutes, reportedLinuxMinutes: billing.reportedLinuxMinutes,
      runCount: runs.length, jobCount: jobs.length, budgetSource: 'confirmed_installation_setting' } };
}
