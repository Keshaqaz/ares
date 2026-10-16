import { CycleEngine } from '../core/reset-cycles.mjs';
import { SchedulePlanner, probeConfirmed, timerProblem } from '../schedule/schedule-planner.mjs';
import { initialScheduler } from '../schedule/schedule-state.mjs';
import { renderCycleReport } from '../core/cycle-report.mjs';
import { StateFailure } from '../core/state-store.mjs';
import { AuthFailure } from '../session/auth-bundle.mjs';
import { withInstallationWriter } from './private-workflow.mjs';
import { tokenReminder } from '../installer/installer-token.mjs';

export function readQuotaReceipt(raw, now) {
  try {
    const value = JSON.parse(raw);
    // A cached or unverified billing snapshot must not authorize unattended spend.
    if (!Number.isSafeInteger(value.observedAt) || value.observedAt > now || now - value.observedAt > 300) return null;
    return { ...value.quota, validUntil: value.observedAt + 301 };
  } catch { return null; }
}
const reason = error => error instanceof StateFailure || error instanceof AuthFailure ? error.kind : 'job_failed';
const words = {
  ru: { stopped: 'Запуск остановлен', accepted: 'Команда принята и сохранена', pending: 'Команда не подтверждена',
    timer: 'Резервный запуск: внешний таймер не будил установку в плановые слоты. Проверьте Worker Cloudflare и приложение таймера',
    dispatch: 'HTTP dispatch не подтверждает принятие команды. Сверьте command ID в журнале; повторяйте с тем же ID и содержимым.' },
  en: { stopped: 'Job stopped', accepted: 'Command durably accepted', pending: 'Command unconfirmed',
    timer: 'Fallback run: the external timer did not wake the installation in planned slots. Check the Cloudflare Worker and timer app',
    dispatch: 'HTTP dispatch does not confirm command acceptance. Check the command ID journal; redeliver the same ID and payload.' },
};

// Scheduled, manual and installer/admin work share this full job lease. State is
// read only after acquisition; no checkout snapshot is an authoritative document.
// event 'schedule' is the static daily fallback (ADR-0002): reconcile and timer check only,
// never an account read or a planned attempt. An empty workflow_dispatch is an external wake;
// live false (pilot gate closed) limits it to the same reconcile and the timer probe.
export async function runPrivateJob({ storage, workflow, serialization, account, quota = null,
  command = null, event = null, live = true, now = () => Math.floor(Date.now() / 1000), checkpoint = async () => {} }) {
  return withInstallationWriter(serialization, async () => {
    await storage.preflight();
    const initial = await storage.read();
    const engine = new CycleEngine(storage, account, { now, checkpoint });
    const planner = new SchedulePlanner(storage, workflow, { now });
    if (initial.installation?.operation?.phase === 'pending') {
      const report = await engine.status();
      return { report, commandResult: null, problem: 'admin_recovery_required', summary: renderCycleReport(report) + '\nadmin_recovery_required\n' };
    }
    const fallback = event === 'schedule';
    // Judge the plan that was in effect before this run's own reconcile can replace it.
    const stale = fallback ? timerProblem(initial.scheduler, now()) : null;
    let commandResult = null, problem = null;
    try {
      if (command) {
        // Status is read-only. Control arrives only from a sealed envelope (readDispatchCommand)
        // and uses the existing durable ID/fingerprint/CAS journal.
        if (command.command === 'control') {
          const { command: ignored, ...control } = command;
          commandResult = await engine.command(control);
        } else if (command.command !== 'status' || Object.keys(command).length !== 1) {
          throw new StateFailure('invalid_command');
        }
      }
      await storage.update(s => {
        s.scheduler ??= initialScheduler();
        if (event === 'workflow_dispatch' && !command) {
          s.scheduler.wokenAt = now();
          // The installer refuses enable until the Worker has woken the probe slot (ticket 38).
          if (probeConfirmed(s.installation?.timer, now())) s.installation.timer.confirmedAt = now();
        }
      });
      const resume = command?.command === 'control' && command.action === 'resume' &&
        commandResult?.state === 'accepted' && !commandResult.duplicate;
      await planner.reconcile({ quota, resume });
      const state = await storage.read();
      if (command?.command !== 'status' && !fallback && live && !state.disabled && !state.revoked && !state.reconnectRequested &&
          !state.requests.some(r => r.state === 'unconfirmed') && state.scheduler.mode === 'active') {
        await engine.refresh();
        if (account.problem) throw new AuthFailure(account.problem);
        await engine.run();
      }
    } catch (error) { problem = reason(error); }
    // Also attempts quota/disable/success cleanup after auth or consume failure.
    // A failure stays unconfirmed in state/Summary, never advertised as saved minutes.
    try { await planner.reconcile({ quota }); }
    catch (error) { problem ??= reason(error); }
    if (problem === null || problem === 'job_stopped') problem = account.problem ?? problem;
    const report = await engine.status();
    if (report.scheduler.publication !== 'confirmed') {
      problem ??= report.scheduler.problem ?? 'schedule_publication_unconfirmed';
    }
    const w = words[initial.settings.language];
    const reminder = tokenReminder(initial.installation?.grant?.expiresAt, initial.settings.language, now());
    const summary = [renderCycleReport(report), problem ? `${w.stopped}: ${problem}\n` : '',
      stale ? `${w.timer}: ${stale}\n` : '', reminder ? `${reminder}\n` : '',
      command?.command === 'control' ? `${commandResult ? w.accepted : w.pending}\n\n${w.dispatch}\n` : ''].filter(Boolean).join('\n');
    return { report, commandResult, problem, timerProblem: stale, summary };
  });
}
