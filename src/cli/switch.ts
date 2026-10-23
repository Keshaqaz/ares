// «Переключиться на …» on the screen «Воркер» (ADR-0007, CONTEXT.md «Погашенный воркер»): the
// new worker is prepared without a schedule while the old one keeps working, then the old one is
// quenched, and only then the new one gets its schedule. At no moment do two workers have a
// schedule and a live session.
//
// (1) The old worker's status: a pending application refuses the switch, nothing changes.
// (2) The new worker without a schedule: its repository or project is made or reused, this
//     version of its code goes in, the general rules are moved, and the user signs it in to
//     ChatGPT. Its schedule is off before it has a session; a new workflow on GitHub has no cron
//     until step 4.
// (3) The old worker is quenched: its session is revoked and its schedule taken off (GitHub: a
//     revoke run, then the workflow disabled; Google: doPost revoke, then schedule off).
// (4) The new worker's schedule goes on. (5) A trial run.
//
// Esc stops the switch until step 3 begins and leaves the old worker as it was. From step 3 the
// install record says `switching`: no worker is active, and finishSwitch («Повторить
// переключение») completes the switch from wherever it stopped, after a failure or a crash.
// Step 2 takes minutes, and the old worker keeps running meanwhile: right before the quench its
// status is read again, and an application with an unknown outcome or, on GitHub, a run under way
// undoes the switch instead. The old worker stays the active one, the new one has no schedule.
// Switching back reuses the quenched repository or project.
import { randomUUID } from 'node:crypto';
import pkg from '../../package.json' with { type: 'json' };
import { deviceLogin, sessionEmail } from '../chatgpt/session.ts';
import type { Fetch } from '../chatgpt/http.ts';
import { FILES, STATE_KEY_SECRET, LOGIN_SECRET, REVOKE_INPUT } from '../worker/layout.ts';
import { generateKey, sealState, readRules, BrokenState, STATE_FORMAT_VERSION } from '../worker/state-file.ts';
import type { Rules } from '../worker/state-file.ts';
import { workflowYaml, workflowMinute } from '../worker/workflow.ts';
import type { Summary } from '../worker/summary.ts';
import { GoogleFailure } from '../google/api.ts';
import { CommandFailed, WORKER_REPOSITORY, WORKER_DESCRIPTION, WORKFLOW_FILE, chatgptLogin, showCode, connectGitHub,
  workerRepository, installedWorker, readSummary, runWorkerNow, resetName, reasonText, explain, unfinished, switchUnfinished } from './common.ts';
import type { Io, Sleep } from './common.ts';
import { rulesOf } from './active-worker.ts';
import type { Worker, GitHubWorker, GoogleWorker, Ask } from './active-worker.ts';
import { connectGoogle, deployWorker, askWorker, askAfterDeploy, workerDid, readSecret, brokenOnGoogle } from './google.ts';
import type { WorkerDeployment, WorkerReply } from './google.ts';
import { trialRun } from './setup.ts';
import { trialLine } from './setup-google.ts';
import type { Trial } from './setup-google.ts';
import type { Keychain } from './keychain.ts';
import type { OpenUrl, CopyText } from './browser.ts';
import type { Mac } from './mac-check.ts';
import type { Install, Platform } from './watch-files.ts';
import { t } from './language.ts';

// Esc before step 3.
export class SwitchCancelled extends Error {}

// The platform a worker on this one switches to, and how the user reads its name.
export const otherPlatform = (platform: Platform): Platform => platform === 'github' ? 'google' : 'github';
export const platformName = (platform: Platform): string => platform === 'github' ? 'GitHub Actions' : 'Google Apps Script';

// Each step of the switch, as the journal of the screen «Воркер» shows it.
export type SwitchJournal = (text: string, tone?: 'ok' | 'warn') => void;

// What the switch needs; the bundles are null when this install has no build of them. signal
// is Esc; committed is told when step 3 begins and Esc no longer stops the switch.
export interface FinishSwitchOptions {
  fetch: Fetch;
  keychain: Keychain;
  googleKeychain: Keychain;
  secretKeychain: Keychain;
  open: OpenUrl;
  copy: CopyText;
  io: Io;
  mac: Mac;
  now: () => number;
  sleep: Sleep;
  timeZone: string | undefined;
  journal: SwitchJournal;
  // Picks the minute of the cron of a new GitHub worker.
  random?: () => number;
}
export interface SwitchOptions extends FinishSwitchOptions {
  // The active worker, the one switched from.
  worker: Worker;
  workerSource: string | null;
  appsScriptSource: string | null;
  signal?: AbortSignal;
  committed?: () => void;
}

// ─── The switch ─────────────────────────────────────────────────────────────

// Resolves to what to tell the user once the switch is done.
export async function switchPlatform(options: SwitchOptions): Promise<string> {
  const { worker, mac: { files }, signal } = options;
  // What the preparation still does after Esc is not the user's business any more.
  const journal: SwitchJournal = (text, tone) => { if (!signal?.aborted) options.journal(text, tone); };
  const from = worker.platform, target = otherPlatform(from);
  const install = await files.readInstall();
  if (!install) throw new CommandFailed(unfinished());
  if (install.switching) throw new CommandFailed(switchUnfinished());
  if (install.paused) {
    throw new CommandFailed(t('The worker is paused. Take it off pause first, then switch.', 'Воркер на паузе. Сначала снимите его с паузы, затем переключайте.'));
  }
  const source = target === 'github' ? options.workerSource : options.appsScriptSource;
  if (source === null) {
    throw new CommandFailed(t('There is no worker build in this program. Reinstall it: `brew reinstall aures`.',
      'В этой программе нет сборки воркера. Переустановите её: `brew reinstall aures`.'));
  }

  // Steps 1 and 2 stop at Esc: at once, and the work under way stops at its next step or wait.
  const stop = new Promise<never>((_, reject) => {
    const abort = () => reject(new SwitchCancelled());
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
  stop.catch(() => {});
  const checkpoint = () => { if (signal?.aborted) throw new SwitchCancelled(); };
  const sleep: Sleep = ms => Promise.race([options.sleep(ms), stop]);
  const preparing = (async () => {
    journal(t(`Switching to ${platformName(target)}. Esc stops it until the old worker is quenched.`,
      `Переключаемся на ${platformName(target)}. Esc отменяет до гашения старого воркера.`));
    const rules = await oldRules(worker);
    checkpoint();
    const prepare = target === 'github' ? prepareGitHub : prepareGoogle;
    return prepare({ ...options, sleep, journal, source, rules, checkpoint });
  })();
  preparing.catch(() => {});
  const email = await Promise.race([preparing, stop]);
  checkpoint();

  // Step 3: from here on the switch goes to its end, to «Повторить переключение», or back to the
  // old worker when it turns out busy.
  options.committed?.();
  const latest = await files.readInstall() ?? install;
  await files.writeInstall({ ...latest, platform: target, switching: { from } });
  return finish(options, worker, email);
}

// «Повторить переключение»: completes a switch the install record says is unfinished.
export async function finishSwitch(options: FinishSwitchOptions): Promise<string> {
  const install = await options.mac.files.readInstall();
  if (!install?.switching) throw new CommandFailed(t('There is no unfinished switch.', 'Незавершённого переключения нет.'));
  options.journal(t(`Finishing the switch to ${platformName(install.platform)}…`, `Завершаем переключение на ${platformName(install.platform)}…`));
  return finish(options, null);
}

// Steps 3–5 from where the record says the switch is. old is the open old worker, null to open it;
// email is the ChatGPT account the new worker was signed in to, kept once the old one is quenched.
async function finish(options: FinishSwitchOptions, old: Worker | null, email: string | null = null): Promise<string> {
  const { mac: { files }, journal } = options;
  let install = await files.readInstall();
  if (!install?.switching) throw new CommandFailed(unfinished());
  const { platform: target, switching: { from } } = install;

  if (!install.switching.quenched) {
    const { switching: _undone, ...back } = install;
    const undo = async (busy: string): Promise<never> => {
      await files.writeInstall({ ...back, platform: from });
      throw new CommandFailed(t(`The switch is undone: ${busy} The worker on ${platformName(from)} stays active, the new one on ` +
        `${platformName(target)} has no schedule. Switch again after the next run of the worker.`,
      `Переключение отменено: ${busy} Воркер на ${platformName(from)} остаётся активным, у нового на ${platformName(target)} ` +
        'расписания нет. Переключите снова после следующего запуска воркера.'));
    };
    const worker = old ?? await openOld(options, from, install);
    const busy = worker && await busyNow(worker);
    if (busy) await undo(busy);
    journal(t(`Quenching the old worker on ${platformName(from)}…`, `Гасим старый воркер на ${platformName(from)}…`));
    if (worker) {
      try { await quench(worker, options); } catch (error) {
        // A tick of the old worker on Google started an application after busyNow read its status.
        if (!(error instanceof StillPending)) throw error;
        await undo(error.message);
      }
    } else journal(t('The old worker is gone: there is nothing to quench.', 'Старого воркера больше нет: гасить нечего.'), 'warn');
    install = { ...install, switching: { from, quenched: true }, ...email ? { accounts: { ...install.accounts, chatgpt: email } } : {} };
    await files.writeInstall(install);
  }

  // Step 4. A failure leaves no worker active, and the screen offers to repeat.
  const worker = await openNew(options, target, install);
  try {
    if (worker.platform === 'github') await scheduleOnGitHub(worker, options.random ?? Math.random);
    else await worker.ask('schedule', { on: true });
  } catch (error) {
    const why = explain(error);
    if (why === null) throw error;
    throw new CommandFailed(`${t(`The new worker's schedule did not go on: ${why}`, `Расписание нового воркера не включилось: ${why}`)}\n${switchUnfinished()}`);
  }
  const { switching: _done, ...active } = install;
  await files.writeInstall(active);
  journal(t(`The new worker on ${platformName(target)} runs by its schedule.`, `Новый воркер на ${platformName(target)} работает по расписанию.`));

  // Step 5. The switch is done whatever it says.
  journal(t('Checking the new worker: a trial run…', 'Проверяем новый воркер: пробный запуск…'));
  try {
    const { io, now, sleep, timeZone } = options;
    journal(worker.platform === 'github' ? await trialRun({ api: worker.api, repo: worker.repo, io, now, sleep, timeZone, paused: false }) :
      trialLine(await worker.ask('trial') as unknown as Trial, timeZone));
  } catch (error) {
    const why = explain(error);
    if (why === null) throw error;
    journal(t(`The trial run failed: ${why}`, `Пробный запуск не удался: ${why}`), 'warn');
  }
  return t(`The worker is switched to ${platformName(target)}. The old one on ${platformName(from)} is quenched, its ` +
    `${from === 'github' ? 'repository' : 'project'} is kept for a switch back.`,
  `Воркер переключён на ${platformName(target)}. Старый на ${platformName(from)} погашен, его ` +
    `${from === 'github' ? 'репозиторий' : 'проект'} сохранён для обратного переключения.`);
}

// ─── Step 1: the old worker ─────────────────────────────────────────────────

// The rules to move, once the old worker has no application with an unknown outcome. A worker
// that does not say whether it has one is of an older version: it is not taken for one without.
async function oldRules(worker: Worker): Promise<Rules> {
  let summary: Summary | null, rules: Rules | null = null;
  if (worker.platform === 'google') {
    const status = await worker.ask('status');
    summary = status.summary as Summary | null;
    rules = rulesOf(status.rules);
  } else {
    const { api, repo } = worker;
    const [published, file] = await Promise.all([readSummary(api, repo), api.file(repo.full_name, FILES.rules)]);
    summary = published;
    try { rules = file && readRules(file.text); } catch (error) { if (!(error instanceof BrokenState)) throw error; }
  }
  if (summary && summary.pending === undefined) {
    throw new CommandFailed(t('The worker does not tell whether an application of a reset has an unknown outcome: it is of an older version. ' +
      'Update it (`aures upgrade`), wait for its next run and switch again.',
    'Воркер не сообщает, есть ли применение сброса с неизвестным исходом: он старой версии. ' +
      'Обновите его (`aures upgrade`), дождитесь следующего запуска и повторите переключение.'));
  }
  if (summary?.pending) {
    throw new CommandFailed(t(`The switch is refused: ${unknownOutcome(summary.pending)} ` +
      'A new worker with a clean state could spend a second reset. The old worker settles it on its next run; switch after that.',
    `Переключение отклонено: ${unknownOutcome(summary.pending)} ` +
      'Новый воркер с чистым состоянием мог бы потратить второй сброс. Старый воркер уточнит исход при следующем запуске, переключайте после этого.'));
  }
  if (!rules) {
    throw new CommandFailed(t('The rules of the worker do not read. Choose them (`aures rules`) and switch again.',
      'Правила воркера не читаются. Выберите их (`aures rules`) и повторите переключение.'));
  }
  return rules;
}

const unknownOutcome = ({ creditId, reason }: NonNullable<Summary['pending']>): string => t(
  `the outcome of applying ${resetName(creditId)} (${reasonText(reason)}) is not known yet.`,
  `исход применения ${resetName(creditId)} (${reasonText(reason)}) ещё неизвестен.`);

// ─── Step 2: the new worker, without a schedule ─────────────────────────────

// Resolves to the email of the ChatGPT account the new worker was signed in to, if known.
type Prepare = (options: SwitchOptions & { source: string; rules: Rules; checkpoint: () => void }) => Promise<string | null>;
const rulesLine = ({ beforeExpiry, weeklyAutoApply }: Rules): string => t(
  `The general rules are moved: before expiry ${beforeExpiry ? 'on' : 'off'}, when the weekly limit runs out ${weeklyAutoApply ? 'on' : 'off'}.`,
  `Общие правила перенесены: перед истечением — ${beforeExpiry ? 'включено' : 'выключено'}, когда кончится недельный лимит — ${weeklyAutoApply ? 'включено' : 'выключено'}.`);
const signingIn = (): string => t('Signing the new worker in to ChatGPT: a session of its own…', 'Вход в ChatGPT для нового воркера: своя сессия…');

// On GitHub: the repository, this version's worker and workflow, the workflow disabled, the
// rules, then a new session sealed with a new key. The CLI cannot open a quenched state, and a
// login run would need the schedule on, so the state starts over, as in setup.
const prepareGitHub: Prepare = async ({ fetch, keychain, io, open, copy, now, sleep, source, rules, journal, checkpoint }) => {
  journal(t('Signing in to GitHub…', 'Входим в GitHub…'));
  const github = await connectGitHub({ fetch, keychain, io, open, copy, now, sleep });
  checkpoint();
  let repo = await workerRepository(github);
  if (repo) journal(t(`The worker repository is reused: ${repo.html_url}`, `Репозиторий воркера переиспользуется: ${repo.html_url}`));
  else {
    repo = await github.api.createRepository({ name: WORKER_REPOSITORY, description: WORKER_DESCRIPTION });
    journal(t(`Created the private worker repository: ${repo.html_url}`, `Создан приватный репозиторий воркера: ${repo.html_url}`));
  }
  checkpoint();
  const { api } = github, name = repo.full_name;
  const [worker, workflow, rulesFile] = await Promise.all([api.file(name, FILES.worker), api.file(name, FILES.workflow),
    api.file(name, FILES.rules)]);
  if (worker?.text !== source) await api.putFile(name, FILES.worker, source, { message: `Worker ${pkg.version}`, sha: worker?.sha });
  // A new workflow comes enabled, so it comes without its cron: no schedule runs it before step 4
  // writes the cron in. A workflow that was there keeps its state when its file is written, and
  // its minute.
  const yaml = workflowYaml({ minute: workflow && workflowMinute(workflow.text) });
  if (workflow?.text !== yaml) await api.putFile(name, FILES.workflow, yaml, { message: `Worker workflow ${pkg.version}`, sha: workflow?.sha });
  // It goes off before the repository gets a session: nothing dispatches a run meanwhile either.
  await api.setWorkflow(name, WORKFLOW_FILE, false);
  journal(t(`Version ${pkg.version} of the worker is in, its schedule is off.`, `Залита версия воркера ${pkg.version}, расписание выключено.`));
  checkpoint();
  await api.putFile(name, FILES.rules, `${JSON.stringify(rules, null, 2)}\n`, { message: 'Move the general rules', sha: rulesFile?.sha });
  journal(rulesLine(rules));
  checkpoint();

  journal(signingIn());
  io.print(chatgptLogin());
  const session = await deviceLogin({ fetch, now, sleep, onCode: showCode(io, open, copy) });
  checkpoint();
  const key = generateKey();
  const state = await api.file(name, FILES.state);
  // A login left over from an interrupted `login` must not replace this session; the key goes first.
  await api.deleteSecret(name, LOGIN_SECRET);
  await api.putSecret(name, STATE_KEY_SECRET, key);
  await api.putFile(name, FILES.state, sealState({ formatVersion: STATE_FORMAT_VERSION, session, pending: null, applied: [] }, key),
    { message: 'Save the worker session', sha: state?.sha });
  journal(t('The new worker has its ChatGPT session.', 'У нового воркера своя сессия ChatGPT.'));
  return sessionEmail(session);
};

// On Google: the project is deployed or redeployed with this version, the script is allowed to
// run, its trigger is off, then the rules and the login through doPost. A login of a worker
// without a schedule goes as a trial run: it spends nothing.
const prepareGoogle: Prepare = async ({ fetch, googleKeychain, secretKeychain, io, open, copy, mac: { files }, now, sleep, source, rules, journal,
  checkpoint, signal }) => {
  // The record keeps the project from the moment it exists, while the old platform stays the active
  // one. After Esc the screen goes on with other actions, which write the record too: not any more.
  const remember = async (google: { scriptId: string; deploymentId?: string; url?: string }) => {
    if (signal?.aborted) return;
    const install = await files.readInstall();
    if (install) await files.writeInstall({ ...install, google });
  };
  journal(t('Signing in to Google…', 'Входим в Google…'));
  const api = await connectGoogle({ fetch, keychain: googleKeychain, io, open, now, files });
  checkpoint();
  let google = (await files.readInstall())?.google ?? null;
  const deploy = (deployment: typeof google) => deployWorker({ api, secretKeychain, io, open, sleep, workerSource: source, deployment,
    onProject: scriptId => remember(google = { scriptId }) });
  let deployed: WorkerDeployment;
  try { deployed = await deploy(google); } catch (error) {
    // The user deleted the deployment or the whole project: a new one is made.
    if (!(error instanceof GoogleFailure && google)) throw error;
    if (error.reason === 'update_deployment_404') deployed = await deploy(google = { scriptId: google.scriptId });
    else if (error.reason === 'update_content_404') deployed = await deploy(google = null);
    else throw error;
  }
  await remember(deployed);
  journal(google?.deploymentId === deployed.deploymentId ?
    t(`The worker project is reused, version ${pkg.version} is in: ${deployed.url}`, `Проект воркера переиспользуется, залита версия ${pkg.version}: ${deployed.url}`) :
    t(`The worker is deployed, version ${pkg.version}: ${deployed.url}`, `Воркер развёрнут, версия ${pkg.version}: ${deployed.url}`));
  checkpoint();

  const secret = await readSecret(secretKeychain);
  if (!secret) throw new CommandFailed(t('There is no worker secret in the Keychain. Try again.', 'В Связке ключей нет секрета воркера. Повторите.'));
  const ask = async (action: string, extra?: Record<string, unknown>) => workerDid(await askWorker({ fetch, url: deployed.url, secret }, action, extra), null);
  // The web app of the just-updated deployment can still serve the previous version, answering
  // forbidden to the fresh secret; askAfterDeploy waits that out. null — the script not allowed
  // yet — goes on to the consent below.
  let status: WorkerReply | null = await askAfterDeploy({ fetch, url: deployed.url, secret, now, sleep, io, command: null });
  if (status === null) {
    io.print(t(`Let the worker script run: ${deployed.url}`, `Разрешите скрипту воркера работать: ${deployed.url}`));
    io.print(t('Pick your account, pass «Google hasn\'t verified this app» through «Advanced» and click «Allow». aures goes on by itself.',
      'Выберите свой аккаунт, пройдите «Google не проверял это приложение» через «Дополнительные настройки» и нажмите «Разрешить». ' +
        'aures продолжит сам.'));
    await open(deployed.url);
    io.wait(t('Waiting for the script to be allowed…', 'Ждём, когда скрипту разрешат работать…'));
    try {
      while (status === null) {
        await sleep(5_000);
        status = await askWorker({ fetch, url: deployed.url, secret }, 'status');
      }
    } finally { io.wait(null); }
    journal(t('The worker script is allowed to run.', 'Скрипту воркера разрешено работать.'));
  }
  if (workerDid(status, null).schedule === true) await ask('schedule', { on: false });
  checkpoint();
  await ask('rules', { rules: { beforeExpiry: rules.beforeExpiry, weeklyAutoApply: rules.weeklyAutoApply } });
  journal(rulesLine(rules));
  checkpoint();

  journal(signingIn());
  io.print(chatgptLogin());
  const session = await deviceLogin({ fetch, now, sleep, onCode: showCode(io, open, copy) });
  checkpoint();
  const id = randomUUID();
  const taken = await ask('login', { login: { id, session } });
  const summary = taken.summary as Summary | null;
  if (summary?.login?.id === id && summary.login.result === 'rejected') {
    throw new CommandFailed(t('This is another ChatGPT account than the one of the worker project. Sign in to that one.',
      'Это другой аккаунт ChatGPT, не тот, что у проекта воркера. Войдите в него.'));
  }
  if (summary?.login?.id !== id) {
    throw new CommandFailed(taken.outcome === 'broken_state' ? brokenOnGoogle(taken.reason) :
      t('The worker did not take the ChatGPT sign-in.', 'Воркер не принял вход в ChatGPT.'));
  }
  journal(t('The new worker has its ChatGPT session.', 'У нового воркера своя сессия ChatGPT.'));
  return sessionEmail(session);
};

// ─── Steps 3 and 4: the old and the new worker ──────────────────────────────

// Why the old worker is not to be quenched now, or null. A quenched worker never settles an
// application with an unknown outcome, and on GitHub a run under way may leave one: its summary is
// published only at its end. A revoke run is the quench's own, left by a quench that stopped. A web
// app that is gone runs nothing any more.
async function busyNow(worker: Worker): Promise<string | null> {
  let summary: Summary | null;
  if (worker.platform === 'google') {
    try { summary = (await worker.ask('status')).summary as Summary | null; } catch (error) {
      if (error instanceof GoogleFailure && error.reason === 'web_app_404') return null;
      throw error;
    }
  } else {
    const { api, repo } = worker;
    const [published, runs] = await Promise.all([readSummary(api, repo), api.runs(repo.full_name, WORKFLOW_FILE)]);
    if (runs.some(run => run.status !== 'completed' && run.display_title !== 'Revoke session')) {
      return t('a run of the old worker is under way.', 'идёт запуск старого воркера.');
    }
    summary = published;
  }
  return summary?.pending ? unknownOutcome(summary.pending) : null;
}

// The worker on the platform switched from, as the record and the sign-ins find it; null when it
// is gone: no repository, or a project never deployed. A worker that is there but cannot be
// reached stops the switch: it may still have its schedule.
async function openOld(options: FinishSwitchOptions, from: Platform, install: Install): Promise<Worker | null> {
  if (from === 'github') {
    const github = await connectGitHub(options);
    const repo = await workerRepository(github);
    return repo && { platform: 'github', api: github.api, repo };
  }
  return install.google?.url ? googleWorker(options, install.google.scriptId, install.google.url) : null;
}

// The worker on the platform switched to.
async function openNew(options: FinishSwitchOptions, target: Platform, install: Install): Promise<Worker> {
  if (target === 'github') {
    const github = await connectGitHub(options);
    return { platform: 'github', api: github.api, repo: await installedWorker(github) };
  }
  if (!install.google?.url) throw new CommandFailed(unfinished());
  return googleWorker(options, install.google.scriptId, install.google.url);
}

async function googleWorker({ fetch, secretKeychain }: FinishSwitchOptions, scriptId: string, url: string): Promise<GoogleWorker> {
  const secret = await readSecret(secretKeychain);
  if (!secret) {
    throw new CommandFailed(t('There is no worker secret in the Keychain of this Mac: it may be locked. Unlock it and try again.',
      'В Связке ключей этого Mac нет секрета воркера: возможно, она заблокирована. Разблокируйте её и повторите.'));
  }
  const ask: Ask = async (action, extra) => workerDid(await askWorker({ fetch, url, secret }, action, extra), null);
  return { platform: 'google', scriptId, url, ask, status: () => ask('status') };
}

// Revokes the old worker's session, then takes its schedule off. A revocation that fails is
// told and the quench goes on: without a schedule the old worker does not run. A failure to take
// the schedule off stops the switch, and «Повторить переключение» quenches again.
async function quench(worker: Worker, options: FinishSwitchOptions): Promise<void> {
  const { journal } = options;
  journal(t('Revoking the old worker\'s ChatGPT session…', 'Отзываем сессию ChatGPT старого воркера…'));
  let notRevoked: string | null;
  try { notRevoked = worker.platform === 'github' ? await revokeOnGitHub(worker, options) : await revokeOnGoogle(worker); } catch (error) {
    if (error instanceof StillPending) throw error;
    notRevoked = explain(error);
    if (notRevoked === null) throw error;
  }
  if (notRevoked === null) journal(t('The old worker\'s session is revoked.', 'Сессия старого воркера отозвана.'));
  else journal(t(`The old worker's session is not revoked: ${notRevoked}.`, `Сессия старого воркера не отозвана: ${notRevoked}.`), 'warn');

  try {
    if (worker.platform === 'github') await worker.api.setWorkflow(worker.repo.full_name, WORKFLOW_FILE, false);
    else await worker.ask('schedule', { on: false });
  } catch (error) {
    // A web app that is gone runs nothing any more.
    if (!(error instanceof GoogleFailure && error.reason === 'web_app_404')) throw error;
  }
  journal(t('The old worker\'s schedule is off: it is quenched.', 'Расписание старого воркера снято: он погашен.'));
}

// Step 4 on GitHub: the cron goes into the workflow while it is still disabled, a minute picked
// now for a workflow prepareGitHub wrote without one, then the workflow is enabled.
async function scheduleOnGitHub({ api, repo }: GitHubWorker, random: () => number): Promise<void> {
  const name = repo.full_name, workflow = await api.file(name, FILES.workflow);
  const yaml = workflowYaml({ minute: (workflow && workflowMinute(workflow.text)) ?? 1 + Math.floor(random() * 59) });
  if (workflow?.text !== yaml) await api.putFile(name, FILES.workflow, yaml, { message: `Worker workflow ${pkg.version}`, sha: workflow?.sha });
  await api.setWorkflow(name, WORKFLOW_FILE, true);
}

// Why the session was not revoked, or null when it was. A dispatch needs the workflow on, so a
// workflow that is already off (a quench repeated after it got that far) has had its revoke run.
async function revokeOnGitHub({ api, repo }: GitHubWorker, { io, now, sleep }: FinishSwitchOptions): Promise<string | null> {
  const name = repo.full_name;
  const [state, hasKey, workflow, enabled] = await Promise.all([api.file(name, FILES.state), api.hasSecret(name, STATE_KEY_SECRET),
    api.file(name, FILES.workflow), api.workflowState(name, WORKFLOW_FILE)]);
  if (!state || !hasKey) return null;
  if (!workflow?.text.includes(REVOKE_INPUT)) return t('the worker is out of date', 'воркер устарел');
  if (enabled !== 'active') return t('the worker is already disabled in GitHub', 'воркер уже выключен в GitHub');
  const { run, logged } = await runWorkerNow({ api, repo, inputs: { [REVOKE_INPUT]: 'true' }, now, sleep, wait: io.wait });
  if (logged?.outcome === 'revoked') return null;
  if (logged?.outcome === 'revoke_failed') return t(`ChatGPT did not confirm it (${logged.reason})`, `ChatGPT не подтвердил отзыв (${logged.reason})`);
  return t(`the run ended with an error: ${run.html_url}`, `запуск завершился с ошибкой: ${run.html_url}`);
}

// The old worker on Google has an application with an unknown outcome: it refused the revocation
// and is not quenched. The message is the reason, as busyNow gives it.
class StillPending extends Error {}

async function revokeOnGoogle(worker: GoogleWorker): Promise<string | null> {
  const reply = await worker.ask('revoke');
  if (reply.outcome === 'revoked' || reply.outcome === 'no_session') return null;
  if (reply.outcome === 'pending') throw new StillPending(unknownOutcome(reply.pending as NonNullable<Summary['pending']>));
  return t(`ChatGPT did not confirm it (${reply.reason})`, `ChatGPT не подтвердил отзыв (${reply.reason})`);
}

