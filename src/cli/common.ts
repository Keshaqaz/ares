// What every command shares: the GitHub login, the worker repository, a worker run started
// from the CLI and the words the user sees when something fails.
import { GitHubApi, GitHubFailure, githubDeviceLogin } from '../github/api.ts';
import type { Dispatched, GitHubFailureReason, Repository, WorkflowRun } from '../github/api.ts';
import { GoogleFailure } from '../google/api.ts';
import type { GoogleFailureReason } from '../google/api.ts';
import { LoginFailed } from '../chatgpt/session.ts';
import type { DeviceCode } from '../chatgpt/session.ts';
import { TransientFailure } from '../chatgpt/http.ts';
import type { Fetch } from '../chatgpt/http.ts';
import { FILES } from '../worker/layout.ts';
import { RULES_FORMAT_VERSION } from '../worker/state-file.ts';
import type { Rules, ApplyReason, AttemptResult } from '../worker/state-file.ts';
import type { Summary } from '../worker/summary.ts';
import type { RunOutcome } from '../worker/run.ts';
import type { WouldApply } from '../worker/tick.ts';
import { KeychainUnavailable } from './keychain.ts';
import type { Keychain } from './keychain.ts';
import type { Mac } from './mac-check.ts';
import type { OpenUrl, CopyText } from './browser.ts';
import type { Platform } from './watch-files.ts';
import { t } from './language.ts';

export const WORKER_REPOSITORY = 'codex-auto-resets-worker';
// The mark that tells our repository from a foreign one with the same name. It is set in
// the same call that creates the repository, so an interrupted setup always leaves it.
export const WORKER_DESCRIPTION = 'Worker of codex-auto-resets: applies issued ChatGPT resets by the general rules. Managed by the codex-auto-resets CLI.';
export const WORKFLOW_FILE = FILES.workflow.split('/').at(-1) ?? FILES.workflow;
const RUN_TIMEOUT_MS = 10 * 60_000, POLL_MS = 5_000;
// Job logs appear a few seconds after the run completes.
const LOG_ATTEMPTS = 4;
const OUTCOMES: RunOutcome[] = ['idle', 'applied', 'pending', 'would_apply', 'transient_error', 'reauth_required', 'broken_state', 'commit_failed',
  'revoked', 'revoke_failed'];

export type Sleep = (ms: number) => Promise<unknown>;
// Where a command tells the user what goes on.
export interface Printer { print(line: string): void }
// The user at the terminal: wait(text) shows what a command waits for, wait(null) ends it.
export interface Io extends Printer {
  prompt(question: string): Promise<string>;
  wait(text: string | null): void;
  color?: boolean;
  width?: number;
}
// What main hands every command; now, sleep and timeZone are the real ones unless a test sets them.
export interface CommandOptions {
  fetch: Fetch;
  // The GitHub token; the Google sign-in and the doPost secret of the worker on Apps Script.
  keychain: Keychain;
  googleKeychain: Keychain;
  secretKeychain: Keychain;
  // Opens a page in the browser.
  open: OpenUrl;
  // Puts a code on the clipboard.
  copy: CopyText;
  io: Io;
  mac: Mac;
  now?: () => number;
  sleep?: Sleep;
  timeZone?: string;
}
// The GitHub sign-in a command works with.
export interface GitHub { api: GitHubApi; login: string }
// The outcome the worker printed into its job log, with its reason, and for would_apply the reset.
export interface Logged { outcome: RunOutcome; reason: string | null; wouldApply?: WouldApply }
// One of the general rules.
export type Rule = Exclude<keyof Rules, 'formatVersion'>;

// A failure explained to the user in its message.
export class CommandFailed extends Error {}
// The dispatched run did not start within the wait: it has read no secret yet.
export class RunNotStarted extends CommandFailed {}

export const unfinished = (): string => t('Setup is not finished. Run `aures setup`.', 'Установка не завершена. Запустите `aures setup`.');
// What the user does about a switch of platform that stopped after the old worker started to be
// quenched (ADR-0007): no worker is active until it is finished on the screen «Воркер».
export const switchUnfinished = (): string => t('The switch of platform is not finished: no worker is active and resets are not applied. ' +
  'Open the screen «Worker» (`aures`, then Tab) and choose «Retry the switch».',
'Переключение площадки не завершено: активного воркера нет, сбросы не применяются. ' +
  'Откройте экран «Воркер» (`aures`, затем Tab) и выберите «Повторить переключение».');
export const enableUrl = (repo: Repository): string => `${repo.html_url}/actions/workflows/${WORKFLOW_FILE}`;

// Answers that confirm a one-way action.
export const YES = ['y', 'yes', 'д', 'да'];
export const onOff = (value: boolean): string => value ? t('on', 'включено') : t('off', 'выключено');
export const chatgptLogin = (): string => t('Sign in to ChatGPT for the worker (Codex on this computer is not affected).',
  'Вход в ChatGPT для воркера (Codex на этом компьютере не затронут).');
// What a device-code login tells the user: the page is opened in the browser and the code is
// copied to the clipboard, and both the address and the code are printed too, so a browser or a
// clipboard that does not work leaves the user a way on. Neither failure ends the login: the
// line with the code is printed whatever happens, and the polling goes on. open and copy are
// injected, as the tests do; the mark says the code was copied only when it was.
export const showCode = (io: Printer, open: OpenUrl, copy: CopyText) =>
  async ({ userCode, verificationUrl }: DeviceCode): Promise<void> => {
    let copied = false;
    try { copied = await copy(userCode); } catch { /* the code is printed below anyway */ }
    io.print(t(`Open ${verificationUrl} and enter the code ${userCode}${copied ? ' (code copied)' : ''}`,
      `Откройте ${verificationUrl} и введите код ${userCode}${copied ? ' (код скопирован)' : ''}`));
    io.print(t(`If the browser did not open: ${verificationUrl}`, `Если браузер не открылся: ${verificationUrl}`));
    try { await open(verificationUrl); } catch { /* the address is printed above anyway */ }
  };
export const formatTime = (ms: number, timeZone?: string): string => new Intl.DateTimeFormat(t('en-GB', 'ru-RU'), { day: 'numeric', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZone, timeZoneName: 'short' }).format(ms);

// The two general rules as the user reads them in rules, status and the screen. The
// before-expiry window is the platform's (ADR-0007).
export const ruleLabel = (rule: Rule, platform: Platform = 'github'): string => ({
  beforeExpiry: platform === 'google' ? t('Before expiry (in the last hour)', 'Перед истечением (в последний час)') :
    t('Before expiry (in the last 8 hours)', 'Перед истечением (в последние 8 часов)'),
  weeklyAutoApply: t('When the weekly limit runs out', 'Когда кончится недельный лимит'),
})[rule];
// Why a reset was applied.
export const reasonText = (reason: ApplyReason): string => ({
  before_expiry: t('before expiry', 'перед истечением'),
  weekly: t('the weekly limit ran out', 'кончился недельный лимит'),
  apply_now: t('manually', 'вручную'),
})[reason] ?? reason;
// lastAttempt.result of an attempt that did not apply the reset.
export const attemptResult = (result: AttemptResult): string => ({
  nothing_to_reset: t('nothing to reset, the reset is kept', 'сбрасывать нечего, сброс сохранён'),
  no_credit: t('ChatGPT did not accept the reset', 'ChatGPT не принял сброс'),
  missing: t('the reset is no longer available', 'сброс уже недоступен'),
  unknown: t('unclear whether it was applied or expired', 'неясно, применён он или истёк'),
} as Partial<Record<AttemptResult, string>>)[result] ?? result;

// How the CLI names a reset: RES and the last 4 characters of its hex ID, the random part.
// «RateLimitResetCredit_0eb466b3212c819193799a1741f067f8» is «RES67F8». An ID of another form is
// shown whole; the worker and its summary keep the whole ID.
export const resetName = (creditId: string): string => {
  const hex = /_([0-9a-f]{8,})$/.exec(creditId)?.[1];
  return hex ? `RES${hex.slice(-4).toUpperCase()}` : creditId;
};
type Expiring = { expiresAt: string | null };
export const deadline = (reset: Expiring, timeZone?: string): string => reset.expiresAt ?
  `${t('expires', 'истекает')} ${formatTime(Date.parse(reset.expiresAt), timeZone)}` : t('no expiry', 'без срока');
export const byDeadline = <T extends Expiring>(resets: T[]): T[] => [...resets].sort((a, b) =>
  (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity));

// fresh signs in anew even with a sign-in in the Keychain.
export async function connectGitHub({ fetch, keychain, io, open, copy, now, sleep, fresh = false }:
  { fetch: Fetch; keychain: Keychain; io: Printer; open: OpenUrl; copy: CopyText; now: () => number; sleep: Sleep; fresh?: boolean }): Promise<GitHub> {
  let token: string | null = null;
  if (!fresh) try { token = await keychain.read(); } catch (error) { if (!(error instanceof KeychainUnavailable)) throw error; }
  if (token) {
    const api = new GitHubApi({ fetch, token });
    try { return { api, login: await api.login() }; } catch (error) {
      if (!(error instanceof GitHubFailure && error.reason === 'unauthorized')) throw error;
      io.print(t('The GitHub sign-in has expired, sign in again.', 'Вход в GitHub устарел, войдите снова.'));
    }
  }
  io.print(t('Sign in to GitHub.', 'Вход в GitHub.'));
  token = await githubDeviceLogin({ fetch, now, sleep, onCode: showCode(io, open, copy) });
  const api = new GitHubApi({ fetch, token });
  const login = await api.login();
  try { await keychain.write(token); } catch (error) {
    if (!(error instanceof KeychainUnavailable)) throw error;
    io.print(t('Could not save the sign-in to the Keychain: GitHub will ask you to sign in again next time.',
      'Не удалось сохранить вход в Связку ключей: в следующий раз GitHub попросит войти снова.'));
  }
  io.print(t(`Signed in to GitHub as ${login}.`, `Вы вошли в GitHub как ${login}.`));
  return { api, login };
}

// The worker repository as setup left it; null when there is none. A repository of that
// name without our mark, or a public one, is never touched.
export async function workerRepository({ api, login }: GitHub): Promise<Repository | null> {
  const repo = await api.repository(`${login}/${WORKER_REPOSITORY}`);
  if (!repo) return null;
  if (repo.description !== WORKER_DESCRIPTION) {
    throw new CommandFailed(t(`The repository ${repo.html_url} was not created by aures. ` +
      'Rename or delete it and run `aures setup` again.',
    `Репозиторий ${repo.html_url} создан не aures. Переименуйте или удалите его и повторите \`aures setup\`.`));
  }
  // The repository holds the sealed session and the reset schedule.
  if (!repo.private) {
    throw new CommandFailed(t(`The repository ${repo.html_url} is public. Make it private and run \`aures setup\` again.`,
      `Репозиторий ${repo.html_url} открыт всем. Сделайте его приватным и повторите \`aures setup\`.`));
  }
  return repo;
}

// The worker repository for a command that needs an installed worker.
export async function installedWorker(options: GitHub): Promise<Repository> {
  const repo = await workerRepository(options);
  if (!repo) throw new CommandFailed(t('The worker is not installed. Run `aures setup`.', 'Воркер не установлен. Запустите `aures setup`.'));
  return repo;
}

// The workflow must be able to take a dispatch.
export async function runnableWorkflow(api: GitHubApi, repo: Repository): Promise<void> {
  const state = await api.workflowState(repo.full_name, WORKFLOW_FILE);
  if (!state) throw new CommandFailed(unfinished());
  if (state !== 'active') {
    throw new CommandFailed(t(`The worker is disabled in GitHub. Turn it on with the Enable workflow button: ${enableUrl(repo)}`,
      `Воркер выключен в GitHub. Включите его кнопкой Enable workflow: ${enableUrl(repo)}`));
  }
}

export async function chooseRules(io: Io, initial: Pick<Rules, Rule> = { beforeExpiry: true, weeklyAutoApply: false },
  platform: Platform = 'github'): Promise<Rules> {
  const rules = { beforeExpiry: initial.beforeExpiry, weeklyAutoApply: initial.weeklyAutoApply };
  for (;;) {
    io.print(t('When to apply resets:', 'Когда применять сбросы:'));
    io.print(`  1. ${ruleLabel('beforeExpiry', platform)} — ${onOff(rules.beforeExpiry)}`);
    io.print(`  2. ${ruleLabel('weeklyAutoApply', platform)} — ${onOff(rules.weeklyAutoApply)}`);
    const answer = (await io.prompt(t('Enter — done, 1 or 2 — switch: ', 'Enter — готово, 1 или 2 — переключить: '))).trim();
    if (!answer) return { formatVersion: RULES_FORMAT_VERSION, ...rules };
    if (answer === '1') rules.beforeExpiry = !rules.beforeExpiry;
    else if (answer === '2') rules.weeklyAutoApply = !rules.weeklyAutoApply;
    else io.print(t('Type 1 or 2, or press Enter.', 'Введите 1, 2 или нажмите Enter.'));
  }
}

// What the worker publishes openly (summary.json), or null before its first read.
export async function readSummary(api: GitHubApi, repo: Repository): Promise<Summary | null> {
  const file = await api.file(repo.full_name, FILES.summary);
  if (!file) return null;
  // Our own worker writes it, so it is taken as it is.
  try { return JSON.parse(file.text) as Summary; } catch {
    throw new CommandFailed(t('The worker data does not read. Try again after its next run.', 'Данные воркера не читаются. Повторите после его следующего запуска.'));
  }
}

// The line that tells the user the worker works, from its summary.
export function workingLine(summary: Summary, timeZone?: string): string {
  const resets = summary.resets ?? [];
  const deadlines = resets.map(r => r.expiresAt && Date.parse(r.expiresAt)).filter((ms): ms is number => Boolean(ms)).sort((a, b) => a - b);
  const nearest = deadlines[0];
  if (nearest === undefined) return t(`The worker works. Resets: ${resets.length}.`, `Воркер работает. Сбросов: ${resets.length}.`);
  return t(`The worker works. Resets: ${resets.length}, the nearest expires ${formatTime(nearest, timeZone)}.`,
    `Воркер работает. Сбросов: ${resets.length}, ближайший истекает ${formatTime(nearest, timeZone)}.`);
}

// What the rules would do now, by a trial run's outcome; nothing for another outcome.
export function trialVerdict({ outcome, wouldApply }: Pick<Logged, 'outcome' | 'wouldApply'>): string | null {
  if (wouldApply) {
    const name = resetName(wouldApply.creditId), why = reasonText(wouldApply.reason);
    return t(`Now the rules would apply the reset ${name} (${why}).`, `Сейчас правила применили бы сброс ${name} (${why}).`);
  }
  return outcome === 'idle' ? t('Nothing to apply now.', 'Сейчас применять нечего.') : null;
}
// A trial run before the worker's first successful read; busy: ChatGPT did not answer it.
export const notReadYet = (busy: boolean): string =>
  t(`The worker is installed, but the resets are not read yet${busy ? ': ChatGPT is temporarily unavailable' : ''}. ` +
    'The worker will try again on its next run.',
  `Воркер установлен, но сбросы пока не прочитаны${busy ? ': ChatGPT временно недоступен' : ''}. Воркер повторит при следующем запуске.`);

// The last outcome the worker printed into its job log (runLine), e.g. «2026-…Z broken_state: key_invalid»
// or «2026-…Z would_apply: weekly RateLimitResetCredit_…».
export function loggedOutcome(log: string | null): Logged | null {
  let found: Logged | null = null;
  for (const line of (log ?? '').split('\n')) {
    const match = line.match(/^(?:\S+Z )?([a-z_]+)(?:: ([a-z0-9_]+)(?: (\S+))?)?\s*$/);
    const outcome = OUTCOMES.find(known => known === match?.[1]);
    if (!match || !outcome) continue;
    const [, , reason = null, creditId] = match;
    // runLine prints an ApplyReason next to would_apply.
    found = { outcome, reason, ...outcome === 'would_apply' && reason && creditId && { wouldApply: { creditId, reason: reason as ApplyReason } } };
  }
  return found;
}

// What the user does about a run that failed with this outcome.
export function failedRunAdvice({ outcome, reason }: Partial<Logged> = {}): string {
  const advice: Partial<Record<RunOutcome, string>> = {
    reauth_required: t('The worker lost its ChatGPT sign-in. Sign in again: `aures login`.',
      'Воркер потерял вход в ChatGPT. Войдите заново: `aures login`.'),
    broken_state: reason?.startsWith('rules_') ?
      t(`The rules file does not read (${reason}). Delete ${FILES.rules} in the repository and run \`aures setup\` again.`,
        `Файл правил не читается (${reason}). Удалите ${FILES.rules} в репозитории и повторите \`aures setup\`.`) :
      t(`The file with the ChatGPT sign-in does not read (${reason}). Delete ${FILES.state} in the repository and run ` +
        '`aures setup` again: it will ask you to sign in to ChatGPT again.',
      `Файл со входом в ChatGPT не читается (${reason}). Удалите ${FILES.state} в репозитории и повторите \`aures setup\`: ` +
        'он попросит войти в ChatGPT заново.'),
    commit_failed: t('The worker could not save its data in the repository. Run `aures setup` again. ' +
      'If an email about a worker failure follows, sign in again: `aures login`.',
    'Воркер не смог сохранить данные в репозитории. Повторите `aures setup`. ' +
      'Если потом придёт письмо об ошибке воркера, войдите заново: `aures login`.'),
  };
  return (outcome && advice[outcome]) ?? t('The worker ended with an error.', 'Воркер завершился с ошибкой.');
}

// What a wait for a dispatched run is at: the run not seen yet, queued for a runner, running,
// or GitHub not answering the last poll.
type Stage = 'starting' | 'queued' | 'running' | 'unreachable';
const waitText = (stage: Stage): string => ({
  starting: t('Starting the worker on GitHub…', 'Запускаем воркер на GitHub…'),
  queued: t('GitHub queued the worker, waiting (up to 10 minutes)…', 'GitHub поставил воркер в очередь, ждём (до 10 минут)…'),
  running: t('The worker is running…', 'Воркер работает…'),
  unreachable: t('GitHub does not answer, still waiting…', 'GitHub не отвечает, продолжаем ждать…'),
})[stage];
// A poll that failed this way is worth repeating: the run is already dispatched and goes on.
const passing = (error: unknown): boolean => error instanceof GitHubFailure && (error.reason === 'network' || /_5\d\d$/.test(error.reason));

// Dispatches one worker run with these inputs and waits for it. Returns the completed run
// and the outcome from its log (null when the log does not show one). wait(text) tells what
// the wait is at whenever that changes, and wait(null) when it is over.
export interface WorkerRunOptions {
  api: GitHubApi;
  repo: Repository;
  inputs: Record<string, string>;
  now: () => number;
  sleep: Sleep;
  wait?: (text: string | null) => void;
}
export async function runWorkerNow({ api, repo, inputs, now, sleep, wait = () => {} }: WorkerRunOptions):
  Promise<{ run: WorkflowRun; logged: Logged | null }> {
  const name = repo.full_name;
  let shown: Stage | null = null;
  const show = (stage: Stage) => { if (stage !== shown) wait(waitText(shown = stage)); };
  try {
    const known = new Set((await api.dispatchRuns(name, WORKFLOW_FILE)).map(run => run.id));
    const deadline = now() + RUN_TIMEOUT_MS;
    show('starting');
    // GitHub learns about a freshly pushed workflow with a delay.
    let dispatched: Dispatched | null;
    for (;;) {
      dispatched = await api.dispatch(name, WORKFLOW_FILE, { ref: repo.default_branch, inputs: { apply_now: '', ...inputs } });
      if (dispatched) break;
      if (now() >= deadline) {
        throw new CommandFailed(t('GitHub is not ready to start the worker yet. Try again in a few minutes.',
          'GitHub ещё не готов запустить воркер. Повторите через несколько минут.'));
      }
      await sleep(POLL_MS);
    }
    // Follow the run GitHub named. Without its id, take the first new run, which may be
    // another dispatch, such as one from the check on this Mac.
    const { runId } = dispatched;
    const poll = async (run: WorkflowRun | null): Promise<WorkflowRun | null> => {
      if (run) return await api.run(name, run.id) ?? run;
      if (runId !== null) return api.run(name, runId);
      return (await api.dispatchRuns(name, WORKFLOW_FILE)).find(r => !known.has(r.id)) ?? null;
    };
    let run: WorkflowRun | null = null;
    for (;;) {
      try {
        run = await poll(run);
        show(!run ? 'starting' : run.status === 'in_progress' ? 'running' : 'queued');
      } catch (error) {
        if (!passing(error)) throw error;
        show('unreachable');
      }
      if (run?.status === 'completed') break;
      if (now() >= deadline) {
        if (run?.status === 'in_progress') {
          throw new CommandFailed(t(`The worker has been running for over 10 minutes. Check later: ${run.html_url}`,
            `Воркер работает дольше 10 минут. Проверьте позже: ${run.html_url}`));
        }
        throw new RunNotStarted(!run ?
          t(`GitHub did not start the worker in 10 minutes. Check: ${repo.html_url}/actions`,
            `GitHub не запустил воркер за 10 минут. Проверьте: ${repo.html_url}/actions`) :
          t(`The worker has been waiting in the GitHub queue for over 10 minutes; it will run by itself. Check later: ${run.html_url}`,
            `Воркер ждёт в очереди GitHub дольше 10 минут и запустится сам. Проверьте позже: ${run.html_url}`));
      }
      await sleep(POLL_MS);
    }
    let logged: Logged | null = null;
    for (let attempt = 1; !logged && attempt <= LOG_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(POLL_MS);
      logged = loggedOutcome(await api.runLog(name, run.id).catch(() => null));
    }
    return { run, logged };
  } finally { if (shown) wait(null); }
}

// The message for a failure this module knows, or null. command names what to repeat: '' is
// the screen itself, null an action on the screen, which the user just repeats.
export function explain(error: unknown, command: string | null = null): string | null {
  if (error instanceof CommandFailed) return error.message;
  const program = `\`aures${command ? ` ${command}` : ''}\``;
  const again = command === null ? t('Try again', 'Повторите') : t(`Run ${program} again`, `Повторите ${program}`);
  const kept = t('what is done is kept', 'сделанное сохранится');
  if (error instanceof GitHubFailure) {
    return ({
      unauthorized: t(`GitHub rejected the sign-in. ${again} and sign in anew.`, `GitHub отклонил вход. ${again} и войдите заново.`),
      network: t(`GitHub is unreachable. ${again}: ${kept}.`, `GitHub недоступен. ${again}: ${kept}.`),
      login_timeout: t(`The time to enter the GitHub code ran out. ${again}.`, `Время на ввод кода GitHub вышло. ${again}.`),
      login_denied: t('The GitHub sign-in was denied.', 'Вход в GitHub отклонён.'),
    } as Partial<Record<GitHubFailureReason, string>>)[error.reason] ?? t(`GitHub error (${error.reason}). ${again}: ${kept}.`, `Ошибка GitHub (${error.reason}). ${again}: ${kept}.`);
  }
  if (error instanceof GoogleFailure) {
    return ({
      invalid_grant: t(`Google ended the sign-in. ${again} and sign in anew.`, `Google завершил вход. ${again} и войдите заново.`),
      unauthorized: t(`Google rejected the sign-in. ${again} and sign in anew.`, `Google отклонил вход. ${again} и войдите заново.`),
      network: t(`Google is unreachable. ${again}: ${kept}.`, `Google недоступен. ${again}: ${kept}.`),
      login_timeout: t(`The time to sign in to Google ran out. ${again}.`, `Время на вход в Google вышло. ${again}.`),
      login_denied: t('The Google sign-in was denied.', 'Вход в Google отклонён.'),
    } as Partial<Record<GoogleFailureReason, string>>)[error.reason] ?? t(`Google error (${error.reason}). ${again}: ${kept}.`, `Ошибка Google (${error.reason}). ${again}: ${kept}.`);
  }
  if (error instanceof LoginFailed) {
    return error.reason === 'timeout' ? t(`The time to enter the ChatGPT code ran out. ${again}.`, `Время на ввод кода ChatGPT вышло. ${again}.`) :
      t(`Could not sign in to ChatGPT (${error.reason}). ${again}.`, `Не удалось войти в ChatGPT (${error.reason}). ${again}.`);
  }
  if (error instanceof TransientFailure) return t(`ChatGPT is unreachable. ${again}: ${kept}.`, `ChatGPT недоступен. ${again}: ${kept}.`);
  return null;
}

// Runs a command body and turns known failures into their message and exit code 1. name is the
// command to repeat after a failure; null an action on the screen, which the user just repeats.
export async function command(name: string | null, io: Printer, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (error) {
    const message = explain(error, name);
    if (message === null) throw error;
    for (const line of message.split('\n')) io.print(line);
    return 1;
  }
}
