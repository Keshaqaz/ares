import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { privateWorkflowFixture, PROGRAM_COMMIT, confirmedTimer } from './support/private-workflow-fixture.mjs';
import { syntheticGrant } from './support/auth-fixture.mjs';
import { sealAdmin, runInstallerAdmin } from '../src/installer/installer-admin.mjs';
import { readGitHubQuota } from '../src/github/github-quota.mjs';
import { Installer } from '../src/installer/installer.mjs';
import { TerminalUI, promptQuotaSetup } from '../src/installer/installer-ui.mjs';
import { validateState } from '../src/core/state-store.mjs';
import { renderTimerPlan } from '../src/github/github-schedule.mjs';

async function fixture(t) {
  const f = await privateWorkflowFixture(t); let sequence = 0;
  f.policy = { schema: 1, repository: 'synthetic/private', budget: 0, stopUsage: true, verifiedAt: f.clock, plan: 'free' };
  f.variable = null; f.billingSecret = 'synthetic-old-billing-token'; f.writes = [];
  const original = f.github.storage.fetch;
  f.github.storage.fetch = async (url, options) => {
    const path = new URL(url).pathname.slice('/repos/synthetic/private'.length);
    const body = options.body ? JSON.parse(options.body) : null;
    if (path.startsWith('/actions/variables')) {
      if (f.failQuota === 'permission') return new Response(null, { status: 403 });
      if (options.method === 'GET') return f.variable ? Response.json({ value: f.variable }) : new Response(null, { status: 404 });
      if (options.method === 'DELETE') { f.variable = null; return new Response(null, { status: 204 }); }
      f.variable = body.value; f.writes.push(options.method);
      if (f.failQuota === 'lost-variable') throw new Error('sensitive detail');
      return options.method === 'POST' ? Response.json({}, { status: 201 }) : new Response(null, { status: 204 });
    }
    // Only the ticket 40 migration touches the billing Secret left by an older program.
    if (path === '/actions/secrets/AUTO_RESET_BILLING_TOKEN') {
      if (options.method !== 'DELETE') throw new Error('unexpected billing Secret write');
      const status = f.billingSecret ? 204 : 404; f.billingSecret = null; f.writes.push('delete-billing');
      return new Response(null, { status });
    }
    if (path === '/actions/secrets/AUTO_RESET_GITHUB_TOKEN' && options.method === 'DELETE') return new Response(null, { status: 204 });
    if (path === '/actions/runs') return Response.json({ total_count: 1, workflow_runs: [{ id: 1,
      path: '.github/workflows/auto-reset.yml', status: 'in_progress',
      created_at: new Date(f.clock * 1000).toISOString(), updated_at: new Date(f.clock * 1000).toISOString() }] });
    if (path === '/actions/runs/1/jobs') return Response.json({ total_count: 0, jobs: [] });
    return original(url, options);
  };
  f.billingFetch = async (url, options) => {
    // Billing answers the installation token itself (ADR-0003).
    if (f.failQuota === 'billing' || options.headers.authorization !== `Bearer ${syntheticGrant}`) return new Response(null, { status: 403 });
    return Response.json(url.endsWith('/user') ? { login: f.owner ?? 'synthetic', plan: { name: 'free' } } :
      { user: 'synthetic', timePeriod: { year: new Date(f.clock * 1000).getUTCFullYear(), month: new Date(f.clock * 1000).getUTCMonth() + 1 },
        usageItems: [{ product: 'Actions', sku: 'actions_linux', unitType: 'minutes', grossQuantity: 0, discountQuantity: 0,
          netQuantity: 0, grossAmount: 0, discountAmount: 0, netAmount: f.paid ?? 0 }] },
      { headers: { date: new Date(f.clock * 1000).toUTCString() } });
  };
  f.provider = () => readGitHubQuota({ storage: f.github.storage,
    policy: f.variable, runId: '1', now: () => f.clock, fetchImpl: f.billingFetch });
  f.command = (action, payload = {}) => sealAdmin('synthetic/private', syntheticGrant,
    { action, commandId: `quota-${++sequence}`, expectedVersion: f.github.state.version }, payload);
  f.admin = (command, extra = {}) => f.actions.writer(() => runInstallerAdmin({ storage: f.github.storage,
    workflow: f.workflow, serialization: f.serialization, command, grant: syntheticGrant,
    programCommit: PROGRAM_COMMIT, runId: '1', billingFetch: f.billingFetch, now: () => f.clock, ...extra }));
  await f.admin(f.command('pause'));
  f.setup = () => f.command('configure-quota', { policy: f.policy });
  f.check = () => f.admin(f.command('check-quota'), { quotaProvider: f.provider, quotaPolicy: f.variable });
  return f;
}

test('quota setup publishes only the policy; a subsequent job reads billing with the installation token', async t => {
  const f = await fixture(t), command = f.setup(), history = structuredClone(f.github.state.requests);
  await f.admin(command);
  assert.deepEqual(f.writes, ['POST']); // No billing Secret: the workflow passes none (ticket 40).
  assert.equal(f.variable, JSON.stringify(f.policy));
  assert.equal(f.github.state.installation.quota.verified, false);
  await assert.rejects(f.admin(f.command('enable')), /quota_setup_check_required/);
  await f.check(); assert.equal(f.github.state.installation.quota.verified, true);
  assert.equal(f.github.state.disabled, true); assert.deepEqual(f.schedule.expressions(), []);
  assert.deepEqual(f.github.state.requests, history); assert.equal(f.calls().length, 0);
  assert.ok(!JSON.stringify(f.github.state).includes(syntheticGrant));
  const n = f.writes.length; await f.admin(command); assert.equal(f.writes.length, n);
  // A second setup invalidates the prior verification, even for the same policy.
  await f.admin(f.setup()); assert.equal(f.github.state.installation.quota.verified, false);
});

test('exact Resume recovers a lost Variable write with no account work', async t => {
  const f = await fixture(t), command = f.setup(); f.failQuota = 'lost-variable';
  await assert.rejects(f.admin(command), /storage_unconfirmed/);
  assert.equal(f.github.state.installation.operation.phase, 'pending');
  assert.equal(f.github.state.disabled, true);
  const stopped = await f.actions.writer(() => f.job());
  assert.equal(stopped.problem, 'admin_recovery_required');
  await assert.rejects(f.admin(f.command('check-quota')), /admin_recovery_required/);
  f.failQuota = null; await f.admin(command); await f.check();
  assert.equal(f.github.state.installation.operation.phase, 'done');
  assert.equal(f.github.state.commands.filter(c => c.commandId === command.commandId).length, 1);
  assert.equal(f.writes.filter(x => x === 'POST').length, 1); assert.equal(f.calls().length, 0);
});

for (const [name, mutate, kind] of [
  ['missing Variables permission', f => { f.failQuota = 'permission'; }, 'stop_grant'],
  ['unavailable billing', f => { f.failQuota = 'billing'; }, 'billing_unavailable'],
  ['different owner', f => { f.owner = 'someone'; }, 'billing_owner_mismatch'],
  ['budget not confirmed', f => { f.policy.stopUsage = false; }, 'billing_policy_invalid'],
  ['plan mismatch', f => { f.policy.plan = 'pro'; }, 'billing_policy_conflict'],
  ['future confirmation', f => { f.policy.verifiedAt++; }, 'billing_policy_invalid'],
  ['separate billing token from an older installer', f => { f.setup = () => f.command('configure-quota', { billingToken: 'synthetic-billing', policy: f.policy }); }, 'billing_policy_invalid'],
]) test(`quota setup rejects ${name} before policy publication`, async t => {
  const f = await fixture(t); mutate(f);
  await assert.rejects(f.admin(f.setup()), error => error.kind === kind);
  assert.deepEqual(f.writes, []); assert.equal(f.variable, null);
  assert.equal(f.github.state.installation.operation.phase, 'done');
});

test('quota verification rejects stale receipt, propagated policy mismatch and a token without billing', async t => {
  const f = await fixture(t); await f.admin(f.setup());
  await assert.rejects(f.admin(f.command('check-quota'), { quotaProvider: async () => ({ observedAt: f.clock - 301, quota: f.quota }),
    quotaPolicy: f.variable }), /quota_unavailable/);
  await assert.rejects(f.admin(f.command('check-quota'), { quotaProvider: f.provider, quotaPolicy: '{}' }), /quota_setup_check_required/);
  await f.check();
  f.failQuota = 'billing'; await assert.rejects(f.check(), /billing_unavailable/);
  assert.equal(f.github.state.installation.quota.verified, false);
});

test('uninstall removes the billing policy even without a current provider', async t => {
  const f = await fixture(t); await f.admin(f.setup());
  await f.admin(f.command('uninstall'));
  assert.equal(f.variable, null); assert.ok(!f.writes.includes('delete-billing'));
  assert.equal(f.github.state.installation.quota, null); assert.equal(f.github.state.revoked, true);
});

test('active installation and leftover cron reject quota changes; state rejects hidden credentials', async t => {
  const f = await fixture(t);
  await f.actions.writer(() => f.github.storage.update(v => { v.disabled = false; }));
  await assert.rejects(f.admin(f.setup()), /pause_before_quota_setup/);
  assert.deepEqual(f.writes, []);
  await f.admin(f.command('pause'));
  const original = f.schedule.plan;
  f.schedule.plan = renderTimerPlan(['0 0,4,8,12,16,20 * * *']);
  await assert.rejects(f.admin(f.setup()), /schedule_cleanup_unconfirmed/);
  assert.deepEqual(f.writes, []);
  f.schedule.plan = original; await f.admin(f.setup());
  const s = structuredClone(f.github.state);
  s.installation.quota.token = 'synthetic-credential';
  assert.throws(() => validateState(s), /invalid_state/);
  delete s.installation.quota.token; s.installation.quota.verified = true;
  assert.throws(() => validateState(s), /invalid_state/);
});

test('changed policy updates the variable and invalidates verification; provider failure cannot enable with manual data', async t => {
  const f = await fixture(t); await f.admin(f.setup()); await f.check();
  f.policy.verifiedAt++; f.clock++;
  await f.admin(f.setup()); assert.ok(f.writes.includes('PATCH'));
  await f.check();
  await assert.rejects(f.admin(f.command('check-quota'), { quotaProvider: f.provider, quotaPolicy: '{}' }), /quota_setup_check_required/);
  assert.equal(f.github.state.installation.quota.verified, false);
  await f.check();
  // Reach the existing connection guard with a synthetic ready setup, without account calls.
  await f.actions.writer(() => f.github.storage.update(v => {
    v.installation.checkedSession = v.auth.committed.sessionId; v.installation.timer = confirmedTimer(f.clock);
  }));
  f.failQuota = 'billing';
  await assert.rejects(f.admin(f.command('enable', { evidence: { clientPath: true, costPolicy: true, persistence: true },
    quotaReceipt: { observedAt: f.clock, quota: f.quota } }),
  { pilotApproved: true, quotaProvider: f.provider, quotaPolicy: f.variable }), /billing_unavailable/);
  assert.equal(f.github.state.disabled, true); assert.equal(f.calls().length, 0);
});

test('local installer persists only encrypted quota input and refuses enable before verification', async t => {
  const root = await mkdtemp(join(tmpdir(), 'installer-quota-')); t.after(() => rm(root, { recursive: true, force: true }));
  const state = { version: 1, disabled: true, commands: [], installation: {} }; let dispatched;
  const installer = new Installer({ platform: 'darwin', journalPath: join(root, 'journal.json'),
    github: { repository: 'synthetic/private', token: syntheticGrant, status: async () => state,
      dispatch: async c => { dispatched = c; return { state: 'unconfirmed' }; } } });
  await assert.rejects(installer.enable({}), /quota_setup_check_required/);
  await installer.configureQuota({ plan: 'free' });
  assert.equal(dispatched.action, 'configure-quota');
  assert.ok(!(await readFile(installer.journalPath, 'utf8')).includes('"plan"')); // Only the sealed envelope.
  const command = JSON.stringify(dispatched); await installer.resume(); assert.equal(JSON.stringify(dispatched), command);
});

for (const language of ['ru', 'en']) test(`${language} quota screen asks for the budget and plan only, no token`, async () => {
  const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', b => { text += b; }); const ui = new TerminalUI({ input, output }); ui.language = language;
  input.end('YES\nfree\n');
  const p = await promptQuotaSetup(ui, 'synthetic/private', () => 100); ui.close();
  assert.deepEqual(p, { policy: { schema: 1, repository: 'synthetic/private', budget: 0, stopUsage: true, verifiedAt: 100, plan: 'free' } });
  assert.ok(text.includes('Stop usage')); assert.ok(text.includes('Plan: read'));
  assert.ok(!/fine-grained|Account permissions/.test(text));
});

test('declined budget confirmation dispatches nothing', async () => {
  const labels = [];
  assert.equal(await promptQuotaSetup({ language: 'en', text: () => {}, ask: async label => { labels.push(label); return 'NO'; } },
    'synthetic/private'), null);
  assert.equal(labels.length, 1);
});

test('Upgrade migration: the first admin command removes the billing Secret once and requires b again', async t => {
  const f = await fixture(t); await f.admin(f.setup()); await f.check();
  // State written by a program before ticket 40: no grant, quota verified with the separate token.
  await f.actions.writer(() => f.github.storage.update(v => { delete v.installation.grant; }));
  assert.equal(f.github.state.installation.quota.verified, true);
  await f.admin(f.command('pause'));
  assert.equal(f.billingSecret, null); assert.deepEqual(f.writes.filter(x => x === 'delete-billing'), ['delete-billing']);
  assert.equal(f.github.state.installation.grant, null);
  assert.deepEqual(f.github.state.installation.quota, { policy: f.policy, verified: false });
  await f.admin(f.command('pause')); assert.deepEqual(f.writes.filter(x => x === 'delete-billing'), ['delete-billing']);
  await f.actions.writer(() => f.github.storage.update(v => {
    v.installation.checkedSession = v.auth.committed.sessionId; v.installation.timer = confirmedTimer(f.clock);
  }));
  await assert.rejects(f.admin(f.command('enable', { evidence: { clientPath: true, costPolicy: true, persistence: true } }),
    { pilotApproved: true, quotaProvider: f.provider, quotaPolicy: f.variable }), /quota_setup_check_required/);
  await f.check(); assert.equal(f.github.state.installation.quota.verified, true);
});

test('Upgrade migration runs inside the command that meets it: b after Upgrade migrates and verifies', async t => {
  const f = await fixture(t); await f.admin(f.setup()); await f.check();
  await f.actions.writer(() => f.github.storage.update(v => { delete v.installation.grant; }));
  await f.check();
  assert.equal(f.billingSecret, null); assert.equal(f.github.state.installation.grant, null);
  assert.equal(f.github.state.installation.quota.verified, true);
});
