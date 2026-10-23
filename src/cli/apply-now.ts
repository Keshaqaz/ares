import { CommandFailed, YES, resetName, attemptResult, deadline, byDeadline, runnableWorkflow, readSummary, failedRunAdvice, runWorkerNow,
  command, unfinished, switchUnfinished, WORKFLOW_FILE } from './common.ts';
import type { CommandOptions, Sleep } from './common.ts';
import { openWorker } from './active-worker.ts';
import type { Worker } from './active-worker.ts';
import { runWhileEnabled } from './pause.ts';
import { brokenOnGoogle } from './google.ts';
import type { RunOutcome } from '../worker/run.ts';
import type { Summary } from '../worker/summary.ts';
import type { WatchFiles } from './watch-files.ts';
import { t } from './language.ts';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// What became of the chosen reset, told by the summary before and after the run. outcome is
// the run's, failed what the user does about a failed run, details where to see the run.
interface Verdict { code: number; message: string }
interface Ran { after: Summary | null; outcome: RunOutcome | null; failed: string | null; details: string | null }
function verdict({ creditId, before, after, outcome, failed, details }: Ran & { creditId: string; before: Summary | null }): Verdict {
  const name = resetName(creditId);
  if (after?.lastApplied?.creditId === creditId && !same(after.lastApplied, before?.lastApplied)) {
    return { code: 0, message: t(`Reset ${name} applied.`, `Сброс ${name} применён.`) };
  }
  const attempt = after?.lastAttempt;
  if (attempt?.creditId === creditId && attempt.reason === 'apply_now' && !same(attempt, before?.lastAttempt)) {
    return { code: 1, message: t(`Reset ${name} not applied: ${attemptResult(attempt.result)}.`,
      `Сброс ${name} не применён: ${attemptResult(attempt.result)}.`) };
  }
  if (failed) return { code: 1, message: failed };
  if (outcome === 'pending') {
    return { code: 1, message: t('The result is not known yet: the worker will settle it on its next run. Check later: `aures status`.',
      'Результат пока неизвестен: воркер уточнит его при следующем запуске. Проверьте позже: `aures status`.') };
  }
  if (outcome === 'transient_error') {
    return { code: 1, message: t('ChatGPT is temporarily unavailable, the reset is not applied. Try again later.',
      'ChatGPT временно недоступен, сброс не применён. Повторите позже.') };
  }
  const more = details ? `\n${t('Details', 'Подробности')}: ${details}` : '';
  return { code: 1, message: t(`Reset ${name} not applied: the worker was busy with an earlier attempt. Try again later.${more}`,
    `Сброс ${name} не применён: воркер был занят прошлой попыткой. Повторите позже.${more}`) };
}

// The resets the user picks from, once the worker can take an application: null before its first
// read; paused as the install record says now. A worker on pause takes one too (ADR-0007): its
// schedule being off is no obstacle, so only the workflow has to be there. While a switch of
// platform is unfinished no worker takes one: the worker the record names may not be the only one
// with a live session, as long as the old one is not quenched.
export async function readyToApply(worker: Worker, files: Pick<WatchFiles, 'readInstall'>): Promise<{ before: Summary | null; paused: boolean }> {
  const install = await files.readInstall();
  if (install?.switching) throw new CommandFailed(switchUnfinished());
  const paused = install?.paused === true;
  if (worker.platform === 'google') return { before: (await worker.status()).summary as Summary | null, paused };
  if (paused) {
    if (await worker.api.workflowState(worker.repo.full_name, WORKFLOW_FILE) === null) throw new CommandFailed(unfinished());
  } else await runnableWorkflow(worker.api, worker.repo);
  return { before: await readSummary(worker.api, worker.repo), paused };
}

// Applies the reset regardless of the rules and tells what became of it: on GitHub in a
// dispatched run, on Google in doPost apply_now. before is the summary the user chose the reset
// from; wait is runWorkerNow's. A paused worker keeps its pause: on GitHub the run happens with
// the workflow briefly on and off again after.
export interface ApplyResetOptions {
  worker: Worker;
  creditId: string;
  before: Summary | null;
  now: () => number;
  sleep: Sleep;
  wait: (text: string | null) => void;
  paused?: boolean;
}
export async function applyReset({ worker, creditId, before, now, sleep, wait, paused = false }: ApplyResetOptions): Promise<Verdict> {
  if (worker.platform === 'google') {
    wait(t('The worker on Google is applying the reset…', 'Воркер на Google применяет сброс…'));
    const reply = await worker.ask('apply_now', { creditId }).finally(() => wait(null));
    const outcome = reply.outcome as RunOutcome;
    const failed = outcome === 'broken_state' ? brokenOnGoogle(reply.reason) : outcome === 'reauth_required' ? failedRunAdvice({ outcome }) : null;
    return verdict({ creditId, before, after: reply.summary as Summary | null, outcome, failed, details: null });
  }
  const { api, repo } = worker;
  const one = async () => {
    const { run, logged } = await runWorkerNow({ api, repo, inputs: { apply_now: creditId }, now, sleep, wait });
    const after = await readSummary(api, repo);
    const failed = run.conclusion === 'success' ? null : `${failedRunAdvice(logged ?? {})}\n${t('Details', 'Подробности')}: ${run.html_url}`;
    return verdict({ creditId, before, after, outcome: logged?.outcome ?? null, failed, details: run.html_url });
  };
  return paused ? await runWhileEnabled(worker, one) : one();
}

// `aures apply-now`: «Применить сейчас». The user picks one of the resets the
// worker last published; the worker applies it in a dispatched run regardless of the rules,
// and the command waits for that run.
export async function applyNow(options: CommandOptions): Promise<number> {
  const { io, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeZone } = options;
  return command('apply-now', io, async () => {
    const worker = await openWorker(options, 'apply-now');
    const { before, paused } = await readyToApply(worker, options.mac.files);
    if (!before) {
      throw new CommandFailed(t('The resets are not read yet. Try again after the next worker run.',
        'Сбросы ещё не прочитаны. Повторите после следующего запуска воркера.'));
    }
    const resets = byDeadline(before.resets);
    if (!resets.length) throw new CommandFailed(t('No resets.', 'Сбросов нет.'));

    io.print(t('Resets:', 'Сбросы:'));
    resets.forEach((reset, i) => io.print(`  ${i + 1}. ${resetName(reset.creditId)} — ${deadline(reset, timeZone)}`));
    let chosen: Summary['resets'][number] | null = null;
    while (!chosen) {
      const answer = (await io.prompt(t('Reset number (Enter — cancel): ', 'Номер сброса (Enter — отмена): '))).trim();
      if (!answer) { io.print(t('Cancelled.', 'Отменено.')); return 0; }
      chosen = resets[Number(answer) - 1] ?? null;
      if (!/^\d+$/.test(answer) || !chosen) { chosen = null; io.print(t(`Type a number from 1 to ${resets.length}.`, `Введите номер от 1 до ${resets.length}.`)); }
    }
    const { creditId } = chosen;
    const confirmed = (await io.prompt(t(`Apply ${resetName(creditId)} now? A reset is single-use. [y/N] `,
      `Применить ${resetName(creditId)} сейчас? Сброс одноразовый. [y/N] `))).trim().toLowerCase();
    if (!YES.includes(confirmed)) { io.print(t('Cancelled.', 'Отменено.')); return 0; }

    io.print(t('Applying…', 'Применяем…'));
    const { code, message } = await applyReset({ worker, creditId, before, now, sleep, wait: io.wait, paused });
    for (const line of message.split('\n')) io.print(line);
    return code;
  });
}
