import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { privateWorkflowFixture, PROGRAM_COMMIT, confirmedTimer } from '../testing/private-workflow-fixture.mjs';
import { hostBytes, NOW } from '../testing/host-auth-fixture.mjs';
import { syntheticGrant } from '../testing/auth-fixture.mjs';
import { makeBundle, encodeBundle } from '../src/auth-bundle.mjs';
import { HostAuthSession } from '../src/host-auth-session.mjs';
import { runInstallerAdmin, sealAdmin, adminFingerprint } from '../src/installer-admin.mjs';
import { renderPrivateWorkflow } from '../src/private-workflow.mjs';
import { readManagedSchedule, renderTimerPlan } from '../src/github-schedule.mjs';
import { DISCOVERY_CRON, FALLBACK_CRON } from '../src/schedule-planner.mjs';
import { Installer, executeLogin, programFiles } from '../src/installer.mjs';
import { InstallerGitHub } from '../src/installer-github.mjs';
import { TerminalUI } from '../src/installer-ui.mjs';

async function fixture(t) {
  const f = await privateWorkflowFixture(t); let sequence = 0;
  f.adminCommand = (action, payload = {}) => sealAdmin('synthetic/private', syntheticGrant,
    { action, commandId: `installer-${++sequence}`, expectedVersion: f.github.state.version }, payload);
  f.admin = (command, extra = {}) => f.actions.writer(() => runInstallerAdmin({ storage: f.github.storage,
    serialization: f.serialization, workflow: f.workflow, grant: syntheticGrant, snapshot: f.github.secret,
    command, programCommit: PROGRAM_COMMIT, pilotApproved: true, now: () => f.clock,
    sessionFactory: snapshot => new HostAuthSession({ store: f.github.storage, secrets: f.github.storage,
      serialization: f.serialization, oauth: f.oauth, vault: f.vault, runtime: f.external,
      snapshot, grant: syntheticGrant, owner: 'installer-test', now: () => f.clock }), ...extra }));
  await f.admin(f.adminCommand('pause'));
  await f.actions.writer(() => f.github.storage.update(v => { v.installation.timer = confirmedTimer(f.clock); }));
  return f;
}
const seed = async f => {
  const bundle = makeBundle(hostBytes(1), { protocol: 2 });
  await f.admin(f.adminCommand('seed', { bundle: encodeBundle(bundle) })); return bundle;
};
const evidence = { clientPath: true, costPolicy: true, persistence: true };
const enable = f => f.adminCommand('enable', { evidence, quotaReceipt: { observedAt: f.clock, quota: f.quota } });

test('encrypted seed uses the Actions writer; disabled check cannot consume or enable', async t => {
  const f = await fixture(t), bundle = await seed(f);
  assert.equal(f.github.state.disabled, true);
  assert.equal(f.github.state.auth.committed.sessionId, bundle.sessionId);
  const command = f.adminCommand('check'), result = await f.admin(command);
  assert.equal(result.metadata.kind, 'details'); assert.equal(f.github.state.disabled, true);
  assert.equal(f.calls().length, 0); assert.equal(f.childTokens.accessToken.includes('synthetic-refresh'), false);
  assert.ok(!JSON.stringify(f.github.state).includes('authBase64'));
  const duplicate = await f.admin(command); assert.equal(duplicate.duplicate, true);
  assert.ok(!JSON.stringify(command).includes('synthetic-refresh'));
  const tampered = { ...f.adminCommand('check'), action: 'enable' };
  await assert.rejects(f.admin(tampered), /invalid_admin_command/);
  await assert.rejects(runInstallerAdmin({ storage: f.github.storage, serialization: f.serialization, command }), /serialized_writer_required/);
});

test('seed resumes exact target after failed Secret PUT without duplicating CI session', async t => {
  const f = await fixture(t), bundle = makeBundle(hostBytes(1), { protocol: 2 });
  const command = f.adminCommand('seed', { bundle: encodeBundle(bundle) });
  f.github.fail = 'secret'; await assert.rejects(f.admin(command), /stop_grant/);
  assert.equal(f.github.state.installation.operation.phase, 'pending');
  const target = f.github.state.auth.target; f.github.fail = null;
  await f.admin(command);
  assert.deepEqual(f.github.state.auth.committed, target);
  assert.equal(f.github.state.installation.operation.phase, 'done');
  assert.equal(f.github.state.commands.filter(c => c.commandId === command.commandId).length, 1);
});

test('reconnect preserves applied and unknown history; other workspace/user fails before Secret PUT', async t => {
  const f = await fixture(t); await seed(f);
  await f.admin(f.adminCommand('check'));
  await f.admin(f.adminCommand('select', { selection: { creditId: 'selected-017', deltaSeconds: 3600 } }));
  await f.admin(enable(f)); f.rpc.state.outcome = 'reset'; await f.actions.writer(() => f.job());
  const history = structuredClone({ requests: f.github.state.requests, groups: f.github.state.groups, cycles: f.github.state.cycles });
  await f.admin(f.adminCommand('pause')); await seed(f);
  assert.deepEqual({ requests: f.github.state.requests, groups: f.github.state.groups, cycles: f.github.state.cycles }, history);
  const secret = f.github.secret, puts = f.github.requests.filter(x => x.path.endsWith('AUTO_RESET_AUTH_BUNDLE') && x.method === 'PUT').length;
  for (const identity of [{ accountId: 'other-workspace' }, { userId: 'other-user' }]) {
    const bundle = makeBundle(hostBytes(1, identity), { protocol: 2 });
    await assert.rejects(f.admin(f.adminCommand('seed', { bundle: encodeBundle(bundle) })), /identity_changed/);
  }
  assert.equal(f.github.secret, secret);
  assert.equal(f.github.requests.filter(x => x.path.endsWith('AUTO_RESET_AUTH_BUNDLE') && x.method === 'PUT').length, puts);
});

test('enable requires pilot evidence, disabled connection check and fresh quota admission', async t => {
  const f = await fixture(t); await seed(f);
  await assert.rejects(f.admin(enable(f)), /connection_check_required/);
  await f.admin(f.adminCommand('check'));
  await assert.rejects(f.admin(enable(f), { pilotApproved: false }), /live_prerequisites_required/);
  await assert.rejects(f.admin(f.adminCommand('enable', { evidence,
    quotaReceipt: { observedAt: f.clock - 301, quota: f.quota } })), /quota_unavailable/);
  assert.equal(f.github.state.disabled, true);
  await f.admin(enable(f)); assert.equal(f.github.state.scheduler.mode, 'active');
  assert.equal(f.github.state.scheduler.publication, 'confirmed'); assert.equal(f.calls().length, 0);
});

test('selection supports partial/empty metadata and never auto-enables', async t => {
  const f = await fixture(t); await seed(f); f.rpc.state.count = 2;
  await assert.rejects(f.admin(f.adminCommand('select', { selection: { deltaSeconds: 3600 } })), /auto_select_requires_complete_metadata/);
  await f.admin(f.adminCommand('select', { selection: { creditId: 'selected-017', deltaSeconds: 3600 } }));
  assert.equal(f.github.state.disabled, true); assert.equal(f.github.state.cycles.length, 1);
  f.rpc.state.count = 0; f.rpc.state.rows = [];
  const result = await f.admin(f.adminCommand('check')); assert.equal(result.metadata.kind, 'empty');
});

test('quota resume preserves original hour/expiry and refuses insufficient budget', async t => {
  const f = await fixture(t); await seed(f); await f.admin(f.adminCommand('check'));
  await f.admin(f.adminCommand('select', { selection: { creditId: 'selected-017', deltaSeconds: 3600 } }));
  const bounds = f.github.state.cycles.map(c => [c.scheduledAt, c.originalDeadline, c.deadline]);
  await f.admin(enable(f));
  f.quota.periods[0].usedMinutes = 1000; await f.actions.writer(() => f.job());
  assert.equal(f.github.state.scheduler.mode, 'paused');
  await assert.rejects(f.admin(enable(f)), /quota_insufficient/);
  f.quota.periods[0].usedMinutes = 0; await f.admin(enable(f));
  assert.deepEqual(f.github.state.cycles.map(c => [c.scheduledAt, c.originalDeadline, c.deadline]), bounds);
});

test('uninstall serializes behind sent RPC, preserves its applied result and disables late queued job', async t => {
  const f = await fixture(t); await seed(f); await f.admin(f.adminCommand('check'));
  await f.admin(f.adminCommand('select', { selection: { creditId: 'selected-017', deltaSeconds: 3600 } }));
  await f.admin(enable(f)); f.rpc.state.outcome = 'reset';
  const originalApi = f.github.storage.api.bind(f.github.storage);
  f.github.storage.api = (path, opts) => path === '/actions/secrets/AUTO_RESET_GITHUB_TOKEN' ? Promise.resolve(null) : originalApi(path, opts);
  let queued;
  f.afterResponse = async method => {
    if (method.endsWith('/consume')) {
      assert.equal(f.github.state.requests[0].state, 'unconfirmed');
      queued = f.actions.enqueue(() => {
        const c = f.adminCommand('uninstall');
        return runInstallerAdmin({ storage: f.github.storage, workflow: f.workflow, serialization: f.serialization,
          command: c, grant: syntheticGrant, programCommit: PROGRAM_COMMIT, now: () => f.clock });
      });
    }
  };
  await f.actions.writer(() => f.job()); assert.equal(queued.status, 'pending');
  await f.actions.start(); assert.equal(f.github.state.requests[0].state, 'applied');
  assert.equal(f.github.state.revoked, true); assert.deepEqual(f.schedule.expressions(), []); assert.equal(f.github.secret, null);
  assert.equal(f.schedule.workflowDisabled, true); // No daily fallback runs without the PAT Secret.
  const n = f.calls().length; await f.actions.writer(() => (async () => {
    const { runPrivateJob } = await import('../src/private-job.mjs');
    return runPrivateJob({ storage: f.github.storage, workflow: f.workflow, serialization: f.serialization,
      account: { read: async () => { throw new Error('late account read forbidden'); } }, quota: f.quota, now: () => f.clock });
  })()); assert.equal(f.calls().length, n);
});

test('unknown outcome survives reconnect/read and blocks enable', async t => {
  const f = await fixture(t); await seed(f); await f.admin(f.adminCommand('check'));
  await f.admin(f.adminCommand('select', { selection: { creditId: 'selected-017', deltaSeconds: 3600 } }));
  await f.admin(enable(f)); f.rpc.state.loss = true; await f.actions.writer(() => f.job());
  assert.equal(f.github.state.requests[0].state, 'unconfirmed');
  await f.admin(f.adminCommand('pause')); const history = structuredClone(f.github.state.requests);
  await seed(f); await f.admin(f.adminCommand('check'));
  assert.deepEqual(f.github.state.requests, history);
  await assert.rejects(f.admin(enable(f)), /reconnect_or_outcome_required/);
});

test('failed cron cleanup is explicit and secrets are retained until schedule removal is confirmed', async t => {
  const f = await fixture(t); await seed(f); await f.admin(f.adminCommand('check')); await f.admin(enable(f));
  f.schedule.fail = 'write';
  const command = f.adminCommand('uninstall');
  await assert.rejects(f.admin(command), /schedule_cleanup_unconfirmed/);
  assert.equal(f.github.state.disabled, true); assert.ok(f.github.secret);
  assert.equal(f.github.state.scheduler.publication, 'unconfirmed'); assert.equal(f.schedule.workflowDisabled, false);
});

test('installer UI macOS gate, plain non-TTY language prompt, secret-free deployment allowlist', async t => {
  assert.throws(() => new Installer({ github: {}, platform: 'linux' }), /installer_requires_macos/);
  const input = new PassThrough(), output = new PassThrough(); let text = ''; output.on('data', b => { text += b; });
  const ui = new TerminalUI({ input, output }); input.end('en\nsynthetic-token\n');
  assert.equal(await ui.ask('Русский (ru) / English (en)'), 'en');
  assert.equal(await ui.ask('PAT', { secret: true }), 'synthetic-token'); ui.stage('1/5', 'Install'); ui.close();
  assert.ok(!text.includes('\x1b') && !text.includes('synthetic-token'));
  const files = await programFiles(process.cwd()); assert.ok(files['src/installer-admin.mjs']);
  assert.ok(files['scripts/install-linux-prerequisites.sh']);
  assert.ok(Object.keys(files).every(p => !/node_modules|\.scratch|auth\.json|state\.json|\.codex/.test(p)));
});

test('installer persists encrypted dispatch before sending and resumes same ID after lost delivery', async t => {
  const root = await mkdtemp(join(tmpdir(), 'installer-018-')); t.after(async () => (await import('node:fs/promises')).rm(root, { recursive: true, force: true }));
  const sent = [], github = { repository: 'synthetic/private', token: syntheticGrant, status: async () => ({ version: 3, commands: [] }),
    dispatch: async c => { sent.push(c); if (sent.length === 1) throw new Error('lost'); return { state: 'unconfirmed' }; } };
  const installer = new Installer({ github, platform: 'darwin', journalPath: join(root, 'journal.json') }); await installer.language('en');
  await assert.rejects(installer.send('pause'), /lost/);
  const resumed = new Installer({ github, platform: 'darwin', journalPath: installer.journalPath }); await resumed.load(); await resumed.resume();
  assert.deepEqual(sent[0], sent[1]); assert.equal(resumed.journal.language, 'en');
  const raw = await readFile(installer.journalPath, 'utf8'); assert.ok(!raw.includes(syntheticGrant));
  assert.equal((await stat(installer.journalPath)).mode & 0o777, 0o600);
});

test('local GitHub transport has no state writer and refuses public/non-dedicated repo', async () => {
  const g = new InstallerGitHub({ repository: 'synthetic/private', token: syntheticGrant,
    fetchImpl: async () => Response.json({ private: false, full_name: 'synthetic/private', default_branch: 'main' }) });
  await assert.rejects(g.repositoryInfo(), /private_repository_required/);
  await assert.rejects(g.storage.update(() => {}), /serialized_writer_required/);
});

test('bootstrap atomically pins code/workflow with one PAT; lost response/repeated setup do not duplicate', async () => {
  const { installerGitHubFixture } = await import('../testing/installer-github-fixture.mjs');
  const f = await installerGitHubFixture(); f.fail = 'lost-bootstrap';
  const marker = await f.github.bootstrap({ 'src/demo.mjs': 'export {}' }, 'en');
  assert.equal(f.secrets.get('AUTO_RESET_GITHUB_TOKEN'), syntheticGrant);
  assert.equal(f.secrets.size, 1); assert.equal(marker.language, 'en');
  const main = f.trees.get(f.commits.get(f.refs.get('main')).tree.sha); // Empty timer plan arrives with the workflow.
  assert.equal(main['.auto-reset-timer-plan.json'], renderTimerPlan([]));
  assert.deepEqual(await f.github.scheduleStatus(), []);
  const count = f.commits.size; assert.deepEqual(await f.github.bootstrap({}, 'en'), marker); assert.equal(f.commits.size, count);
  const { GitHubStorage } = await import('../src/github-storage.mjs');
  const store = new GitHubStorage({ repository: 'synthetic/private', token: syntheticGrant,
    fetchImpl: f.github.storage.fetch, serialization: f.actions.serialization });
  const s = await f.actions.writer(() => store.initializeDisabled('en', marker.programCommit));
  assert.equal(s.disabled, true); assert.equal(s.auth, undefined);
  await f.actions.writer(() => store.initializeDisabled('en', marker.programCommit));
  assert.equal((await f.github.status()).version, 0);
});

test('explicit upgrade changes pin without restoring old auth/history; old queued program is refused', async t => {
  const f = await fixture(t); await seed(f);
  const before = structuredClone(f.github.state.auth), newCommit = '2'.repeat(40);
  const originalApi = f.github.storage.api.bind(f.github.storage);
  f.github.storage.api = (path, opts) => path.startsWith('/git/commits/') ? Promise.resolve({ sha: newCommit }) : originalApi(path, opts);
  const command = f.adminCommand('upgrade', { programCommit: newCommit });
  await f.admin(command);
  assert.equal(f.github.state.installation.programCommit, newCommit);
  assert.deepEqual(f.github.state.auth, before); assert.equal(f.github.state.disabled, true);
  assert.deepEqual(f.schedule.expressions(), []);
  assert.ok(f.schedule.content.includes(`ref: ${newCommit}`));
  await assert.rejects(f.admin(f.adminCommand('check')), /program_version_conflict/);
  const result = await f.admin(command, { programCommit: newCommit }); assert.equal(result.duplicate, true);
});

test('upgrade publishes the exact template from the target commit instead of the running program template', async t => {
  const f = await fixture(t); await seed(f);
  const next = '4'.repeat(40), before = structuredClone(f.github.state.auth);
  const template = (await readFile('templates/private-auto-reset.yml', 'utf8')).replace('name: Auto reset', 'name: Auto reset target');
  const api = f.github.storage.api.bind(f.github.storage);
  f.github.storage.api = (path, options) => path.startsWith('/git/commits/') ? Promise.resolve({ sha: next }) :
    path === `/contents/templates/private-auto-reset.yml?ref=${next}` ? Promise.resolve({ type: 'file', encoding: 'base64',
      content: Buffer.from(template).toString('base64') }) : api(path, options);
  await f.admin(f.adminCommand('upgrade', { programCommit: next, workflowTemplate: template }));
  assert.equal(f.schedule.content, template.replaceAll('__PROGRAM_COMMIT__', next));
  assert.deepEqual(f.github.state.auth, before); assert.equal(f.github.state.disabled, true);
});

test('enable obtains a fresh provider receipt instead of trusting the encrypted caller billing snapshot', async t => {
  const f = await fixture(t); await seed(f); await f.admin(f.adminCommand('check'));
  let queried = 0;
  await f.admin(f.adminCommand('enable', { evidence, quotaReceipt: { observedAt: NOW - 301, quota: f.quota } }), {
    quotaProvider: async () => { queried++; return { observedAt: f.clock, quota: f.quota }; } });
  assert.equal(queried, 1); assert.equal(f.github.state.disabled, false);
  assert.equal(f.github.state.scheduler.admittedUntil, NOW + 301);
});

test('login executor imports/cleans only after process and all owned helpers exit', async () => {
  const events = [], plan = { file: '/fake/codex', args: ['login'], env: { HOME: '/owned' },
    complete: async () => { events.push('complete'); return 'bundle'; }, cleanup: async () => events.push('cleanup') };
  const spawnImpl = (_file, _args, opts) => {
    assert.equal(opts.detached, true); assert.deepEqual(opts.env, plan.env);
    const child = new EventEmitter(); child.pid = 42;
    queueMicrotask(() => { events.push('close'); child.emit('close', 0); }); return child;
  };
  const result = await executeLogin(plan, { spawnImpl, settleGroup: async () => events.push('helpers-exited') });
  assert.equal(result, 'bundle'); assert.deepEqual(events, ['close', 'helpers-exited', 'complete', 'cleanup']);
  events.length = 0;
  await assert.rejects(executeLogin(plan, { spawnImpl, settleGroup: async () => { throw new Error('helper alive'); } }), /helper alive/);
  assert.deepEqual(events, ['close']);
});

test('serialized seed publication pending stops scheduled jobs before account access', async t => {
  const f = await fixture(t), bundle = makeBundle(hostBytes(1), { protocol: 2 });
  const command = f.adminCommand('seed', { bundle: encodeBundle(bundle) });
  f.github.fail = 'secret'; await assert.rejects(f.admin(command)); f.github.fail = null;
  const result = await f.actions.writer(() => f.job()); assert.equal(result.problem, 'admin_recovery_required');
  assert.equal(f.calls().length, 0); assert.equal(f.github.state.installation.operation.phase, 'pending');
  await f.admin(command);
});

test('language update uses common writer and survives repeated setup', async t => {
  const f = await fixture(t); await f.admin(f.adminCommand('language', { language: 'en' }));
  assert.equal(f.github.state.settings.language, 'en');
  const result = await f.actions.writer(() => f.job({ command: { command: 'status' } }));
  assert.match(result.summary, /Reset|Status|Credit|Schedule/);
});

test('grant rotation can resume with the replacement PAT and keeps the same auth history', async () => {
  const { installerGitHubFixture } = await import('../testing/installer-github-fixture.mjs');
  const { GitHubStorage } = await import('../src/github-storage.mjs');
  const { grantFingerprint } = await import('../src/auth-bundle.mjs');
  const f = await installerGitHubFixture(), marker = await f.github.bootstrap({ 'src/demo.mjs': 'export {}' }, 'ru');
  const store = new GitHubStorage({ repository: 'synthetic/private', token: syntheticGrant, fetchImpl: f.github.storage.fetch,
    serialization: f.actions.serialization });
  await f.actions.writer(() => store.initializeDisabled('ru', marker.programCommit));
  const bundle = makeBundle(hostBytes(1), { protocol: 2 });
  const run = (c, grant = syntheticGrant) => f.actions.writer(() => runInstallerAdmin({ storage: store, serialization: f.actions.serialization,
    command: c, grant, programCommit: marker.programCommit }));
  await run(sealAdmin(store.repository, syntheticGrant, { action: 'seed', commandId: 'seed', expectedVersion: 0 }, { bundle: encodeBundle(bundle) }));
  const before = await f.github.status();
  const command = sealAdmin(store.repository, syntheticGrant, { action: 'rotate-grant', commandId: 'rotate', expectedVersion: before.version }, { newGrant: 'synthetic-new-PAT' });
  await run(command);
  assert.equal(f.secrets.get('AUTO_RESET_GITHUB_TOKEN'), 'synthetic-new-PAT');
  assert.equal((await f.github.status()).auth.grantFingerprint, grantFingerprint('synthetic-new-PAT'));
  const duplicate = await run(command, 'synthetic-new-PAT'); assert.equal(duplicate.duplicate, true);
  assert.deepEqual((await f.github.status()).auth.committed, before.auth.committed);
});

test('recover requires a new seed after durable revoke and stays disabled', async t => {
  const f = await fixture(t); const previous = await seed(f);
  await f.actions.writer(async () => {
    const { CycleEngine } = await import('../src/reset-cycles.mjs');
    await new CycleEngine(f.github.storage, f.account(), { now: () => NOW }).command({ action: 'revoke', commandId: 'revoke', expectedVersion: f.github.state.version });
  });
  await assert.rejects(f.admin(f.adminCommand('seed', { bundle: encodeBundle(previous) })), /new_login_required/);
  await assert.rejects(f.admin(f.adminCommand('recover')), /new_login_required/);
  await seed(f); await f.admin(f.adminCommand('recover'));
  assert.equal(f.github.state.revoked, false); assert.equal(f.github.state.disabled, true);
  await f.admin(f.adminCommand('check')); assert.equal(f.calls().length, 0);
});

test('upgrade resumes after lost workflow PUT under the new pin without restoring auth', async t => {
  const f = await fixture(t); await seed(f); const before = structuredClone(f.github.state.auth), next = '3'.repeat(40);
  const api = f.github.storage.api.bind(f.github.storage);
  f.github.storage.api = (path, opts) => path.startsWith('/git/commits/') ? Promise.resolve({ sha: next }) : api(path, opts);
  const c = f.adminCommand('upgrade', { programCommit: next }); f.schedule.fail = 'lost-response';
  await assert.rejects(f.admin(c), /storage_unconfirmed/);
  assert.equal(f.github.state.installation.operation.phase, 'pending');
  assert.equal(f.github.state.installation.programCommit, next);
  f.schedule.fail = null; await f.admin(c, { programCommit: next });
  assert.deepEqual(f.github.state.auth, before); assert.equal(f.github.state.disabled, true);
  assert.equal(f.github.state.installation.operation.phase, 'done');
});

test('upgrade from a workflow-cron pin: old managed cron removed, history and pending journal kept, timer plan created', async t => {
  const f = await fixture(t); await seed(f); await f.admin(f.adminCommand('check'));
  await f.admin(f.adminCommand('select', { selection: { creditId: 'selected-017', deltaSeconds: 3600 } }));
  await f.admin(enable(f)); f.rpc.state.loss = true; await f.actions.writer(() => f.job());
  await f.admin(f.adminCommand('pause'));
  const history = () => structuredClone({ requests: f.github.state.requests, groups: f.github.state.groups,
    cycles: f.github.state.cycles, commands: f.github.state.commands, auth: f.github.state.auth });
  assert.equal(f.github.state.requests[0].state, 'unconfirmed');
  const api = f.github.storage.api.bind(f.github.storage), legacyPlan = [DISCOVERY_CRON, '7,12 10 8 10 *'];
  f.github.storage.api = (path, opts) => path.startsWith('/git/commits/') ? Promise.resolve({ sha: path.split('/').at(-1) }) : api(path, opts);
  // As a pin before 37 leaves the repository: windows as managed cron inside the workflow, no timer plan.
  const legacy = workflow => workflow.replace(`    - cron: '${FALLBACK_CRON}'`, legacyPlan.map(x => `    - cron: '${x}'`).join('\n'));
  f.schedule.content = legacy(await renderPrivateWorkflow(PROGRAM_COMMIT)); f.schedule.plan = null; f.schedule.planSha = null;
  assert.deepEqual(readManagedSchedule(f.schedule.content), legacyPlan);
  const before = history(), next = '5'.repeat(40);
  const c = f.adminCommand('upgrade', { programCommit: next });
  await f.admin(c);
  // The whole workflow is replaced: only the static fallback remains; windows live in the plan.
  assert.equal(f.schedule.content, await renderPrivateWorkflow(next));
  assert.deepEqual(readManagedSchedule(f.schedule.content), [FALLBACK_CRON]);
  assert.equal(f.schedule.plan, renderTimerPlan([]));
  const after = history();
  assert.deepEqual(after.requests, before.requests); assert.deepEqual(after.groups, before.groups);
  assert.deepEqual(after.cycles, before.cycles); assert.deepEqual(after.auth, before.auth);
  assert.deepEqual(after.commands.slice(0, before.commands.length), before.commands);
  assert.equal(f.github.state.installation.operation.phase, 'done'); assert.equal(f.github.state.disabled, true);
  // The new pin's fallback run keeps the unknown outcome and never reads the account.
  const n = f.calls().length;
  const result = await f.actions.writer(() => f.job({ event: 'schedule' }));
  assert.equal(result.timerProblem, null); assert.equal(f.calls().length, n);
  assert.deepEqual(f.github.state.requests, before.requests);

  // An older pin did the Upgrade itself (cron cleaned, new template published) and lost the response:
  // the same command resumes under the new pin, creates the absent plan and rewrites nothing else.
  const g = await fixture(t); await seed(g);
  const gApi = g.github.storage.api.bind(g.github.storage);
  g.github.storage.api = (path, opts) => path.startsWith('/git/commits/') ? Promise.resolve({ sha: next }) : gApi(path, opts);
  const resume = g.adminCommand('upgrade', { programCommit: next });
  await g.actions.writer(() => g.github.storage.update(v => {
    v.disabled = true; v.installation.programCommit = next;
    v.installation.operation = { commandId: resume.commandId, fingerprint: adminFingerprint(resume), action: 'upgrade', phase: 'pending' };
    v.commands.push({ commandId: resume.commandId, fingerprint: adminFingerprint(resume), expectedVersion: resume.expectedVersion,
      acceptedAt: g.clock, result: { state: 'accepted', action: 'admin-upgrade', cycleId: null } });
  }));
  g.schedule.content = await renderPrivateWorkflow(next); g.schedule.plan = null; g.schedule.planSha = null;
  const pending = structuredClone(g.github.state.commands), workflowPuts = g.schedule.workflowPuts;
  const blocked = await g.actions.writer(() => g.job({ event: 'schedule' }));
  assert.equal(blocked.problem, 'admin_recovery_required'); assert.equal(g.schedule.plan, null);
  await g.admin(resume, { programCommit: next });
  assert.equal(g.github.state.installation.operation.phase, 'done'); assert.equal(g.schedule.workflowPuts, workflowPuts);
  assert.equal(g.schedule.plan, renderTimerPlan([])); assert.deepEqual(g.github.state.commands, pending);
});

test('uninstall retains unknown request and leaves secrets untouched when cron cannot be read', async t => {
  const f = await fixture(t); await seed(f); await f.admin(f.adminCommand('check'));
  await f.admin(f.adminCommand('select', { selection: { creditId: 'selected-017', deltaSeconds: 3600 } }));
  await f.admin(enable(f)); f.rpc.state.loss = true; await f.actions.writer(() => f.job());
  const history = structuredClone(f.github.state.requests); f.schedule.fail = 'read';
  const c = f.adminCommand('uninstall'); await assert.rejects(f.admin(c), /schedule_cleanup_unconfirmed/);
  assert.deepEqual(f.github.state.requests, history); assert.equal(f.github.state.revoked, true); assert.ok(f.github.secret);
  assert.equal(f.schedule.workflowDisabled, false);
});

test('installer Summary follows saved language and escapes metadata identifiers', async t => {
  const f = await fixture(t); await seed(f);
  await f.admin(f.adminCommand('language', { language: 'en' }));
  const c = f.adminCommand('check'), result = await f.admin(c);
  result.metadata.credits[0].id = '<script>|bad\nrow';
  const { renderInstallerReport } = await import('../src/installer-report.mjs');
  const report = await f.actions.writer(() => renderInstallerReport(f.github.storage, c, result, () => NOW));
  assert.match(report, /Installer command/); assert.match(report, /Issued resets/);
  assert.ok(!report.includes('<script>')); assert.match(report, /&lt;script&gt;&#124;bad row/);
  assert.ok(!report.includes('synthetic-refresh'));
});


test('installer accepts current dispatch response without treating run creation as command confirmation', async () => {
  for (const status of [200, 204]) {
    const github = new InstallerGitHub({ repository: 'synthetic/private', token: syntheticGrant,
      fetchImpl: async (url, options) => {
        if (options.method === 'POST') return status === 204 ? new Response(null, { status }) :
          Response.json({ workflow_run_id: 123, html_url: 'https://github.com/synthetic/private/actions/runs/123' });
        return Response.json({ private: true, full_name: 'synthetic/private', default_branch: 'main' });
      } });
    assert.deepEqual(await github.dispatch({ commandId: 'current-dispatch' }),
      { state: 'unconfirmed', commandId: 'current-dispatch' });
  }
});


test('explicit disabled check can rotate host credentials and read through the published generation', async t => {
  const f = await fixture(t); await seed(f);
  const generation = f.github.state.auth.committed.generation;
  const result = await f.admin(f.adminCommand('check', { forceRefresh: true }));
  assert.equal(result.problem, undefined);
  assert.equal(f.github.state.auth.committed.generation, generation + 1);
  assert.equal(f.github.state.auth.phase, 'ready');
  assert.equal(f.github.state.disabled, true);
  assert.equal(f.calls().length, 0);
});


test('weekly auto reset setup requires pause and an explicit boolean; changing it never enables the schedule', async t => {
  const f = await fixture(t);
  const before = f.calls().length;
  let result = await f.admin(f.adminCommand('weekly-auto', { enabled: false }));
  assert.equal(result.phase, 'done'); assert.equal(f.github.state.settings.weeklyAutoReset, false);
  result = await f.admin(f.adminCommand('weekly-auto', { enabled: true }));
  assert.equal(result.phase, 'done'); assert.equal(f.github.state.settings.weeklyAutoReset, true);
  assert.equal(f.github.state.disabled, true); assert.deepEqual(f.schedule.expressions(), []);
  await assert.rejects(f.admin(f.adminCommand('weekly-auto', { enabled: 'YES' })), /invalid_command/);
  assert.equal(f.calls().length, before);
  await f.actions.writer(() => f.github.storage.update(s => { s.disabled = false; }));
  await assert.rejects(f.admin(f.adminCommand('weekly-auto', { enabled: false })), /durable_disable_required/);
  assert.equal(f.github.state.settings.weeklyAutoReset, true);
});
