import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { HostAuthAdmin } from '../session/auth-admin.mjs';
import { AuthFailure, decodeBundle, bundleBytes, sameTuple, tuple } from '../session/auth-bundle.mjs';
import { StateFailure } from '../core/state-store.mjs';
import { withInstallationWriter, renderPrivateWorkflow, WORKFLOW_PATH } from '../workflow/private-workflow.mjs';
import { SchedulePlanner, planSchedule, timerProbeSlot } from '../schedule/schedule-planner.mjs';
import { timerApp } from '../core/installation-state.mjs';
import { readDefaultBranchFile } from '../github/github-schedule.mjs';
import { readQuotaReceipt } from '../workflow/private-job.mjs';
import { CycleEngine, fingerprint } from '../core/reset-cycles.mjs';
import { configureQuota, verifyQuota, migrateBillingToken } from './installer-quota.mjs';
import { runCheckObserver } from '../account/check-observer.mjs';
import { parseRateLimits } from '../account/account.mjs';
import { runRevokeValidation, validateRevokePlan } from '../session/revoke-verifier.mjs';

const fail = kind => { throw new StateFailure(kind); };
const key = token => createHash('sha256').update('auto-reset-admin-v1\0').update(token).digest();
const aad = (repository, c) => Buffer.from(JSON.stringify([repository.toLowerCase(), c.commandId, c.expectedVersion, c.action]));
// Only ciphertext crosses workflow_dispatch. Binding prevents cross-repo/version/action reuse.
export function sealAdmin(repository, token, header, payload = {}) {
  const command = { command: 'admin', ...header };
  const encrypt = token => {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(token), nonce);
    cipher.setAAD(aad(repository, command));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
  };
  command.envelope = encrypt(token);
  if (header.action === 'rotate-grant' && payload.newGrant) command.nextEnvelope = encrypt(payload.newGrant);
  if (Buffer.byteLength(JSON.stringify(command)) > 60_000) fail('command_too_large');
  return command;
}
// The installer opens its own pending rotation to learn the confirmed token (ticket 41).
export function openAdmin(repository, token, c) {
  try {
    if (!c || Object.keys(c).some(k => !['command', 'commandId', 'expectedVersion', 'action', 'envelope', 'nextEnvelope'].includes(k)) ||
      c.command !== 'admin' || !/^[A-Za-z0-9_-]{1,128}$/.test(c.commandId) ||
      !Number.isSafeInteger(c.expectedVersion) || c.expectedVersion < 0 || typeof c.envelope !== 'string' ||
      c.envelope.length > 60_000) fail('invalid_admin_command');
    for (const envelope of [c.envelope, ...(c.action === 'rotate-grant' ? [c.nextEnvelope] : [])]) {
      try {
        if (typeof envelope !== 'string' || envelope.length > 60_000) continue;
        const bytes = Buffer.from(envelope, 'base64');
        const decipher = createDecipheriv('aes-256-gcm', key(token), bytes.subarray(0, 12));
        decipher.setAAD(aad(repository, c)); decipher.setAuthTag(bytes.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
      } catch { /* Grant rotation may already have replaced the job Secret. */ }
    }
    fail('invalid_admin_command');
  } catch { fail('invalid_admin_command'); }
}
// workflow_dispatch boundary. The timer app (Actions: write) can send any input, so
// only an empty input, exact status or a sealed admin command reach the writer.
export function readDispatchCommand(raw, { repository, grant }) {
  if (!raw) return null;
  if (Buffer.byteLength(raw) > 60_000) fail('command_too_large');
  let command;
  try { command = JSON.parse(raw); } catch { fail('invalid_command'); }
  if (!command || typeof command !== 'object' || Array.isArray(command)) fail('invalid_command');
  if (command.command === 'status' && Object.keys(command).length === 1) return command;
  if (command.command !== 'admin') fail('open_command_rejected');
  if (command.action !== 'control') return command; // runInstallerAdmin authenticates it inside the writer slot.
  // Sealed control keeps the CycleEngine journal: the bound header ID/version are its identity.
  const p = openAdmin(repository, grant, command);
  if (!p || typeof p !== 'object' || Array.isArray(p) || command.nextEnvelope !== undefined ||
    ['command', 'commandId', 'expectedVersion'].some(k => Object.hasOwn(p, k))) fail('invalid_admin_command');
  return { command: 'control', ...p, commandId: command.commandId, expectedVersion: command.expectedVersion };
}
// A sealed control is journaled by CycleEngine under its own fingerprint of the opened fields.
export function controlFingerprint(repository, grant, c) {
  const { command: ignored, ...control } = readDispatchCommand(JSON.stringify(c), { repository, grant });
  return fingerprint(control);
}
export const adminFingerprint = c => createHash('sha256').update(JSON.stringify([c.commandId, c.expectedVersion, c.action, c.envelope, c.nextEnvelope ?? null])).digest('hex');
const actions = ['init', 'seed', 'recover', 'check', 'select', 'pause', 'enable', 'uninstall', 'upgrade', 'rotate-grant', 'language', 'configure-quota', 'check-quota', 'revoke-session', 'weekly-auto', 'timer'];

// Called ONLY inside the authenticated workflow's writer slot. Never from the local UI.
export async function runInstallerAdmin({ storage, workflow, serialization, command: c, grant, snapshot,
  sessionFactory, oauth, verifierRuntime, verifierOptions = {}, programCommit, pilotApproved = false, quotaProvider = null, quotaPolicy = null, runId = null, billingFetch = fetch, now = () => Math.floor(Date.now() / 1000) }) {
  return withInstallationWriter(serialization, async () => {
    const p = openAdmin(storage.repository, grant, c);
    if (!actions.includes(c.action)) fail('invalid_admin_action');
    if (c.action === 'revoke-session') validateRevokePlan(p);
    // Installation token expiry read by the installer from GitHub; null when the token has none.
    if (['init', 'rotate-grant'].includes(c.action) && p.grantExpiresAt !== undefined && p.grantExpiresAt !== null &&
      (!Number.isSafeInteger(p.grantExpiresAt) || p.grantExpiresAt < 0)) fail('invalid_command');
    if (c.action === 'init') {
      if (c.expectedVersion !== 0 || !['ru', 'en'].includes(p.language)) fail('invalid_init');
      await storage.initializeDisabled(p.language, programCommit);
    }
    let s = await storage.read();
    if (s.installation?.programCommit && s.installation.programCommit !== programCommit &&
      !(c.action === 'upgrade' && s.installation.operation?.commandId === c.commandId && s.installation.operation.phase === 'pending')) fail('program_version_conflict');
    const fingerprint = adminFingerprint(c), prior = s.commands.find(x => x.commandId === c.commandId);
    if (prior && prior.fingerprint !== fingerprint) fail('command_id_reused');
    if (prior && s.installation?.operation?.commandId !== c.commandId || prior && s.installation.operation.phase === 'done') {
      return { state: 'accepted', duplicate: true, phase: 'done', problem: s.installation?.operation?.commandId === c.commandId ? s.installation.operation.problem ?? null : null, version: s.version };
    }
    if (!prior) {
      if (c.action === 'seed' && s.auth?.committed && decodeBundle(p.bundle).sessionId === s.auth.committed.sessionId) fail('new_login_required');
      if (s.version !== c.expectedVersion) fail('version_conflict');
      if (s.installation?.operation?.phase === 'pending') fail('admin_recovery_required');
      // Upgrade changes only the pin and workflow, never the session, so a revoked installation can move to a newer program.
      if (s.revoked && !['seed', 'recover', 'uninstall', 'check', 'upgrade'].includes(c.action)) fail('installation_revoked');
      s = (await storage.update(v => {
        if (v.version !== c.expectedVersion) fail('version_conflict');
        v.installation ??= { programCommit, seedSession: null, checkedSession: null, operation: null, grant: null };
        v.installation.operation = { commandId: c.commandId, fingerprint, action: c.action, phase: 'pending' };
        v.commands.push({ commandId: c.commandId, fingerprint, expectedVersion: c.expectedVersion, acceptedAt: now(),
          result: { state: 'accepted', action: `admin-${c.action}`, cycleId: null } });
        if (['pause', 'uninstall', 'upgrade'].includes(c.action)) {
          v.disabled = true;
          // Their cleanup requires an empty plan: an unconfirmed timer probe is abandoned, not published.
          if (v.installation.timer?.confirmedAt === null) v.installation.timer.probeAt = null;
        }
        if (c.action === 'uninstall') { v.revoked = true; v.installation.seedSession = null; v.installation.checkedSession = null; v.installation.timer = null; }
      })).state;
    }
    try {
      const admin = new HostAuthAdmin({ store: storage, secrets: storage, serialization, owner: 'installer-admin' });
      const planner = new SchedulePlanner(storage, workflow, { now });
      let metadata = null, cleanup = null;
      if (await migrateBillingToken(storage)) s = await storage.read();
      if (c.action === 'init') {
        await storage.update(v => { v.installation.grant = { expiresAt: p.grantExpiresAt ?? null }; });
      } else if (c.action === 'revoke-session') {
        const revokeValidation = await runRevokeValidation({ admin, storage, workflow, serialization,
          snapshot, grant, expectedVersion: s.version, oauth, runtime: verifierRuntime, quotaProvider,
          plan: p, now, ...verifierOptions });
        const problem = revokeValidation.errorKind ?? (revokeValidation.refresh === 'successQuarantined' ?
          'cleanup_decision_required' : revokeValidation.stopReason === 'unknown' ? 'verification_unknown' : null);
        await storage.update(v => { v.installation.operation.phase = 'done';
          v.installation.operation.problem = problem; });
        return { state: 'accepted', phase: 'done', version: (await storage.read()).version,
          problem, revokeValidation };
      } else if (c.action === 'seed') {
        const bundle = decodeBundle(p.bundle);
        if (!s.disabled) fail('durable_disable_required');
        if (s.auth?.transition === 'seed' && sameTuple(s.auth.target, tuple(bundle))) {
          await storage.publish(bundle); // Exact encrypted envelope recovers even a lost Secret PUT response.
          await admin.adopt(bundle, grant, s.version);
        } else if (!sameTuple(s.auth?.committed, tuple(bundle))) {
          await admin.seed(bundleBytes(bundle), grant, s.version, { previousSnapshot: p.previousSnapshot ?? snapshot ?? null, preparedBundle: bundle });
        }
        await storage.update(v => { v.installation.seedSession = bundle.sessionId; v.installation.checkedSession = null; v.installation.metadata = null; });
      } else if (c.action === 'recover') {
        if (!s.disabled || s.auth?.phase !== 'ready' || s.installation.seedSession !== s.auth.committed.sessionId) fail('new_login_required');
        await storage.update(v => { v.revoked = false; v.reconnectRequested = false; v.auth.reconnectReason = null; });
      } else if (['check', 'select'].includes(c.action)) {
        if (!s.disabled) fail('durable_disable_required');
        if (p.observer !== undefined) {
          if (c.action !== 'check' || p.forceRefresh !== false || p.observer?.schema !== 1 ||
              Object.keys(p.observer).some(k => !['schema', 'futureMinutes'].includes(k)) ||
              !Number.isSafeInteger(p.observer.futureMinutes) || p.observer.futureMinutes < 0) fail('invalid_observer_command');
          const observer = await runCheckObserver({ session: sessionFactory(snapshot), storage, workflow, quotaProvider,
            futureMinutes: p.observer.futureMinutes, now });
          await storage.update(v => { v.installation.operation.phase = 'done'; v.installation.operation.problem = observer.errorKind; });
          return { state: 'accepted', phase: 'done', version: (await storage.read()).version,
            problem: observer.errorKind, observer };
        }
        await storage.update(v => { v.installation.checkedSession = null; v.installation.metadata = null; });
        const session = sessionFactory(snapshot);
        if (p.forceRefresh === true) await session.service({ force: true, setup: true, expectedVersion: (await storage.read()).version });
        const account = await session.setupRead((await storage.read()).version);
        if (!account?.account || ![undefined, 'chatgpt', 'chatgptAuthTokens'].includes(account.account.type)) fail('unsupported_account');
        metadata = parseRateLimits(await session.setupMetadata((await storage.read()).version));
        await storage.update(v => { v.installation.checkedSession = v.auth.committed.sessionId; v.installation.metadata = metadata; });
        if (c.action === 'select') {
          const engine = new CycleEngine(storage, { read: async () => metadata }, { now });
          await engine.command({ action: 'select', commandId: `${c.commandId}-selection`, expectedVersion: (await storage.read()).version,
            ...Object.fromEntries(Object.entries(p.selection ?? {}).filter(([k]) =>
              ['creditId', 'deltaSeconds', 'scheduledAt', 'automation', 'acknowledgeDelayRisk', 'attemptUntil'].includes(k))) });
        }
      } else if (c.action === 'weekly-auto') {
        if (!s.disabled) fail('durable_disable_required');
        if (typeof p.enabled !== 'boolean' || Object.keys(p).some(k => k !== 'enabled')) fail('invalid_command');
        await storage.update(v => { v.settings.weeklyAutoReset = p.enabled; });
      } else if (c.action === 'timer') {
        // Only the timer app IDs and slug cross the envelope: its key stays in the Worker secret.
        if (!s.disabled) fail('durable_disable_required');
        if (!timerApp(p)) fail('invalid_command');
        // A new timer, or one moved from the timer token, is confirmed again by a probe slot woken
        // through the Worker. The whole record is replaced: a timer token's expiry does not survive.
        await storage.update(v => { v.installation.timer = { appId: p.appId, appSlug: p.appSlug, installationId: p.installationId,
          probeAt: timerProbeSlot(now()), confirmedAt: null }; });
        const receipt = await planner.reconcile();
        if (receipt.publication !== 'confirmed' || receipt.confirmed.expressions.length !== 1) fail('timer_probe_unconfirmed');
      } else if (c.action === 'language') {
        if (!['ru', 'en'].includes(p.language)) fail('invalid_language');
        await storage.update(v => { v.settings.language = p.language; });
      } else if (c.action === 'rotate-grant') {
        if (!s.disabled || typeof p.newGrant !== 'string' || !p.newGrant) fail('durable_disable_required');
        const { InstallerGitHub } = await import('./installer-github.mjs');
        const next = new InstallerGitHub({ repository: storage.repository, token: p.newGrant, fetchImpl: storage.fetch });
        await next.repositoryInfo(); await next.storage.publicKey();
        await next.putSecret('AUTO_RESET_GITHUB_TOKEN', p.newGrant);
        await admin.rotateGrant(p.newGrant, (await storage.read()).version);
        // The expiry follows the token: a rotation without one forgets the previous date.
        await storage.update(v => { v.installation.checkedSession = null; v.installation.grant = { expiresAt: p.grantExpiresAt ?? null }; });
      } else if (c.action === 'configure-quota') {
        await configureQuota({ storage, workflow, payload: p, runId, fetchImpl: billingFetch, now });
      } else if (c.action === 'check-quota') {
        await verifyQuota({ storage, quotaProvider, quotaPolicy, now });
      } else if (c.action === 'enable') {
        if (s.installation.quota && (!s.installation.quota.verified || !quotaProvider ||
            JSON.stringify(s.installation.quota.policy) !== quotaPolicy)) fail('quota_setup_check_required');
        if (!pilotApproved || !p.evidence || !['clientPath', 'costPolicy', 'persistence'].every(k => p.evidence[k] === true)) fail('live_prerequisites_required');
        if (s.revoked || s.reconnectRequested || s.requests.some(r => r.state === 'unconfirmed')) fail('reconnect_or_outcome_required');
        if (!s.auth || s.auth.phase !== 'ready' || s.installation.checkedSession !== s.auth.committed.sessionId) fail('connection_check_required');
        // ADR-0002: windows are woken only by the external timer, so it is confirmed before enable.
        if (!s.installation.timer?.confirmedAt) fail('timer_confirmation_required');
        const quota = readQuotaReceipt(JSON.stringify(quotaProvider ? await quotaProvider() : p.quotaReceipt), now());
        const published = await workflow.read();
        const plan = planSchedule({ ...s, disabled: false }, { now: now(), quota, published: published.expressions, resume: true });
        if (plan.mode !== 'active') fail(plan.reason);
        await storage.update(v => { v.disabled = false; });
        const receipt = await planner.reconcile({ quota, resume: true });
        if (receipt.mode !== 'active' || receipt.publication !== 'confirmed') {
          await storage.update(v => { v.disabled = true; });
          await planner.reconcile({ quota }); fail('enable_unconfirmed');
        }
      } else if (['pause', 'uninstall', 'upgrade'].includes(c.action)) {
        const receipt = await planner.reconcile();
        if (receipt.publication !== 'confirmed' || receipt.confirmed.expressions.length) fail('schedule_cleanup_unconfirmed');
        if (c.action === 'upgrade') {
          if (!/^[a-f0-9]{40}$/.test(p.programCommit ?? '')) fail('pinned_program_commit_required');
          // Verify code commit exists, then publish pinned workflow. State migration is performed by storage.load.
          // The whole file is replaced: a managed cron left by a pin before the timer plan disappears with it.
          await storage.api(`/git/commits/${p.programCommit}`);
          const expected = await readDefaultBranchFile(storage, WORKFLOW_PATH);
          if (expected.content === null) fail('invalid_repository_file');
          let content = await renderPrivateWorkflow(p.programCommit);
          if (p.workflowTemplate !== undefined) {
            const file = await storage.api(`/contents/templates/private-auto-reset.yml?ref=${p.programCommit}`);
            if (file?.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' ||
                typeof p.workflowTemplate !== 'string' || Buffer.byteLength(p.workflowTemplate) > 48_000 ||
                Buffer.from(file.content, 'base64').toString('utf8') !== p.workflowTemplate ||
                !p.workflowTemplate.includes('__PROGRAM_COMMIT__')) fail('upgrade_template_unconfirmed');
            content = p.workflowTemplate.replaceAll('__PROGRAM_COMMIT__', p.programCommit);
          }
          await storage.update(v => { v.installation.programCommit = p.programCommit; v.installation.checkedSession = null; v.installation.metadata = null; });
          if (expected.content !== content) await storage.api(`/contents/${WORKFLOW_PATH}`, { method: 'PUT', statuses: [200, 201], body: {
            branch: expected.branch, sha: expected.sha, content: Buffer.from(content).toString('base64'), message: 'Explicit auto-reset upgrade' } });
          const fresh = await readDefaultBranchFile(storage, WORKFLOW_PATH);
          if (fresh.content !== content) fail('upgrade_unconfirmed');
        }
        if (c.action === 'uninstall') {
          // Existing sent RPC belongs to the preceding writer and has settled before this slot.
          // Persist history first, then remove schedule, bundle, the sole PAT and finally workflow runs.
          await storage.deleteBundle(); // A billing Secret from before ticket 40 is gone with the migration above.
          if (quotaProvider || s.installation.quota) await storage.api('/actions/variables/AUTO_RESET_BILLING_POLICY', { method: 'DELETE', statuses: [204, 404] });
          await storage.update(v => { v.installation.quota = null; });
          await storage.api('/actions/secrets/AUTO_RESET_GITHUB_TOKEN', { method: 'DELETE', statuses: [204, 404] });
          // The static fallback cron would keep starting failing paid jobs without the PAT Secret.
          // The job still holds the PAT in memory; disabling stops new runs, not this one.
          await storage.api('/actions/workflows/auto-reset.yml/disable', { method: 'PUT', statuses: [204] });
          cleanup = 'secrets_removed_revoke_access';
        }
      }
      await storage.update(v => { v.installation.operation.phase = 'done'; });
      return { state: 'accepted', phase: 'done', version: (await storage.read()).version, metadata, cleanup };
    } catch (error) {
      const latest = await storage.read();
      const targetPending = c.action === 'seed' && latest.auth?.transition === 'seed';
      if (!targetPending && !(c.action === 'configure-quota' && latest.installation.operation.quotaPublication) && !['upgrade', 'uninstall', 'rotate-grant'].includes(c.action)) {
        await storage.update(v => { v.installation.operation.phase = 'done'; v.installation.operation.problem = error instanceof StateFailure || error instanceof AuthFailure ? error.kind : 'admin_failed'; });
      }
      throw error;
    }
  });
}
