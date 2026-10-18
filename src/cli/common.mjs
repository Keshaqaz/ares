// What every command shares: the GitHub login, the worker repository, a worker run started
// from the CLI and the words the user sees when something fails.
import { GitHubApi, GitHubFailure, githubDeviceLogin } from '../github/api.mjs';
import { LoginFailed } from '../chatgpt/session.mjs';
import { TransientFailure } from '../chatgpt/http.mjs';
import { FILES } from '../worker/layout.mjs';
import { RULES_FORMAT_VERSION } from '../worker/state-file.mjs';
import { KeychainUnavailable } from './keychain.mjs';

export const WORKER_REPOSITORY = 'codex-auto-resets-worker';
// The mark that tells our repository from a foreign one with the same name. It is set in
// the same call that creates the repository, so an interrupted setup always leaves it.
export const WORKER_DESCRIPTION = 'Worker of codex-auto-resets: applies issued ChatGPT resets by the general rules. Managed by the codex-auto-resets CLI.';
export const WORKFLOW_FILE = FILES.workflow.split('/').at(-1);
const RUN_TIMEOUT_MS = 10 * 60_000, POLL_MS = 5_000;
// Job logs appear a few seconds after the run completes.
const LOG_ATTEMPTS = 4;
const OUTCOMES = ['idle', 'applied', 'pending', 'transient_error', 'reauth_required', 'broken_state', 'commit_failed'];

// A failure explained to the user in its message.
export class CommandFailed extends Error {}

export const onOff = value => value ? 'включено' : 'выключено';
export const showCode = io => ({ userCode, verificationUrl }) => io.print(`Откройте ${verificationUrl} и введите код ${userCode}`);
export const formatTime = (ms, timeZone) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZone, timeZoneName: 'short' }).format(ms);

export const REASONS = { before_expiry: 'правило перед истечением', weekly: 'исчерпание недельной квоты', apply_now: 'Применить сейчас' };
// lastAttempt.result of an attempt that did not apply the reset.
export const ATTEMPT_RESULTS = {
  nothing_to_reset: 'ChatGPT ответил, что сбрасывать нечего; сброс не потрачен',
  no_credit: 'ChatGPT не принял сброс',
  missing: 'сброса уже не было в списке выданных',
  unknown: 'результат неизвестен: сброс пропал из списка уже после срока активации',
};

export const deadline = (reset, timeZone) => reset.expiresAt ? `истекает ${formatTime(Date.parse(reset.expiresAt), timeZone)}` : 'без срока';
export const byDeadline = resets => [...resets].sort((a, b) =>
  (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity));

export async function connectGitHub({ fetch, keychain, io, now, sleep }) {
  let token = null;
  try { token = await keychain.read(); } catch (error) { if (!(error instanceof KeychainUnavailable)) throw error; }
  if (token) {
    const api = new GitHubApi({ fetch, token });
    try { return { api, login: await api.login() }; } catch (error) {
      if (error.reason !== 'unauthorized') throw error;
      io.print('Токен GitHub из Keychain больше не действует, нужен новый вход.');
    }
  }
  io.print('Вход в GitHub.');
  token = await githubDeviceLogin({ fetch, now, sleep, onCode: showCode(io) });
  const api = new GitHubApi({ fetch, token });
  const login = await api.login();
  try { await keychain.write(token); } catch (error) {
    if (!(error instanceof KeychainUnavailable)) throw error;
    io.print('Keychain недоступен: токен GitHub не сохранён, следующая команда снова попросит войти.');
  }
  io.print(`GitHub: ${login}.`);
  return { api, login };
}

// The worker repository as setup left it; null when there is none. A repository of that
// name without our mark, or a public one, is never touched.
export async function workerRepository({ api, login }) {
  const repo = await api.repository(`${login}/${WORKER_REPOSITORY}`);
  if (!repo) return null;
  if (repo.description !== WORKER_DESCRIPTION) {
    throw new CommandFailed(`В аккаунте уже есть репозиторий ${repo.html_url}, но его создал не codex-auto-resets. ` +
      'Переименуйте или удалите его и запустите setup снова.');
  }
  // The repository holds the sealed session and the reset schedule.
  if (!repo.private) throw new CommandFailed(`Репозиторий воркера ${repo.html_url} публичный. Сделайте его приватным в настройках репозитория и запустите setup снова.`);
  return repo;
}

// The worker repository for a command that needs an installed worker.
export async function installedWorker(options) {
  const repo = await workerRepository(options);
  if (!repo) throw new CommandFailed('Воркер не установлен. Установите его: `codex-auto-resets setup`.');
  return repo;
}

// The workflow must be able to take a dispatch.
export async function runnableWorkflow(api, repo) {
  const state = await api.workflowState(repo.full_name, WORKFLOW_FILE);
  if (!state) throw new CommandFailed('В репозитории нет workflow воркера: установка не завершена. Запустите `codex-auto-resets setup`.');
  if (state !== 'active') {
    throw new CommandFailed(`Workflow воркера отключён в GitHub. Включите его кнопкой Enable workflow: ` +
      `${repo.html_url}/actions/workflows/${WORKFLOW_FILE}`);
  }
}

export async function chooseRules(io, initial = { beforeExpiry: true, weeklyAutoApply: false }) {
  const rules = { beforeExpiry: initial.beforeExpiry, weeklyAutoApply: initial.weeklyAutoApply };
  for (;;) {
    io.print('Общие правила:');
    io.print(`  1. Перед истечением (попытки в последние 8 часов срока активации) — ${onOff(rules.beforeExpiry)}`);
    io.print(`  2. Автоприменение при исчерпании недельной квоты — ${onOff(rules.weeklyAutoApply)}`);
    const answer = (await io.prompt('Enter — принять, 1 или 2 — переключить правило: ')).trim();
    if (!answer) return { formatVersion: RULES_FORMAT_VERSION, ...rules };
    if (answer === '1') rules.beforeExpiry = !rules.beforeExpiry;
    else if (answer === '2') rules.weeklyAutoApply = !rules.weeklyAutoApply;
    else io.print('Нажмите Enter или введите 1 либо 2.');
  }
}

// What the worker publishes openly (summary.json), or null before its first read.
export async function readSummary(api, repo) {
  const file = await api.file(repo.full_name, FILES.summary);
  if (!file) return null;
  try { return JSON.parse(file.text); } catch { throw new CommandFailed(`Сводка воркера ${FILES.summary} не читается. Дождитесь следующего запуска воркера.`); }
}

// The line that tells the user the worker works, from its summary.
export function workingLine(summary, timeZone) {
  const resets = summary.resets ?? [];
  const deadlines = resets.map(r => r.expiresAt && Date.parse(r.expiresAt)).filter(Boolean).sort((a, b) => a - b);
  if (!deadlines.length) return `Работает. Сбросов: ${resets.length}.`;
  return `Работает. Сбросов: ${resets.length}, ближайший истекает ${formatTime(deadlines[0], timeZone)}.`;
}

// The last outcome the worker printed into its job log, e.g. «2026-…Z broken_state: key_invalid».
export function loggedOutcome(log) {
  let found = null;
  for (const line of (log ?? '').split('\n')) {
    const match = line.match(/^(?:\S+Z )?([a-z_]+)(?:: ([a-z0-9_]+))?\s*$/);
    if (match && OUTCOMES.includes(match[1])) found = { outcome: match[1], reason: match[2] ?? null };
  }
  return found;
}

// What the user does about a run that failed with this outcome.
export function failedRunAdvice({ outcome, reason } = {}) {
  return {
    reauth_required: 'ChatGPT отклонил сессию воркера. Войдите заново: `codex-auto-resets login`.',
    broken_state: reason?.startsWith('rules_') ?
      `Воркер не смог прочитать правила (${reason}). Удалите ${FILES.rules} в репозитории и запустите setup снова.` :
      `Воркер не смог открыть файл с сессией воркера (${reason}). Удалите ${FILES.state} в репозитории и запустите setup снова: понадобится новый вход в ChatGPT.`,
    commit_failed: 'Воркер не смог сохранить сессию воркера в репозитории. Запустите setup снова; если GitHub пришлёт письмо о потере сессии, войдите заново: `codex-auto-resets login`.',
  }[outcome] ?? 'Запуск воркера завершился ошибкой.';
}

// Dispatches one worker run with these inputs and waits for it. Returns the completed run
// and the outcome from its log (null when the log does not show one).
export async function runWorkerNow({ api, repo, inputs, now, sleep }) {
  const name = repo.full_name;
  const known = new Set((await api.dispatchRuns(name, WORKFLOW_FILE)).map(run => run.id));
  const deadline = now() + RUN_TIMEOUT_MS;
  // GitHub learns about a freshly pushed workflow with a delay.
  while (!await api.dispatch(name, WORKFLOW_FILE, { ref: repo.default_branch, inputs: { apply_now: '', ...inputs } })) {
    if (now() >= deadline) throw new CommandFailed('GitHub так и не увидел workflow воркера. Повторите команду через несколько минут.');
    await sleep(POLL_MS);
  }
  let run = null;
  for (;;) {
    run = run ? await api.run(name, run.id) : (await api.dispatchRuns(name, WORKFLOW_FILE)).find(r => !known.has(r.id)) ?? null;
    if (run?.status === 'completed') break;
    if (now() >= deadline) {
      throw new CommandFailed(run ? `Запуск воркера не завершился за 10 минут. Проверьте его позже: ${run.html_url}` :
        `GitHub не начал запуск воркера за 10 минут. Проверьте Actions: ${repo.html_url}/actions`);
    }
    await sleep(POLL_MS);
  }
  let logged = null;
  for (let attempt = 1; !logged && attempt <= LOG_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(POLL_MS);
    logged = loggedOutcome(await api.runLog(name, run.id).catch(() => null));
  }
  return { run, logged };
}

// The message for a failure this module knows, or null. command names what to repeat.
export function explain(error, command) {
  if (error instanceof CommandFailed) return error.message;
  if (error instanceof GitHubFailure) {
    return {
      unauthorized: `GitHub отклонил токен. Запустите ${command} снова, чтобы войти заново.`,
      network: `GitHub недоступен. Запустите ${command} снова: уже сделанное сохранится.`,
      login_timeout: `Код GitHub не был введён вовремя. Запустите ${command} снова.`,
      login_denied: 'Вход в GitHub отклонён.',
    }[error.reason] ?? `GitHub ответил ошибкой (${error.reason}). Запустите ${command} снова: уже сделанное сохранится.`;
  }
  if (error instanceof LoginFailed) {
    return error.reason === 'timeout' ? `Код ChatGPT не был введён за 15 минут. Запустите ${command} снова.` :
      `Вход в ChatGPT не удался (${error.reason}). Запустите ${command} снова.`;
  }
  if (error instanceof TransientFailure) return `ChatGPT недоступен. Запустите ${command} снова: уже сделанное сохранится.`;
  return null;
}

// Runs a command body and turns known failures into their message and exit code 1.
export async function command(name, io, body) {
  try {
    return await body();
  } catch (error) {
    const message = explain(error, name);
    if (message === null) throw error;
    for (const line of message.split('\n')) io.print(line);
    return 1;
  }
}
