import { CommandFailed, ATTEMPT_RESULTS, deadline, byDeadline, connectGitHub, installedWorker, runnableWorkflow, readSummary,
  failedRunAdvice, runWorkerNow, command } from './common.mjs';

const YES = ['y', 'yes', 'д', 'да'];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// What became of the chosen reset, told by the summary before and after the run.
function verdict({ creditId, before, after, run, logged }) {
  if (after?.lastApplied?.creditId === creditId && !same(after.lastApplied, before?.lastApplied)) {
    return { code: 0, message: `Сброс ${creditId} применён.` };
  }
  const attempt = after?.lastAttempt;
  if (attempt?.creditId === creditId && attempt.reason === 'apply_now' && !same(attempt, before?.lastAttempt)) {
    return { code: 1, message: `Сброс ${creditId} не применён: ${ATTEMPT_RESULTS[attempt.result] ?? attempt.result}.` };
  }
  if (run.conclusion !== 'success') return { code: 1, message: `${failedRunAdvice(logged ?? {})}\nЗапуск: ${run.html_url}` };
  if (logged?.outcome === 'pending') {
    return { code: 1, message: 'Результат применения неизвестен: воркер сверит его со списком сбросов на следующем запуске. ' +
      'Проверьте позже: `codex-auto-resets status`.' };
  }
  if (logged?.outcome === 'transient_error') return { code: 1, message: 'ChatGPT временно недоступен, сброс не применён. Повторите позже.' };
  return { code: 1, message: `Сброс ${creditId} не применён: воркер сначала сверял прежнюю попытку. Повторите позже.\nЗапуск: ${run.html_url}` };
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
    if (!before) throw new CommandFailed('Воркер ещё не прочитал выданные сбросы. Проверьте позже: `codex-auto-resets status`.');
    const resets = byDeadline(before.resets);
    if (!resets.length) throw new CommandFailed('Выданных сбросов нет: применять нечего.');

    io.print('Выданные сбросы:');
    resets.forEach((reset, i) => io.print(`  ${i + 1}. ${reset.creditId} — ${deadline(reset, timeZone)}`));
    let chosen = null;
    while (!chosen) {
      const answer = (await io.prompt('Номер сброса (Enter — отмена): ')).trim();
      if (!answer) { io.print('Отменено.'); return 0; }
      chosen = resets[Number(answer) - 1] ?? null;
      if (!/^\d+$/.test(answer) || !chosen) { chosen = null; io.print(`Введите номер от 1 до ${resets.length}.`); }
    }
    const { creditId } = chosen;
    const confirmed = (await io.prompt(`Применить ${creditId} сейчас? Сброс одноразовый. [y/N] `)).trim().toLowerCase();
    if (!YES.includes(confirmed)) { io.print('Отменено.'); return 0; }

    io.print('Запуск воркера…');
    const { run, logged } = await runWorkerNow({ api, repo, inputs: { apply_now: creditId }, now, sleep });
    const after = await readSummary(api, repo);
    const { code, message } = verdict({ creditId, before, after, run, logged });
    for (const line of message.split('\n')) io.print(line);
    return code;
  });
}
