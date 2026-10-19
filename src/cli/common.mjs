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
const OUTCOMES = ['idle', 'applied', 'pending', 'transient_error', 'reauth_required', 'broken_state', 'commit_failed',
  'revoked', 'revoke_failed'];

// A failure explained to the user in its message.
export class CommandFailed extends Error {}

export const UNFINISHED = 'Установка не завершена. Запустите `codex-auto-resets setup`.';
export const enableUrl = repo => `${repo.html_url}/actions/workflows/${WORKFLOW_FILE}`;

// Answers that confirm a one-way action.
export const YES = ['y', 'yes', 'д', 'да'];
export const onOff = value => value ? 'включено' : 'выключено';
export const CHATGPT_LOGIN = 'Вход в ChatGPT для воркера (Codex на этом компьютере не затронут).';
export const showCode = io => ({ userCode, verificationUrl }) => io.print(`Откройте ${verificationUrl} и введите код ${userCode}`);
export const formatTime = (ms, timeZone) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZone, timeZoneName: 'short' }).format(ms);

// The two general rules as the user reads them in rules, status and the Actions Summary.
export const RULE_LABELS = { beforeExpiry: 'Перед истечением (в последние 8 часов)', weeklyAutoApply: 'Когда кончится недельный лимит' };
export const REASONS = { before_expiry: 'перед истечением', weekly: 'кончился недельный лимит', apply_now: 'вручную' };
// lastAttempt.result of an attempt that did not apply the reset.
export const ATTEMPT_RESULTS = {
  nothing_to_reset: 'сбрасывать нечего, сброс сохранён',
  no_credit: 'ChatGPT не принял сброс',
  missing: 'сброс уже недоступен',
  unknown: 'неясно, применён он или истёк',
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
      io.print('Вход в GitHub устарел, войдите снова.');
    }
  }
  io.print('Вход в GitHub.');
  token = await githubDeviceLogin({ fetch, now, sleep, onCode: showCode(io) });
  const api = new GitHubApi({ fetch, token });
  const login = await api.login();
  try { await keychain.write(token); } catch (error) {
    if (!(error instanceof KeychainUnavailable)) throw error;
    io.print('Не удалось сохранить вход в Связку ключей: в следующий раз GitHub попросит войти снова.');
  }
  io.print(`Вы вошли в GitHub как ${login}.`);
  return { api, login };
}

// The worker repository as setup left it; null when there is none. A repository of that
// name without our mark, or a public one, is never touched.
export async function workerRepository({ api, login }) {
  const repo = await api.repository(`${login}/${WORKER_REPOSITORY}`);
  if (!repo) return null;
  if (repo.description !== WORKER_DESCRIPTION) {
    throw new CommandFailed(`Репозиторий ${repo.html_url} создан не codex-auto-resets. ` +
      'Переименуйте или удалите его и повторите `codex-auto-resets setup`.');
  }
  // The repository holds the sealed session and the reset schedule.
  if (!repo.private) throw new CommandFailed(`Репозиторий ${repo.html_url} открыт всем. Сделайте его приватным и повторите \`codex-auto-resets setup\`.`);
  return repo;
}

// The worker repository for a command that needs an installed worker.
export async function installedWorker(options) {
  const repo = await workerRepository(options);
  if (!repo) throw new CommandFailed('Воркер не установлен. Запустите `codex-auto-resets setup`.');
  return repo;
}

// The workflow must be able to take a dispatch.
export async function runnableWorkflow(api, repo) {
  const state = await api.workflowState(repo.full_name, WORKFLOW_FILE);
  if (!state) throw new CommandFailed(UNFINISHED);
  if (state !== 'active') throw new CommandFailed(`Воркер выключен в GitHub. Включите его кнопкой Enable workflow: ${enableUrl(repo)}`);
}

export async function chooseRules(io, initial = { beforeExpiry: true, weeklyAutoApply: false }) {
  const rules = { beforeExpiry: initial.beforeExpiry, weeklyAutoApply: initial.weeklyAutoApply };
  for (;;) {
    io.print('Когда применять сбросы:');
    io.print(`  1. ${RULE_LABELS.beforeExpiry} — ${onOff(rules.beforeExpiry)}`);
    io.print(`  2. ${RULE_LABELS.weeklyAutoApply} — ${onOff(rules.weeklyAutoApply)}`);
    const answer = (await io.prompt('Enter — готово, 1 или 2 — переключить: ')).trim();
    if (!answer) return { formatVersion: RULES_FORMAT_VERSION, ...rules };
    if (answer === '1') rules.beforeExpiry = !rules.beforeExpiry;
    else if (answer === '2') rules.weeklyAutoApply = !rules.weeklyAutoApply;
    else io.print('Введите 1, 2 или нажмите Enter.');
  }
}

// What the worker publishes openly (summary.json), or null before its first read.
export async function readSummary(api, repo) {
  const file = await api.file(repo.full_name, FILES.summary);
  if (!file) return null;
  try { return JSON.parse(file.text); } catch { throw new CommandFailed('Данные воркера не читаются. Повторите после его следующего запуска.'); }
}

// The line that tells the user the worker works, from its summary.
export function workingLine(summary, timeZone) {
  const resets = summary.resets ?? [];
  const deadlines = resets.map(r => r.expiresAt && Date.parse(r.expiresAt)).filter(Boolean).sort((a, b) => a - b);
  if (!deadlines.length) return `Воркер работает. Сбросов: ${resets.length}.`;
  return `Воркер работает. Сбросов: ${resets.length}, ближайший истекает ${formatTime(deadlines[0], timeZone)}.`;
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
    reauth_required: 'Воркер потерял вход в ChatGPT. Войдите заново: `codex-auto-resets login`.',
    broken_state: reason?.startsWith('rules_') ?
      `Файл правил не читается (${reason}). Удалите ${FILES.rules} в репозитории и повторите \`codex-auto-resets setup\`.` :
      `Файл со входом в ChatGPT не читается (${reason}). Удалите ${FILES.state} в репозитории и повторите \`codex-auto-resets setup\`: ` +
      'он попросит войти в ChatGPT заново.',
    commit_failed: 'Воркер не смог сохранить данные в репозитории. Повторите `codex-auto-resets setup`. ' +
      'Если потом придёт письмо об ошибке воркера, войдите заново: `codex-auto-resets login`.',
  }[outcome] ?? 'Воркер завершился с ошибкой.';
}

// Dispatches one worker run with these inputs and waits for it. Returns the completed run
// and the outcome from its log (null when the log does not show one).
export async function runWorkerNow({ api, repo, inputs, now, sleep }) {
  const name = repo.full_name;
  const known = new Set((await api.dispatchRuns(name, WORKFLOW_FILE)).map(run => run.id));
  const deadline = now() + RUN_TIMEOUT_MS;
  // GitHub learns about a freshly pushed workflow with a delay.
  while (!await api.dispatch(name, WORKFLOW_FILE, { ref: repo.default_branch, inputs: { apply_now: '', ...inputs } })) {
    if (now() >= deadline) throw new CommandFailed('GitHub ещё не готов запустить воркер. Повторите через несколько минут.');
    await sleep(POLL_MS);
  }
  let run = null;
  for (;;) {
    run = run ? await api.run(name, run.id) : (await api.dispatchRuns(name, WORKFLOW_FILE)).find(r => !known.has(r.id)) ?? null;
    if (run?.status === 'completed') break;
    if (now() >= deadline) {
      throw new CommandFailed(run ? `Воркер работает дольше 10 минут. Проверьте позже: ${run.html_url}` :
        `GitHub не запустил воркер за 10 минут. Проверьте: ${repo.html_url}/actions`);
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
  const again = `Повторите \`codex-auto-resets ${command}\``;
  if (error instanceof GitHubFailure) {
    return {
      unauthorized: `GitHub отклонил вход. ${again} и войдите заново.`,
      network: `GitHub недоступен. ${again}: сделанное сохранится.`,
      login_timeout: `Время на ввод кода GitHub вышло. ${again}.`,
      login_denied: 'Вход в GitHub отклонён.',
    }[error.reason] ?? `Ошибка GitHub (${error.reason}). ${again}: сделанное сохранится.`;
  }
  if (error instanceof LoginFailed) {
    return error.reason === 'timeout' ? `Время на ввод кода ChatGPT вышло. ${again}.` :
      `Не удалось войти в ChatGPT (${error.reason}). ${again}.`;
  }
  if (error instanceof TransientFailure) return `ChatGPT недоступен. ${again}: сделанное сохранится.`;
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
