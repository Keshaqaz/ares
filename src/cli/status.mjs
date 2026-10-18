import { FILES } from '../worker/layout.mjs';
import { readRules, BrokenState } from '../worker/state-file.mjs';
import { WORKFLOW_FILE, REASONS, ATTEMPT_RESULTS, onOff, formatTime, deadline, byDeadline, connectGitHub, installedWorker,
  readSummary, loggedOutcome, failedRunAdvice, command } from './common.mjs';

// The cron runs hourly and GitHub may delay it by an hour or two; the before-expiry rule
// leaves 8 hours, so a longer silence is worth the user's attention.
export const STALE_MS = 4 * 3600_000;

// A run as the user reads it: when it started and how it ended.
function runLine(run, timeZone) {
  const verdict = run.status !== 'completed' ? 'идёт сейчас' : run.conclusion === 'success' ? 'успешно' : 'с ошибкой';
  return `${formatTime(Date.parse(run.run_started_at ?? run.created_at), timeZone)}, ${verdict}: ${run.html_url}`;
}

// `codex-auto-resets status`: what the worker publishes openly (it cannot read the sealed
// state), the rules and the worker's last run, with a warning when the worker is not running.
export async function status({ fetch, keychain, io, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeZone }) {
  return command('status', io, async () => {
    const { api, login } = await connectGitHub({ fetch, keychain, io, now, sleep });
    const repo = await installedWorker({ api, login });
    const name = repo.full_name;
    const [summary, rulesFile, workflowState, lastRun] = await Promise.all([readSummary(api, repo), api.file(name, FILES.rules),
      api.workflowState(name, WORKFLOW_FILE), api.latestRun(name, WORKFLOW_FILE)]);

    io.print(`Репозиторий воркера: ${repo.html_url}`);
    if (!summary) io.print('Выданные сбросы: воркер их ещё не прочитал.');
    else if (!summary.resets.length) io.print('Выданных сбросов нет.');
    else {
      io.print(`Выданные сбросы (${summary.resets.length}):`);
      for (const reset of byDeadline(summary.resets)) io.print(`  ${reset.creditId} — ${deadline(reset, timeZone)}`);
    }
    let rules = null;
    try { rules = rulesFile && readRules(rulesFile.text); } catch (error) { if (!(error instanceof BrokenState)) throw error; }
    io.print(rules ? `Правила: перед истечением — ${onOff(rules.beforeExpiry)}; автоприменение при исчерпании недельной квоты — ` +
      `${onOff(rules.weeklyAutoApply)}.` : `Правила: файл ${FILES.rules} не читается.`);
    if (lastRun) io.print(`Последний запуск воркера: ${runLine(lastRun, timeZone)}`);
    const applied = summary?.lastApplied;
    io.print(applied ? `Последнее применение: ${applied.creditId}, ${formatTime(Date.parse(applied.at), timeZone)} ` +
      `(${REASONS[applied.reason] ?? applied.reason}).` : 'Сбросы ещё не применялись.');
    const attempt = summary?.lastAttempt;
    if (attempt && attempt.result !== 'reset' && (!applied || attempt.at > applied.at)) {
      io.print(`Последняя попытка: ${attempt.creditId}, ${formatTime(Date.parse(attempt.at), timeZone)} — ` +
        `${ATTEMPT_RESULTS[attempt.result] ?? attempt.result}.`);
    }

    const warnings = [];
    if (!workflowState) warnings.push('В репозитории нет workflow воркера: установка не завершена. Запустите `codex-auto-resets setup`.');
    else if (workflowState !== 'active') {
      warnings.push(`Workflow воркера отключён в GitHub: воркер не запускается и сбросы не применяются. Включите его кнопкой ` +
        `Enable workflow: ${repo.html_url}/actions/workflows/${WORKFLOW_FILE}`);
    } else if (!lastRun) warnings.push('Воркер ещё ни разу не запускался.');
    else {
      const silent = now() - Date.parse(lastRun.run_started_at ?? lastRun.created_at);
      if (silent > STALE_MS) {
        warnings.push(`Воркер не запускался ${Math.floor(silent / 3600_000)} ч, хотя должен раз в час. ` +
          `Проверьте Actions: ${repo.html_url}/actions`);
      }
    }
    if (lastRun?.status === 'completed' && lastRun.conclusion !== 'success') {
      const logged = loggedOutcome(await api.runLog(name, lastRun.id).catch(() => null));
      warnings.push(`Последний запуск завершился ошибкой. ${failedRunAdvice(logged ?? {})}`);
    }
    for (const warning of warnings) io.print(`Внимание: ${warning}`);
    return 0;
  });
}
