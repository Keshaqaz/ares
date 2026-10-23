import { deviceLogin, sessionEmail } from '../chatgpt/session.ts';
import { FILES, STATE_KEY_SECRET, LOGIN_SECRET, TRIAL_INPUT } from '../worker/layout.ts';
import { generateKey, sealState, readRules, BrokenState, STATE_FORMAT_VERSION } from '../worker/state-file.ts';
import { workflowYaml } from '../worker/workflow.ts';
import { CommandFailed, WORKER_REPOSITORY, WORKER_DESCRIPTION, chatgptLogin, showCode, workingLine, connectGitHub, workerRepository,
  chooseRules, readSummary, failedRunAdvice, runWorkerNow, command, trialVerdict, notReadYet, switchUnfinished } from './common.ts';
import { setupGoogle } from './setup-google.ts';
import { runWhileEnabled } from './pause.ts';
import type { Install, WatchFiles } from './watch-files.ts';
import { followWeeklyRule } from './mac-check.ts';
import type { CommandOptions, GitHub, Io, Sleep } from './common.ts';
import type { GitHubApi, Repository } from '../github/api.ts';
import { t } from './language.ts';

async function ensureRepository({ api, login, io }: GitHub & { io: Io }): Promise<Repository> {
  const repo = await workerRepository({ api, login });
  if (repo) {
    io.print(`${t('Worker repository', 'Репозиторий воркера')}: ${repo.html_url}`);
    return repo;
  }
  const created = await api.createRepository({ name: WORKER_REPOSITORY, description: WORKER_DESCRIPTION });
  io.print(`${t('Created the private worker repository', 'Создан приватный репозиторий воркера')}: ${created.html_url}`);
  return created;
}

// Dispatches a trial run (CONTEXT.md, «Пробный запуск»), waits for it and reads what the
// worker published and what the rules would do. A worker on pause runs it with the schedule
// briefly on and off again after, so the pause stays (ADR-0007).
export async function trialRun({ api, repo, io, now, sleep, timeZone, paused }:
  { api: GitHubApi; repo: Repository; io: Io; now: () => number; sleep: Sleep; timeZone: string | undefined; paused: boolean }): Promise<string> {
  io.print(t('Checking the worker…', 'Проверяем воркер…'));
  const one = () => runWorkerNow({ api, repo, inputs: { [TRIAL_INPUT]: 'true' }, now, sleep, wait: io.wait });
  const { run, logged } = paused ? await runWhileEnabled({ platform: 'github', api, repo }, one) : await one();
  if (run.conclusion !== 'success') throw new CommandFailed(`${failedRunAdvice(logged ?? {})}\n${t('Details', 'Подробности')}: ${run.html_url}`);
  const summary = logged?.outcome === 'transient_error' ? null : await readSummary(api, repo);
  const verdict = logged && trialVerdict(logged);
  if (summary) return [workingLine(summary, timeZone), verdict].filter(Boolean).join(' ');
  // Before its first successful read the worker publishes nothing.
  return notReadYet(logged?.outcome === 'transient_error');
}

// The platform of the worker (ADR-0007), as the install record keeps it; asked without a
// recommendation, with what each costs, when there is no record yet. The rest of the record,
// such as a pause, stays as it is.
async function choosePlatform(io: Io, files: WatchFiles): Promise<Install> {
  const install = await files.readInstall();
  if (install) return install;
  io.print(t('Where the worker will run:', 'Где будет работать воркер:'));
  io.print(t('  1. GitHub Actions — runs once an hour, but GitHub skips many runs; the before-expiry rule starts 8 hours ahead.',
    '  1. GitHub Actions — запуск раз в час, но GitHub пропускает многие запуски; правило перед истечением начинает за 8 часов.'));
  io.print(t('  2. Google Apps Script — runs every 5 minutes, the before-expiry rule starts 1 hour ahead. Installing it shows two ' +
    '«unverified app» warnings and needs one switch in the settings; the script project you delete yourself on uninstall.',
  '  2. Google Apps Script — запуск каждые 5 минут, правило перед истечением начинает за 1 час. При установке Google дважды ' +
    'предупредит о непроверенном приложении и нужно включить один переключатель; проект скрипта при удалении вы удаляете сами.'));
  for (;;) {
    const answer = (await io.prompt(t('Type 1 or 2: ', 'Введите 1 или 2: '))).trim();
    const platform = answer === '1' ? 'github' : answer === '2' ? 'google' : null;
    if (platform) {
      const chosen: Install = { platform };
      await files.writeInstall(chosen);
      return chosen;
    }
  }
}

// `aures setup`: from nothing to a working worker, or the missing parts of an existing one,
// on the platform the user picks once. Returns the process exit code.
// workerSource is the GitHub worker bundle, appsScriptSource the Apps Script one; random picks the cron minute.
export interface SetupOptions extends CommandOptions {
  workerSource: string;
  appsScriptSource: string;
  random?: () => number;
}
export async function setup(options: SetupOptions): Promise<number> {
  const { io, mac, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = options;
  return command('setup', io, async () => {
    const install = await choosePlatform(io, mac.files);
    // setup would bring the new worker's schedule back before the old one is quenched.
    if (install.switching) throw new CommandFailed(switchUnfinished());
    const paused = install.paused === true;
    return install.platform === 'google' ?
      setupGoogle({ ...options, now, sleep, paused }) :
      setupGitHub({ ...options, now, sleep, paused });
  });
}

// On GitHub. Files already in the repository are kept, so a repeated setup never loses state
// or rules and never rewrites the cron. This Mac follows the weekly rule: the check from it is
// set up or removed. A worker on pause stays paused: the files go in, the schedule stays off.
async function setupGitHub({ fetch, keychain, io, open, copy, workerSource, mac, now, sleep, random = Math.random, timeZone, paused }:
  SetupOptions & { now: () => number; sleep: Sleep; paused: boolean }): Promise<number> {
  const { api, login } = await connectGitHub({ fetch, keychain, io, open, copy, now, sleep });
  const repo = await ensureRepository({ api, login, io });
  const name = repo.full_name;
  const [state, rules, worker, workflow, hasKey] = await Promise.all([
    api.file(name, FILES.state), api.file(name, FILES.rules), api.file(name, FILES.worker), api.file(name, FILES.workflow),
    api.hasSecret(name, STATE_KEY_SECRET)]);
  // setup keeps an existing workflow, and one of an older version has no trial run to dispatch.
  if (workflow && !workflow.text.includes(`\n      ${TRIAL_INPUT}:\n`)) {
    throw new CommandFailed(t('The worker is of an older version. Run `aures upgrade`, then `aures setup` again.',
      'Воркер старой версии. Запустите `aures upgrade`, затем снова `aures setup`.'));
  }

  // The key cannot be read back, so a state without its key is useless and is replaced.
  if (state && hasKey) io.print(t('The ChatGPT sign-in is already there.', 'Вход в ChatGPT уже есть.'));
  else {
    io.print(chatgptLogin());
    const session = await deviceLogin({ fetch, now, sleep, onCode: showCode(io, open, copy) });
    const key = generateKey();
    // A login left over from an interrupted `login` must not replace this new session.
    await api.deleteSecret(name, LOGIN_SECRET);
    // The key comes first: a state that reaches the repository is always openable.
    await api.putSecret(name, STATE_KEY_SECRET, key);
    await api.putFile(name, FILES.state, sealState({ formatVersion: STATE_FORMAT_VERSION, session, pending: null, applied: [] }, key),
      { message: 'Save the worker session', sha: state?.sha });
    await mac.files.rememberAccount('chatgpt', sessionEmail(session));
  }
  let weekly: boolean | null = null;
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
  if (weekly !== null) await followWeeklyRule({ weekly, mac, fetch, io, open, copy, now, sleep });
  io.print(await trialRun({ api, repo, io, now, sleep, timeZone, paused }));
  return 0;
}
