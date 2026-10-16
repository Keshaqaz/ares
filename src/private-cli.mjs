import { readFile, appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubStorage } from './github-storage.mjs';
import { GitHubScheduleWriter } from './github-schedule.mjs';
import { acquireGitHubWriter } from './private-workflow.mjs';
import { HostAuthSession } from './host-auth-session.mjs';
import { HostOAuth, LocalAuthVault } from './host-oauth.mjs';
import { ExternalAuthRuntime } from './external-auth-runtime.mjs';
import { HostAccountAdapter } from './host-account.mjs';
import { runPrivateJob, readQuotaReceipt } from './private-job.mjs';
import { AuthFailure } from './auth-bundle.mjs';
import { renderInstallerReport } from './installer-report.mjs';
import { runInstallerAdmin, readDispatchCommand } from './installer-admin.mjs';
import { StateFailure } from './state-store.mjs';
import { readGitHubQuota } from './github-quota.mjs';

const env = process.env;
const now = () => Math.floor(Date.now() / 1000);
let lease, root;
let language = env.AUTO_RESET_LANGUAGE === 'ru' ? 'ru' : 'en';
try {
  const pins = JSON.parse(await readFile(new URL('../runtime-lock.json', import.meta.url), 'utf8'));
  if (process.version !== `v${pins.node}`) throw new StateFailure('node_version_mismatch');
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new StateFailure('private_job_requires_linux_x64');
  // Shipped template has no approval value and only the static daily fallback cron.
  // 21 owns real activation. Open control is refused before writer admission; sealed control is opened here.
  const command = readDispatchCommand(env.AUTO_RESET_COMMAND,
    { repository: env.GITHUB_REPOSITORY, grant: env.AUTO_RESET_GITHUB_TOKEN });
  const pilotApproved = env.AUTO_RESET_PILOT_APPROVED === env.GITHUB_REPOSITORY && !!env.GITHUB_REPOSITORY;
  // The fallback only reconciles and never reads auth, like status. So does an external wake
  // before approval: the installer confirms the timer probe before enable (ticket 38).
  const wakeOnly = !pilotApproved && !command && env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  if (!pilotApproved && !wakeOnly && command?.command !== 'admin' && command?.command !== 'status' && env.GITHUB_EVENT_NAME !== 'schedule') {
    throw new StateFailure('live_pilot_gate_closed');
  }
  if (process.argv.length !== 2) throw new StateFailure('invalid_command');
  const serialization = { assertOwner: () => {
    if (!lease) throw new StateFailure('private_writer_context_required');
    return lease.assertOwner();
  } };
  const storage = new GitHubStorage({ repository: env.GITHUB_REPOSITORY, token: env.AUTO_RESET_GITHUB_TOKEN, serialization });
  lease = await acquireGitHubWriter({ storage, runId: env.GITHUB_RUN_ID, eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF, programCommit: env.AUTO_RESET_PROGRAM_COMMIT });
  if (command?.action !== 'init') language = (await storage.read()).settings.language;
  root = await mkdtemp(join(tmpdir(), 'auto-reset-host-vault-'));
  const sessionFactory = snapshot => new HostAuthSession({ store: storage, secrets: storage, serialization,
    oauth: new HostOAuth({ now }), vault: new LocalAuthVault(join(root, 'credentials', 'target.json')),
    runtime: new ExternalAuthRuntime({ binary: fileURLToPath(new URL('../.runtime/codex', import.meta.url)) }),
    snapshot, grant: env.AUTO_RESET_GITHUB_TOKEN, owner: `job-${env.GITHUB_RUN_ID}`, now });
  let account;
  const getAccount = () => {
    if (!account) {
      const session = sessionFactory(env.AUTO_RESET_AUTH_BUNDLE);
      account = new HostAccountAdapter(session, { now });
    }
    return account;
  };
  const lazyAccount = Object.fromEntries(['read', 'consume', 'reserveConsume'].map(method =>
    [method, (...args) => getAccount()[method](...args)]));
  Object.defineProperty(lazyAccount, 'problem', { get: () => account?.problem ?? null });
  const workflow = new GitHubScheduleWriter(storage);
  // Billing is read with the installation token itself (ADR-0003); only the policy is separate.
  const quotaProvider = env.AUTO_RESET_BILLING_POLICY ? () =>
    readGitHubQuota({ storage, policy: env.AUTO_RESET_BILLING_POLICY, runId: env.GITHUB_RUN_ID, now }) : null;
  if (command?.command === 'admin') {
    const result = await runInstallerAdmin({ storage, serialization, workflow, command,
      grant: env.AUTO_RESET_GITHUB_TOKEN, snapshot: env.AUTO_RESET_AUTH_BUNDLE, sessionFactory,
      oauth: new HostOAuth({ now }), verifierRuntime: new ExternalAuthRuntime({
        binary: fileURLToPath(new URL('../.runtime/codex', import.meta.url)) }),
      programCommit: env.AUTO_RESET_PROGRAM_COMMIT, pilotApproved, quotaProvider, quotaPolicy: env.AUTO_RESET_BILLING_POLICY ?? null, runId: env.GITHUB_RUN_ID, now });
    if (command.action === 'revoke-session') delete env.AUTO_RESET_AUTH_BUNDLE;
    const s = await storage.read(); language = s.settings.language;
    const summary = await renderInstallerReport(storage, command, result, now);
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, summary);
    process.stdout.write(`${JSON.stringify({ version: s.version, commandState: result.state, phase: s.installation.operation?.phase, problem: result.problem ?? null, ...(result.observer ? { observer: result.observer } : {}), ...(result.revokeValidation ? { revokeValidation: result.revokeValidation } : {}) })}\n`);
    if (result.problem) process.exitCode = 1;
  } else {
    const s = await storage.read();
    if (s.installation?.programCommit && s.installation.programCommit !== env.AUTO_RESET_PROGRAM_COMMIT) throw new StateFailure('program_version_conflict');
    let quotaReceipt = env.AUTO_RESET_QUOTA_RECEIPT, quotaProblem = null, quotaEvidence = null;
    if (quotaProvider) {
      try { const receipt = await quotaProvider(); quotaReceipt = JSON.stringify(receipt); quotaEvidence = receipt.evidence; }
      catch (error) { quotaReceipt = null; quotaProblem = error instanceof StateFailure ? error.kind : 'quota_provider_unavailable'; }
    }
    const result = await runPrivateJob({ storage, serialization, workflow,
      account: lazyAccount, quota: readQuotaReceipt(quotaReceipt, now()), command, event: env.GITHUB_EVENT_NAME, live: !wakeOnly, now });
    if (quotaProblem) result.summary += `\n${language === 'ru' ? 'Источник квоты недоступен' : 'Quota source unavailable'}: ${quotaProblem}\n`;
    if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, result.summary);
    const timerProblem = result.timerProblem ?? null;
    process.stdout.write(`${JSON.stringify({ version: result.report.version, problem: result.problem, quotaProblem, quotaEvidence, timerProblem,
      commandState: result.commandResult?.state ?? (command?.command === 'control' ? 'unconfirmed' : null) })}\n`);
    // A failed fallback run is the only notification that the external timer stopped.
    if (result.problem || quotaProblem || timerProblem || result.report.scheduler.publication !== 'confirmed') process.exitCode = 1;
  }
} catch (error) {
  const code = error instanceof AuthFailure || error instanceof StateFailure ? error.kind : 'private_job_failed';
  process.stdout.write(`${JSON.stringify({ error: code, message: language === 'ru' ? 'Запуск остановлен' : 'Job stopped' })}\n`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,
    `${language === 'ru' ? 'Операция не завершена; проверьте durable журнал по command ID' : 'Operation incomplete; check the durable command ID journal'}: ${code}\n` +
    // An expired or revoked installation token stops every job before state can be read.
    (code === 'stop_grant' ? `\n${language === 'ru' ? 'GitHub отклонил токен установки: он истёк, отозван или лишился прав. Выпустите новый и замените его — см. docs/support.md, «Токен установки истёк».' :
      'GitHub rejected the installation token: it expired, was revoked or lost permissions. Issue a new one and replace it — see docs/support.md, "Installation token expired".'}\n` : ''));
  process.exitCode = 1;
} finally {
  if (root) await rm(root, { recursive: true, force: true });
  lease?.release();
}
