import { CommandFailed, YES, attemptResult, deadline, byDeadline, connectGitHub, installedWorker, runnableWorkflow, readSummary,
  failedRunAdvice, runWorkerNow, command } from './common.mjs';
import { t } from './language.mjs';

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// What became of the chosen reset, told by the summary before and after the run.
function verdict({ creditId, before, after, run, logged }) {
  if (after?.lastApplied?.creditId === creditId && !same(after.lastApplied, before?.lastApplied)) {
    return { code: 0, message: t(`Reset ${creditId} applied.`, `Сброс ${creditId} применён.`) };
  }
  const attempt = after?.lastAttempt;
  if (attempt?.creditId === creditId && attempt.reason === 'apply_now' && !same(attempt, before?.lastAttempt)) {
    return { code: 1, message: t(`Reset ${creditId} not applied: ${attemptResult(attempt.result)}.`,
      `Сброс ${creditId} не применён: ${attemptResult(attempt.result)}.`) };
  }
  if (run.conclusion !== 'success') return { code: 1, message: `${failedRunAdvice(logged ?? {})}\n${t('Details', 'Подробности')}: ${run.html_url}` };
  if (logged?.outcome === 'pending') {
    return { code: 1, message: t('The result is not known yet: the worker will settle it on its next run. Check later: `codex-auto-resets status`.',
      'Результат пока неизвестен: воркер уточнит его при следующем запуске. Проверьте позже: `codex-auto-resets status`.') };
  }
  if (logged?.outcome === 'transient_error') {
    return { code: 1, message: t('ChatGPT is temporarily unavailable, the reset is not applied. Try again later.',
      'ChatGPT временно недоступен, сброс не применён. Повторите позже.') };
  }
  return { code: 1, message: t(`Reset ${creditId} not applied: the worker was busy with an earlier attempt. Try again later.\nDetails: ${run.html_url}`,
    `Сброс ${creditId} не применён: воркер был занят прошлой попыткой. Повторите позже.\nПодробности: ${run.html_url}`) };
}

// Applies the reset in a dispatched run regardless of the rules and tells what became of it.
// before is the summary the user chose the reset from; wait is runWorkerNow's.
export async function applyReset({ api, repo, creditId, before, now, sleep, wait }) {
  const { run, logged } = await runWorkerNow({ api, repo, inputs: { apply_now: creditId }, now, sleep, wait });
  const after = await readSummary(api, repo);
  return verdict({ creditId, before, after, run, logged });
}

// `codex-auto-resets apply-now`: «Применить сейчас». The user picks one of the resets the
// worker last published; the worker applies it in a dispatched run regardless of the rules,
// and the command waits for that run.
export async function applyNow({ fetch, keychain, io, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeZone }) {
  return command('apply-now', io, async () => {
    const { api, login } = await connectGitHub({ fetch, keychain, io, now, sleep });
    const repo = await installedWorker({ api, login });
    await runnableWorkflow(api, repo);
    const before = await readSummary(api, repo);
    if (!before) {
      throw new CommandFailed(t('The resets are not read yet. Try again after the next worker run.',
        'Сбросы ещё не прочитаны. Повторите после следующего запуска воркера.'));
    }
    const resets = byDeadline(before.resets);
    if (!resets.length) throw new CommandFailed(t('No resets.', 'Сбросов нет.'));

    io.print(t('Resets:', 'Сбросы:'));
    resets.forEach((reset, i) => io.print(`  ${i + 1}. ${reset.creditId} — ${deadline(reset, timeZone)}`));
    let chosen = null;
    while (!chosen) {
      const answer = (await io.prompt(t('Reset number (Enter — cancel): ', 'Номер сброса (Enter — отмена): '))).trim();
      if (!answer) { io.print(t('Cancelled.', 'Отменено.')); return 0; }
      chosen = resets[Number(answer) - 1] ?? null;
      if (!/^\d+$/.test(answer) || !chosen) { chosen = null; io.print(t(`Type a number from 1 to ${resets.length}.`, `Введите номер от 1 до ${resets.length}.`)); }
    }
    const { creditId } = chosen;
    const confirmed = (await io.prompt(t(`Apply ${creditId} now? A reset is single-use. [y/N] `,
      `Применить ${creditId} сейчас? Сброс одноразовый. [y/N] `))).trim().toLowerCase();
    if (!YES.includes(confirmed)) { io.print(t('Cancelled.', 'Отменено.')); return 0; }

    io.print(t('Applying…', 'Применяем…'));
    const { code, message } = await applyReset({ api, repo, creditId, before, now, sleep, wait: io.wait });
    for (const line of message.split('\n')) io.print(line);
    return code;
  });
}
