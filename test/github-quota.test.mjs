import test from 'node:test';
import assert from 'node:assert/strict';
import { readGitHubQuota } from '../src/github-quota.mjs';

const NOW = Date.UTC(2026, 9, 9, 3) / 1000;
const iso = seconds => new Date(seconds * 1000).toISOString();
const run = (id, extra = {}) => ({ id, path: '.github/workflows/auto-reset.yml', status: 'completed',
  created_at: iso(NOW - 100), updated_at: iso(NOW - 10), ...extra });
const job = (id, run_id, extra = {}) => ({ id, run_id, status: 'completed', conclusion: 'success',
  started_at: iso(NOW - 62), completed_at: iso(NOW - 1), labels: ['ubuntu-24.04'], ...extra });
function fixture() {
  const f = { now: NOW, runs: [run(1), run(2, { status: 'in_progress' })], jobs: new Map([
    [1, [job(11, 1)]], [2, [job(21, 2, { status: 'in_progress', completed_at: null })]]]),
    policy: { schema: 1, repository: 'synthetic/private', budget: 0, stopUsage: true, verifiedAt: NOW - 10, plan: 'free' },
    calls: [], reported: 32, paid: 0 };
  f.read = () => readGitHubQuota({ storage: { repository: 'synthetic/private', api: async path => {
    f.calls.push(path); const u = new URL(path, 'https://synthetic.invalid');
    const rows = u.pathname === '/actions/runs' ? f.runs : f.jobs.get(Number(u.pathname.split('/')[3])) ?? [];
    const key = u.pathname === '/actions/runs' ? 'workflow_runs' : 'jobs';
    const page = Number(u.searchParams.get('page'));
    return { total_count: f.total ?? rows.length, [key]: rows.slice((page - 1) * 100, page * 100) };
  } }, billingToken: 'synthetic-token', policy: JSON.stringify(f.policy), runId: '2', now: () => f.now,
  fetchImpl: async url => Response.json(url.endsWith('/user') ? { login: 'synthetic', plan: { name: 'free' } } :
    { user: 'synthetic', timePeriod: { year: 2026, month: 10 }, usageItems: [{ product: 'Actions', sku: 'actions_linux', unitType: 'minutes',
      grossQuantity: f.reported, discountQuantity: f.reported, netQuantity: 0, grossAmount: 1, discountAmount: 1 - f.paid, netAmount: f.paid }] },
    { headers: { date: iso(NOW) } }) });
  return f;
}

test('quota adds billing and rounded service attempts plus current timeout; future months retain queue reservation', async () => {
  const f = fixture(); const receipt = await f.read();
  assert.equal(receipt.quota.periods[0].usedMinutes, 44); // 32 reported +2 completed +10 in progress
  assert.equal(receipt.quota.periods[0].providerRemainingMinutes, 1956);
  assert.equal(receipt.quota.periods[1].usedMinutes, 10);
  assert.equal(receipt.quota.queuedJobs, 0); assert.equal(receipt.evidence.outstandingMinutes, 10);
  assert.ok(f.calls.some(x => x.includes('filter=all')));
  assert.ok(receipt.quota.periods.every(p => p.paidUsageBlocked));
});

test('rerun of earlier-month run and all job attempts count; queued run without jobs still costs one timeout', async () => {
  const f = fixture(); f.runs[0].created_at = iso(NOW - 40 * 86400);
  f.jobs.get(1).push(job(12, 1)); f.jobs.set(2, []);
  const receipt = await f.read(); assert.equal(receipt.evidence.completedMinutes, 4);
  assert.equal(receipt.evidence.outstandingMinutes, 10);
});

test('full run history pagination does not truncate a recent rerun on an old page', async () => {
  const f = fixture();
  f.runs.push(...Array.from({ length: 100 }, (_, i) => run(i + 3, { created_at: iso(NOW - 60 * 86400), updated_at: iso(NOW - 50 * 86400) })));
  await f.read(); assert.ok(f.calls.includes('/actions/runs?per_page=100&page=2'));
});

for (const [name, mutate, kind] of [
  ['budget not confirmed', f => { f.policy.stopUsage = false; }, 'billing_policy_invalid'],
  ['repository mismatch', f => { f.policy.repository = 'synthetic/other'; }, 'billing_policy_invalid'],
  ['paid amount', f => { f.paid = 0.1; }, 'billing_policy_conflict'],
  ['incomplete pagination', f => { f.total = 3; }, 'quota_history_incomplete'],
  ['missing current run', f => { f.runs.pop(); }, 'quota_current_job_missing'],
  ['duplicate run', f => { f.runs.push(f.runs[0]); }, 'quota_history_invalid'],
  ['unsupported pending workflow', f => { f.runs[1].path = '.github/workflows/other.yml'; }, 'quota_workflow_unsupported'],
  ['completed timestamp missing', f => { f.jobs.get(1)[0].completed_at = null; }, 'quota_history_invalid'],
  ['other runner', f => { f.jobs.get(1)[0].labels = ['macos-latest']; }, 'quota_runner_unsupported'],
]) test(`quota ${name} stops admission`, async () => {
  const f = fixture(); mutate(f); await assert.rejects(f.read(), error => error.kind === kind);
});
