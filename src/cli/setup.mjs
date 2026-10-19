import { deviceLogin } from '../chatgpt/session.ts';
import { FILES, STATE_KEY_SECRET, LOGIN_SECRET } from '../worker/layout.ts';
import { generateKey, sealState, readRules, BrokenState, STATE_FORMAT_VERSION } from '../worker/state-file.ts';
import { workflowYaml } from '../worker/workflow.ts';
import { CommandFailed, WORKER_REPOSITORY, WORKER_DESCRIPTION, chatgptLogin, showCode, workingLine, connectGitHub, workerRepository,
  chooseRules, readSummary, failedRunAdvice, runWorkerNow, command } from './common.mjs';
import { followWeeklyRule } from './mac-check.mjs';
import { t } from './language.mjs';

async function ensureRepository({ api, login, io }) {
  const repo = await workerRepository({ api, login });
  if (repo) {
    io.print(`${t('Worker repository', 'Репозиторий воркера')}: ${repo.html_url}`);
    return repo;
  }
  const created = await api.createRepository({ name: WORKER_REPOSITORY, description: WORKER_DESCRIPTION });
  io.print(`${t('Created the private worker repository', 'Создан приватный репозиторий воркера')}: ${created.html_url}`);
  return created;
}

// Dispatches a regular tick, waits for its run and reads what the worker published.
async function trialRun({ api, repo, io, now, sleep, timeZone }) {
  io.print(t('Checking the worker…', 'Проверяем воркер…'));
  const { run, logged } = await runWorkerNow({ api, repo, inputs: {}, now, sleep, wait: io.wait });
  if (run.conclusion !== 'success') throw new CommandFailed(`${failedRunAdvice(logged ?? {})}\n${t('Details', 'Подробности')}: ${run.html_url}`);
  const summary = logged?.outcome === 'transient_error' ? null : await readSummary(api, repo);
  if (summary) return workingLine(summary, timeZone);
  // Before its first successful read the worker publishes nothing.
  const busy = logged?.outcome === 'transient_error';
  return t(`The worker is installed, but the resets are not read yet${busy ? ': ChatGPT is temporarily unavailable' : ''}. ` +
    'The worker will try again on its next run.',
  `Воркер установлен, но сбросы пока не прочитаны${busy ? ': ChatGPT временно недоступен' : ''}. Воркер повторит при следующем запуске.`);
}

// `aures setup`: from nothing to a working worker, or the missing parts of an
// existing one. Files already in the repository are kept, so a repeated setup never loses
// state or rules and never rewrites the cron. This Mac follows the weekly rule: the check
// from it is set up or removed. Returns the process exit code.
export async function setup({ fetch, keychain, io, workerSource, mac, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random, timeZone }) {
  return command('setup', io, async () => {
    const { api, login } = await connectGitHub({ fetch, keychain, io, now, sleep });
    const repo = await ensureRepository({ api, login, io });
    const name = repo.full_name;
    const [state, rules, worker, workflow, hasKey] = await Promise.all([
      api.file(name, FILES.state), api.file(name, FILES.rules), api.file(name, FILES.worker), api.file(name, FILES.workflow),
      api.hasSecret(name, STATE_KEY_SECRET)]);

    // The key cannot be read back, so a state without its key is useless and is replaced.
    if (state && hasKey) io.print(t('The ChatGPT sign-in is already there.', 'Вход в ChatGPT уже есть.'));
    else {
      io.print(chatgptLogin());
      const session = await deviceLogin({ fetch, now, sleep, onCode: showCode(io) });
      const key = generateKey();
      // A login left over from an interrupted `login` must not replace this new session.
      await api.deleteSecret(name, LOGIN_SECRET);
      // The key comes first: a state that reaches the repository is always openable.
      await api.putSecret(name, STATE_KEY_SECRET, key);
      await api.putFile(name, FILES.state, sealState({ formatVersion: STATE_FORMAT_VERSION, session, pending: null, applied: [] }, key),
        { message: 'Save the worker session', sha: state?.sha });
    }
    let weekly = null;
    if (!rules) {
      const chosen = await chooseRules(io);
      await api.putFile(name, FILES.rules, `${JSON.stringify(chosen, null, 2)}\n`, { message: 'Set the general rules' });
      weekly = chosen.weeklyAutoApply;
    } else {
      // Rules that do not read leave this Mac as it is; the trial run names the fix.
      try { weekly = readRules(rules.text).weeklyAutoApply; } catch (error) { if (!(error instanceof BrokenState)) throw error; }
    }
    if (!worker) await api.putFile(name, FILES.worker, workerSource, { message: 'Add the worker' });
    // The workflow goes last, so its schedule never meets a half-filled repository.
    if (!workflow) {
      const minute = 1 + Math.floor(random() * 59);
      await api.putFile(name, FILES.workflow, workflowYaml({ minute }), { message: 'Run the worker every hour' });
    }
    if (weekly !== null) await followWeeklyRule({ weekly, mac, fetch, io, now, sleep });
    io.print(await trialRun({ api, repo, io, now, sleep, timeZone }));
    return 0;
  });
}
