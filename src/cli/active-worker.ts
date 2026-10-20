// The worker of this install, wherever it runs (ADR-0007): what status, apply-now, rules, login
// and the screen work with. The platform comes from the install record on this Mac and is
// checked against the cloud; without a record the user says where to look, and the record is
// written again. On Google the commands talk to the worker through doPost with the secret: they
// need no Google sign-in.
import { GoogleFailure } from '../google/api.ts';
import type { GoogleApi } from '../google/api.ts';
import type { GitHubApi, Repository } from '../github/api.ts';
import { PROJECT_TITLE, PROJECT_FILES, SCRIPT_HOME, secretOf } from '../apps-script/layout.ts';
import { CommandFailed, WORKER_REPOSITORY, unfinished, connectGitHub, installedWorker } from './common.ts';
import type { CommandOptions, Printer } from './common.ts';
import { connectGoogle, askWorker, workerDid, readSecret } from './google.ts';
import type { WorkerReply } from './google.ts';
import { KeychainUnavailable } from './keychain.ts';
import { RULES_FORMAT_VERSION } from '../worker/state-file.ts';
import type { Rules } from '../worker/state-file.ts';
import type { Install } from './watch-files.ts';
import { t } from './language.ts';

// One doPost to the worker on Google; the reply is the one of a worker that did what it was asked.
export type Ask = (action: string, extra?: Record<string, unknown>) => Promise<WorkerReply>;
export interface GitHubWorker { platform: 'github'; api: GitHubApi; repo: Repository }
// status() is doPost status: the reply that opened the worker the first time, a fresh one after.
export interface GoogleWorker { platform: 'google'; scriptId: string; url: string; ask: Ask; status: () => Promise<WorkerReply> }
export type Worker = GitHubWorker | GoogleWorker;

// The rules as doPost status and rules give them: without their format.
export const rulesOf = (given: unknown): Rules | null => {
  const rules = given as Pick<Rules, 'beforeExpiry' | 'weeklyAutoApply'> | null;
  return rules && { formatVersion: RULES_FORMAT_VERSION, beforeExpiry: rules.beforeExpiry, weeklyAutoApply: rules.weeklyAutoApply };
};

// The project page on script.google.com, where the user sees the worker's runs.
export const projectUrl = (scriptId: string): string => `${SCRIPT_HOME}/projects/${encodeURIComponent(scriptId)}`;

// What opens the worker: the CommandOptions and the user at the terminal, who may be asked
// where to look. command names what to repeat after a failure, null an action on the screen.
export type OpenWorkerOptions = Omit<CommandOptions, 'io'> & { io: Printer & { prompt(question: string): Promise<string> } };

export async function openWorker(options: OpenWorkerOptions, command: string | null): Promise<Worker> {
  const { mac: { files } } = options;
  const install = await files.readInstall() ?? await findWorker(options);
  if ('api' in install) return install;
  if (install.platform === 'github') return openGitHub(options);
  const { google } = install;
  if (!google?.url || !google.deploymentId) throw new CommandFailed(unfinished());
  return openGoogle(options, google.scriptId, google.url, command);
}

async function openGitHub({ fetch, keychain, io, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }:
  OpenWorkerOptions): Promise<GitHubWorker> {
  const github = await connectGitHub({ fetch, keychain, io, now, sleep });
  return { platform: 'github', api: github.api, repo: await installedWorker(github) };
}

// Why the worker on Google does not answer, and what the user does: «Починить», which setup does
// until the screen «Воркер» has it.
const notAnswering = (why: string): CommandFailed => new CommandFailed(t(`The worker on Google does not answer: ${why}. ` +
  'Repair it: `aures setup` deploys it again.', `Воркер на Google не отвечает: ${why}. Почините его: \`aures setup\` заново зальёт воркер.`));

// The worker as the record has it, if it answers to the secret of this Mac.
async function openGoogle({ fetch, secretKeychain }: OpenWorkerOptions, scriptId: string, url: string, command: string | null):
  Promise<Worker> {
  const secret = await readSecret(secretKeychain);
  if (!secret) throw notAnswering(t('there is no worker secret in the Keychain of this Mac', 'в Связке ключей этого Mac нет секрета воркера'));
  let status: WorkerReply | null;
  try { status = await askWorker({ fetch, url, secret }, 'status'); } catch (error) {
    if (error instanceof GoogleFailure && error.reason === 'web_app_404') throw notAnswering(t('its web app is gone', 'его web app удалён'));
    throw error;
  }
  if (status === null) throw notAnswering(t('the script has no access', 'у скрипта нет доступа'));
  if (status.error === 'forbidden') throw notAnswering(t('it does not take the secret of this Mac', 'он не принимает секрет этого Mac'));
  const ask: Ask = async (action, extra) => workerDid(await askWorker({ fetch, url, secret }, action, extra), command);
  let opened: WorkerReply | null = workerDid(status, command);
  return { platform: 'google', scriptId, url, ask, status: async () => {
    const reply = opened ?? await ask('status');
    opened = null;
    return reply;
  } };
}

// Asks where the worker runs and finds it there; the record is written as soon as it is found.
// On GitHub the worker found is the one opened.
async function findWorker(options: OpenWorkerOptions): Promise<Install | GitHubWorker> {
  const { io, mac: { files } } = options;
  io.print(t('This Mac does not know where the worker runs.', 'Этот Mac не знает, где работает воркер.'));
  io.print(t(`  1. GitHub — the repository ${WORKER_REPOSITORY}`, `  1. GitHub — репозиторий ${WORKER_REPOSITORY}`));
  io.print(t(`  2. Google Apps Script — the project ${PROJECT_TITLE}`, `  2. Google Apps Script — проект ${PROJECT_TITLE}`));
  for (;;) {
    const answer = (await io.prompt(t('Where to look? Type 1 or 2: ', 'Где искать? Введите 1 или 2: '))).trim();
    if (answer === '1') {
      // installedWorker tells when there is none; the record follows only a found one.
      const worker = await openGitHub(options);
      await files.writeInstall({ platform: 'github' });
      return worker;
    }
    if (answer === '2') return findGoogle(options);
  }
}

// The project from the link the user pastes: the Apps Script API lists no projects, and Drive
// would take a restricted scope. The deployment and the doPost secret are read from the project.
async function findGoogle({ fetch, googleKeychain, secretKeychain, io, open, mac: { files }, now = Date.now }: OpenWorkerOptions):
  Promise<Install> {
  const api = await connectGoogle({ fetch, keychain: googleKeychain, io, open, now });
  io.print(t(`Open the project ${PROJECT_TITLE} on ${SCRIPT_HOME} and paste the link from the address bar.`,
    `Откройте проект ${PROJECT_TITLE} на ${SCRIPT_HOME} и вставьте ссылку из адресной строки.`));
  await open(SCRIPT_HOME);
  const scriptId = await pastedProject(api, io);
  const [content, deployments] = await Promise.all([api.content(scriptId), api.deployments(scriptId)]);
  const secretFile = content.find(file => file.name === PROJECT_FILES.secret);
  const secret = secretFile ? secretOf(secretFile.source) : null;
  // setup makes one deployment and keeps it; a later one is the user's own.
  const [deployment] = deployments;
  if (!secret || !deployment) {
    // setup goes on in this project.
    await files.writeInstall({ platform: 'google', google: { scriptId } });
    throw new CommandFailed(unfinished());
  }
  try { await secretKeychain.write(secret); } catch (error) {
    if (!(error instanceof KeychainUnavailable)) throw error;
    throw new CommandFailed(t('Could not save the worker secret to the Keychain. Unlock it and try again.',
      'Не удалось сохранить секрет воркера в Связку ключей. Разблокируйте её и повторите.'));
  }
  const install: Install = { platform: 'google', google: { scriptId, ...deployment } };
  await files.writeInstall(install);
  io.print(t(`The worker is found: ${deployment.url}`, `Воркер найден: ${deployment.url}`));
  return install;
}

// The editor's address, script.google.com/home/projects/<id>/edit or script.google.com/d/<id>/edit, with
// /u/<n> of another signed-in account in it or not, or the bare id.
const scriptIdOf = (text: string): string | null =>
  /^https:\/\/script\.google\.com\/(?:u\/\d+\/)?(?:home\/projects|d)\/([\w-]+)/.exec(text)?.[1] ?? (/^[\w-]+$/.test(text) ? text : null);

async function pastedProject(api: GoogleApi, io: OpenWorkerOptions['io']): Promise<string> {
  for (;;) {
    const answer = (await io.prompt(t('Link to the project (Enter — cancel): ', 'Ссылка на проект (Enter — отмена): '))).trim();
    if (!answer) throw new CommandFailed(t('Cancelled.', 'Отменено.'));
    const scriptId = scriptIdOf(answer);
    let title: string | null = null;
    if (scriptId) {
      try { title = await api.projectTitle(scriptId); } catch (error) {
        if (!(error instanceof GoogleFailure && /^get_project_40[34]$/.test(error.reason))) throw error;
      }
    }
    if (scriptId && title === PROJECT_TITLE) return scriptId;
    io.print(title === null ? t('There is no such project in your account. Paste the link of the open project.',
      'Такого проекта в вашем аккаунте нет. Вставьте ссылку открытого проекта.') :
      t(`This is the project «${title}»; the worker is ${PROJECT_TITLE}.`, `Это проект «${title}», а воркер — ${PROJECT_TITLE}.`));
  }
}
