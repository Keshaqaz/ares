import { deviceLogin } from '../chatgpt/session.mjs';
import { FILES, STATE_KEY_SECRET, LOGIN_SECRET } from '../worker/layout.mjs';
import { generateKey, sealState, STATE_FORMAT_VERSION } from '../worker/state-file.mjs';
import { workflowYaml } from '../worker/workflow.mjs';
import { CommandFailed, WORKER_REPOSITORY, WORKER_DESCRIPTION, showCode, workingLine, connectGitHub, workerRepository,
  chooseRules, readSummary, failedRunAdvice, runWorkerNow, command } from './common.mjs';

async function ensureRepository({ api, login, io }) {
  const repo = await workerRepository({ api, login });
  if (repo) {
    io.print(`Найден репозиторий воркера: ${repo.html_url}`);
    return repo;
  }
  const created = await api.createRepository({ name: WORKER_REPOSITORY, description: WORKER_DESCRIPTION });
  io.print(`Создан приватный репозиторий воркера: ${created.html_url}`);
  return created;
}

// Dispatches a regular tick, waits for its run and reads what the worker published.
async function trialRun({ api, repo, io, now, sleep, timeZone }) {
  io.print('Пробный запуск воркера…');
  const { run, logged } = await runWorkerNow({ api, repo, inputs: {}, now, sleep });
  if (run.conclusion !== 'success') throw new CommandFailed(`${failedRunAdvice(logged ?? {})}\nЗапуск: ${run.html_url}`);
  const summary = logged?.outcome === 'transient_error' ? null : await readSummary(api, repo);
  if (summary) return workingLine(summary, timeZone);
  // Before its first successful read the worker publishes nothing.
  return 'Воркер установлен, но пробная проверка ещё не прочитала сбросы' +
    `${logged?.outcome === 'transient_error' ? ': временная ошибка ChatGPT' : ''}. Следующий запуск через час повторит её.`;
}

// `codex-auto-resets setup`: from nothing to a working worker, or the missing parts of an
// existing one. Files already in the repository are kept, so a repeated setup never loses
// state or rules and never rewrites the cron. Returns the process exit code.
export async function setup({ fetch, keychain, io, workerSource, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random, timeZone }) {
  return command('setup', io, async () => {
    const { api, login } = await connectGitHub({ fetch, keychain, io, now, sleep });
    const repo = await ensureRepository({ api, login, io });
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
      // A login left over from an interrupted `login` must not replace this new session.
      await api.deleteSecret(name, LOGIN_SECRET);
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
  });
}
