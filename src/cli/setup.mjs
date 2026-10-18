import { GitHubApi, GitHubFailure, githubDeviceLogin } from '../github/api.mjs';
import { deviceLogin, LoginFailed } from '../chatgpt/session.mjs';
import { TransientFailure } from '../chatgpt/http.mjs';
import { FILES, STATE_KEY_SECRET } from '../worker/layout.mjs';
import { generateKey, sealState, STATE_FORMAT_VERSION, RULES_FORMAT_VERSION } from '../worker/state-file.mjs';
import { workflowYaml } from '../worker/workflow.mjs';
import { KeychainUnavailable } from './keychain.mjs';

export const WORKER_REPOSITORY = 'codex-auto-resets-worker';
// The mark that tells our repository from a foreign one with the same name. It is set in
// the same call that creates the repository, so an interrupted setup always leaves it.
export const WORKER_DESCRIPTION = 'Worker of codex-auto-resets: applies issued ChatGPT resets by the general rules. Managed by the codex-auto-resets CLI.';
const WORKFLOW_FILE = FILES.workflow.split('/').at(-1);
const TRIAL_TIMEOUT_MS = 10 * 60_000, POLL_MS = 5_000;
// Job logs appear a few seconds after the run completes.
const LOG_ATTEMPTS = 4;
const OUTCOMES = ['idle', 'applied', 'pending', 'transient_error', 'reauth_required', 'broken_state', 'commit_failed'];

// A failure explained to the user in its message.
class SetupFailed extends Error {}

const onOff = value => value ? 'включено' : 'выключено';
const showCode = io => ({ userCode, verificationUrl }) => io.print(`Откройте ${verificationUrl} и введите код ${userCode}`);

async function connectGitHub({ fetch, keychain, io, now, sleep }) {
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

async function workerRepository({ api, login, io }) {
  const repo = await api.repository(`${login}/${WORKER_REPOSITORY}`);
  if (!repo) {
    const created = await api.createRepository({ name: WORKER_REPOSITORY, description: WORKER_DESCRIPTION });
    io.print(`Создан приватный репозиторий воркера: ${created.html_url}`);
    return created;
  }
  if (repo.description !== WORKER_DESCRIPTION) {
    throw new SetupFailed(`В аккаунте уже есть репозиторий ${repo.html_url}, но его создал не codex-auto-resets. ` +
      'Переименуйте или удалите его и запустите setup снова.');
  }
  // The repository holds the sealed session and the reset schedule.
  if (!repo.private) throw new SetupFailed(`Репозиторий воркера ${repo.html_url} публичный. Сделайте его приватным в настройках репозитория и запустите setup снова.`);
  io.print(`Найден репозиторий воркера: ${repo.html_url}`);
  return repo;
}

async function chooseRules(io) {
  const rules = { beforeExpiry: true, weeklyAutoApply: false };
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

// The last outcome the worker printed into its job log, e.g. «2026-…Z broken_state: key_invalid».
function loggedOutcome(log) {
  let found = null;
  for (const line of (log ?? '').split('\n')) {
    const match = line.match(/^(?:\S+Z )?([a-z_]+)(?:: ([a-z0-9_]+))?\s*$/);
    if (match && OUTCOMES.includes(match[1])) found = { outcome: match[1], reason: match[2] ?? null };
  }
  return found;
}

function failedRun({ outcome, reason } = {}, url) {
  const fix = {
    reauth_required: 'ChatGPT отклонил сессию воркера. Войдите заново: `codex-auto-resets login`.',
    broken_state: reason?.startsWith('rules_') ?
      `Воркер не смог прочитать правила (${reason}). Удалите ${FILES.rules} в репозитории и запустите setup снова.` :
      `Воркер не смог открыть файл с сессией воркера (${reason}). Удалите ${FILES.state} в репозитории и запустите setup снова: понадобится новый вход в ChatGPT.`,
    commit_failed: 'Воркер не смог сохранить сессию воркера в репозитории. Запустите setup снова; если GitHub пришлёт письмо о потере сессии, войдите заново: `codex-auto-resets login`.',
  }[outcome] ?? 'Пробный запуск завершился ошибкой.';
  return new SetupFailed(`${fix}\nЗапуск: ${url}`);
}

function workingLine(summary, timeZone) {
  const resets = summary.resets ?? [];
  const deadlines = resets.map(r => r.expiresAt && Date.parse(r.expiresAt)).filter(Boolean).sort((a, b) => a - b);
  if (!deadlines.length) return `Работает. Сбросов: ${resets.length}.`;
  const nearest = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit',
    minute: '2-digit', timeZone, timeZoneName: 'short' }).format(deadlines[0]);
  return `Работает. Сбросов: ${resets.length}, ближайший истекает ${nearest}.`;
}

// Dispatches a regular tick, waits for its run and reads what the worker published.
async function trialRun({ api, repo, io, now, sleep, timeZone }) {
  const name = repo.full_name;
  io.print('Пробный запуск воркера…');
  const known = new Set((await api.dispatchRuns(name, WORKFLOW_FILE)).map(run => run.id));
  const deadline = now() + TRIAL_TIMEOUT_MS;
  // GitHub learns about a freshly pushed workflow with a delay.
  while (!await api.dispatch(name, WORKFLOW_FILE, { ref: repo.default_branch, inputs: { apply_now: '' } })) {
    if (now() >= deadline) throw new SetupFailed('GitHub так и не увидел workflow воркера. Запустите setup снова через несколько минут.');
    await sleep(POLL_MS);
  }
  let run = null;
  for (;;) {
    run = run ? await api.run(name, run.id) : (await api.dispatchRuns(name, WORKFLOW_FILE)).find(r => !known.has(r.id)) ?? null;
    if (run?.status === 'completed') break;
    if (now() >= deadline) {
      throw new SetupFailed(run ? `Пробный запуск не завершился за 10 минут. Проверьте его позже: ${run.html_url}` :
        `GitHub не начал пробный запуск за 10 минут. Проверьте Actions: ${repo.html_url}/actions`);
    }
    await sleep(POLL_MS);
  }
  let logged = null;
  for (let attempt = 1; !logged && attempt <= LOG_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(POLL_MS);
    logged = loggedOutcome(await api.runLog(name, run.id).catch(() => null));
  }
  if (run.conclusion !== 'success') throw failedRun(logged ?? {}, run.html_url);
  const summary = logged?.outcome === 'transient_error' ? null : await api.file(name, FILES.summary);
  if (summary) return workingLine(JSON.parse(summary.text), timeZone);
  // Before its first successful read the worker publishes nothing.
  return 'Воркер установлен, но пробная проверка ещё не прочитала сбросы' +
    `${logged?.outcome === 'transient_error' ? ': временная ошибка ChatGPT' : ''}. Следующий запуск через час повторит её.`;
}

function explain(error) {
  if (error instanceof SetupFailed) return error.message;
  if (error instanceof GitHubFailure) {
    return {
      unauthorized: 'GitHub отклонил токен. Запустите setup снова, чтобы войти заново.',
      network: 'GitHub недоступен. Запустите setup снова: уже сделанное сохранится.',
      login_timeout: 'Код GitHub не был введён вовремя. Запустите setup снова.',
      login_denied: 'Вход в GitHub отклонён.',
    }[error.reason] ?? `GitHub ответил ошибкой (${error.reason}). Запустите setup снова: уже сделанное сохранится.`;
  }
  if (error instanceof LoginFailed) {
    return error.reason === 'timeout' ? 'Код ChatGPT не был введён за 15 минут. Запустите setup снова.' :
      `Вход в ChatGPT не удался (${error.reason}). Запустите setup снова.`;
  }
  if (error instanceof TransientFailure) return 'ChatGPT недоступен. Запустите setup снова: уже сделанное сохранится.';
  return null;
}

// `codex-auto-resets setup`: from nothing to a working worker, or the missing parts of an
// existing one. Files already in the repository are kept, so a repeated setup never loses
// state or rules and never rewrites the cron. Returns the process exit code.
export async function setup({ fetch, keychain, io, workerSource, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random, timeZone }) {
  try {
    const { api, login } = await connectGitHub({ fetch, keychain, io, now, sleep });
    const repo = await workerRepository({ api, login, io });
    const name = repo.full_name;
    const [state, rules, worker, workflow, hasKey] = await Promise.all([
      api.file(name, FILES.state), api.file(name, FILES.rules), api.file(name, FILES.worker), api.file(name, FILES.workflow),
      api.hasSecret(name, STATE_KEY_SECRET)]);

    // The key cannot be read back, so a state without its key is useless and is replaced.
    if (state && hasKey) io.print('Сессия воркера уже сохранена, вход в ChatGPT не нужен.');
    else {
      io.print('Вход в ChatGPT для сессии воркера (она отдельна от Codex на этом компьютере).');
      const session = await deviceLogin({ fetch, now, sleep, onCode: showCode(io) });
      const key = generateKey();
      // The key comes first: a state that reaches the repository is always openable.
      await api.putSecret(name, STATE_KEY_SECRET, key);
      await api.putFile(name, FILES.state, sealState({ formatVersion: STATE_FORMAT_VERSION, session, pending: null, applied: [] }, key),
        { message: 'Save the worker session', sha: state?.sha });
    }
    if (!rules) {
      const chosen = await chooseRules(io);
      await api.putFile(name, FILES.rules, `${JSON.stringify(chosen, null, 2)}\n`, { message: 'Set the general rules' });
    }
    if (!worker) await api.putFile(name, FILES.worker, workerSource, { message: 'Add the worker' });
    // The workflow goes last, so its schedule never meets a half-filled repository.
    if (!workflow) {
      const minute = 1 + Math.floor(random() * 59);
      await api.putFile(name, FILES.workflow, workflowYaml({ minute }), { message: 'Run the worker every hour' });
    }
    io.print(await trialRun({ api, repo, io, now, sleep, timeZone }));
    return 0;
  } catch (error) {
    const message = explain(error);
    if (message === null) throw error;
    for (const line of message.split('\n')) io.print(line);
    return 1;
  }
}
