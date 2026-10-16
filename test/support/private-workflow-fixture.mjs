import { AsyncLocalStorage } from 'node:async_hooks';
import { hostFixture, NOW } from './host-auth-fixture.mjs';
import { githubFixture } from './github-fixture.mjs';
import { scheduleFixture } from './schedule-fixture.mjs';
import { syntheticGrant } from './auth-fixture.mjs';
import { MockRpc } from './mock-rpc.mjs';
import { credit } from './fake-backend.mjs';
import { HostAuthSession } from '../../src/session/host-auth-session.mjs';
import { HostAccountAdapter } from '../../src/account/host-account.mjs';
import { CycleEngine } from '../../src/core/reset-cycles.mjs';
import { GitHubScheduleWriter } from '../../src/github/github-schedule.mjs';
import { encodeBundle, decodeBundle, AuthFailure } from '../../src/session/auth-bundle.mjs';
import { renderPrivateWorkflow } from '../../src/workflow/private-workflow.mjs';
import { runPrivateJob } from '../../src/workflow/private-job.mjs';

// Enable requires a confirmed external timer (ticket 38); tests of other flows start from one.
// The probe flow itself is exercised by the timer tests; the timer is the app of ticket 42.
export const confirmedTimer = now => ({ appId: 4242, appSlug: 'auto-reset-timer-synthetic', installationId: 2424, probeAt: now - 1800, confirmedAt: now - 1760 });

export const PROGRAM_COMMIT = '1'.repeat(40);
// Deterministic queue/writer model: no promises of dispatch-time order. All
// state/Secret/admin operations must own the same AsyncLocalStorage capability.
export class FakeActions {
  constructor({ queue = 'max' } = {}) {
    this.queue = queue; this.pending = []; this.active = null; this.context = new AsyncLocalStorage();
    this.serialization = { assertOwner: () => {
      if (!this.active || this.context.getStore() !== this.active) throw new AuthFailure('serialized_writer_required');
    } };
  }
  enqueue(task) {
    const run = { task, status: 'pending', result: null };
    if (this.queue === 'single' && this.pending.length) this.pending.shift().status = 'cancelled';
    if (this.pending.length >= (this.queue === 'max' ? 100 : 1)) run.status = 'cancelled';
    else this.pending.push(run);
    return run;
  }
  async start(index = 0) {
    if (this.active) throw new AuthFailure('writer_busy');
    const [run] = this.pending.splice(index, 1);
    if (!run) return;
    this.active = run; run.status = 'in_progress';
    try {
      run.result = await this.context.run(run, run.task);
      run.status = 'completed'; return run.result;
    } catch (error) { run.status = 'failed'; throw error; }
    finally { this.active = null; }
  }
  async writer(task) { this.enqueue(task); return this.start(); }
}

export async function privateWorkflowFixture(t, { queue = 'max', expiry = NOW + 3600, language = 'ru' } = {}) {
  const f = await hostFixture(t); // Reuse OAuth/local vault failure boundaries from 23.
  f.actions = new FakeActions({ queue });
  f.schedule = scheduleFixture({ token: syntheticGrant });
  f.schedule.content = await renderPrivateWorkflow(PROGRAM_COMMIT);
  const document = await f.disk.read(); document.settings.language = language; document.settings.weeklyAutoReset = true;
  f.github = await githubFixture({ initialBundle: f.initial, initialDocument: document,
    fallback: (url, options) => f.schedule.writer.storage.fetch(url, options),
    event: async event => {
      if (event === 'secret.put') f.secret = decodeBundle(f.github.secret);
      await f.emit(event);
    } });
  f.github.secret = encodeBundle(f.initial);
  f.github.storage.serialization = f.actions.serialization;
  f.serialization = f.actions.serialization;
  f.workflow = new GitHubScheduleWriter(f.github.storage);
  f.rpc = new MockRpc();
  f.rpc.state.rows = [credit('selected-017', { expires_at: expiry === null ? null : new Date(expiry * 1000).toISOString() })];
  f.rpc.state.count = 1;
  f.rpc.state.outcome = 'nothing_to_reset';
  f.open = async () => {};
  f.external.open = async tokens => {
    f.childTokens = tokens; await f.emit('child.login'); await f.open();
    const handle = { closed: false,
      request: async (method, params) => {
        await f.emit(method);
        const result = await f.rpc.request(method, params);
        await f.afterResponse(method);
        return result;
      }, close: async () => { handle.closed = true; await f.emit('child.closed'); } };
    return handle;
  };
  f.afterResponse = async () => {};
  f.account = () => new HostAccountAdapter(new HostAuthSession({ store: f.github.storage, secrets: f.github.storage,
    serialization: f.serialization, oauth: f.oauth, vault: f.vault, runtime: f.external,
    snapshot: f.github.secret, grant: syntheticGrant, owner: 'job-017', now: () => f.clock }), { now: () => f.clock });
  f.quota = { periods: [{ start: NOW - 100, end: NOW + 86400, usedMinutes: 0, providerRemainingMinutes: 2000,
    paidUsageBlocked: true }], queuedJobs: 1, cleanupDelaySeconds: 300 };
  f.job = async ({ command = null, quota = f.quota, checkpoint, event = null, live } = {}) => runPrivateJob({ storage: f.github.storage,
    serialization: f.serialization, workflow: f.workflow, account: f.account(), quota,
    command, event, live, now: () => f.clock, checkpoint });
  f.enqueue = options => f.actions.enqueue(() => f.job(options));
  f.select = async () => f.actions.writer(async () => {
    const engine = new CycleEngine(f.github.storage, f.account(), { now: () => f.clock });
    const cmd = { action: 'select', commandId: 'initial-select-017', expectedVersion: f.github.state.version,
      creditId: 'selected-017', ...(expiry === null ? { scheduledAt: NOW } : { deltaSeconds: expiry - NOW }) };
    // Initial read performs host maintenance. Select's own CAS cannot accept
    // auth mutations while reading metadata; initialize the session first.
    await engine.refresh(); cmd.expectedVersion = f.github.state.version;
    await engine.command(cmd);
  });
  f.command = (action, extra = {}) => ({ command: 'control', action,
    commandId: `cmd-${action}`, expectedVersion: f.github.state.version, ...extra });
  f.calls = () => f.rpc.state.requests;
  return f;
}
