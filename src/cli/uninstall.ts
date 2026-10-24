import { GitHubApi, githubDeviceLogin, UNINSTALL_SCOPES } from '../github/api.ts';
import { GITHUB_OAUTH_CLIENT_ID } from '../github/oauth-app.ts';
import { GoogleFailure, revokeGoogle } from '../google/api.ts';
import { PROJECT_TITLE } from '../apps-script/layout.ts';
import { FILES, STATE_KEY_SECRET, REVOKE_INPUT } from '../worker/layout.ts';
import { KeychainUnavailable } from './keychain.ts';
import type { Keychain } from './keychain.ts';
import { CommandFailed, YES, WORKER_REPOSITORY, WORKER_DESCRIPTION, WORKFLOW_FILE, showCode, runWorkerNow, command } from './common.ts';
import { connectGoogle, askWorker, readSecret } from './google.ts';
import type { WorkerReply } from './google.ts';
import { projectUrl } from './active-worker.ts';
import { forgetMac } from './mac-check.ts';
import type { CommandOptions, Io, Printer, Sleep } from './common.ts';
import type { GoogleWorker } from './watch-files.ts';
import type { Repository } from '../github/api.ts';
import { t } from './language.ts';

const OAUTH_APP = `https://github.com/settings/connections/applications/${GITHUB_OAUTH_CLIENT_ID}`;
// Where the user takes back the access of the worker script and of the CLI's Google sign-in.
const CONNECTIONS = 'https://myaccount.google.com/connections';
// The CLI's Desktop OAuth client, as the consent page and the connections page name it.
const GOOGLE_APP = 'aures';

// Has the worker revoke its session and tells the user how it went. Whatever happens, the
// removal goes on.
interface Revoking { api: GitHubApi; repo: Repository; io: Io; now: () => number; sleep: Sleep }
async function revokeWorkerSession({ api, repo, io, now, sleep }: Revoking): Promise<void> {
  const reason = await revoke({ api, repo, io, now, sleep });
  if (reason === null) io.print(t('The worker\'s ChatGPT sign-in is revoked.', 'Вход воркера в ChatGPT отозван.'));
  else if (reason) {
    io.print(t(`The worker's ChatGPT sign-in is not revoked: ${reason}. It goes with the repository.`,
      `Вход воркера в ChatGPT не отозван: ${reason}. Он удалится вместе с репозиторием.`));
  }
}

// Why the worker session was not revoked: null when it was, false when there is none.
async function revoke({ api, repo, io, now, sleep }: Revoking): Promise<string | null | false> {
  const name = repo.full_name;
  const [state, workflow, hasKey] = await Promise.all([api.file(name, FILES.state), api.file(name, FILES.workflow),
    api.hasSecret(name, STATE_KEY_SECRET)]);
  // An interrupted setup may have left no session to revoke.
  if (!state || !hasKey) return false;
  if (!workflow) return t('setup is not finished', 'установка не завершена');
  if (!workflow.text.includes(REVOKE_INPUT)) return t('the worker is out of date', 'воркер устарел');
  if (await api.workflowState(name, WORKFLOW_FILE) !== 'active') return t('the worker is disabled in GitHub', 'воркер выключен в GitHub');
  io.print(t('Revoking the worker\'s ChatGPT sign-in…', 'Отзываем вход воркера в ChatGPT…'));
  let run, logged;
  try { ({ run, logged } = await runWorkerNow({ api, repo, inputs: { [REVOKE_INPUT]: 'true' }, now, sleep, wait: io.wait })); } catch (error) {
    if (!(error instanceof CommandFailed)) throw error;
    return error.message.replace(/\.$/, '');
  }
  if (logged?.outcome === 'revoked') return null;
  if (logged?.outcome === 'revoke_failed') return t(`ChatGPT did not confirm the revocation (${logged.reason})`, `ChatGPT не подтвердил отзыв (${logged.reason})`);
  if (logged?.outcome === 'broken_state') return t(`the file with the sign-in does not read (${logged.reason})`, `файл со входом не читается (${logged.reason})`);
  return t(`the worker ended with an error: ${run.html_url}`, `воркер завершился с ошибкой: ${run.html_url}`);
}

// Has the worker on Google take off its triggers, revoke its session and drop the script's
// authorization (doPost uninstall), and tells the user how it went. true when it did all of it.
async function stopGoogleWorker({ fetch, secretKeychain, io }: Pick<CommandOptions, 'fetch' | 'secretKeychain'> & { io: Printer },
  url: string | undefined): Promise<boolean> {
  const secret = await readSecret(secretKeychain);
  let reply: WorkerReply | null = null, why: string | null = null;
  if (!url) why = t('setup is not finished', 'установка не завершена');
  else if (!secret) why = t('there is no worker secret in the Keychain of this Mac', 'в Связке ключей этого Mac нет секрета воркера');
  else {
    try { reply = await askWorker({ fetch, url, secret }, 'uninstall'); } catch (error) {
      if (!(error instanceof GoogleFailure)) throw error;
      why = error.reason === 'web_app_404' ? t('its web app is gone', 'его web app удалён') : t(`Google error (${error.reason})`, `ошибка Google (${error.reason})`);
    }
  }
  if (reply?.ok === true) {
    // The triggers are off, but the script keeps its state and authorization for a repeated uninstall to retry.
    if (reply.outcome === 'revoke_failed') {
      io.print(t(`The worker on Google is stopped, but its ChatGPT sign-in is not revoked: ChatGPT did not confirm the revocation (${reply.reason}). ` +
        'It goes with the project.',
      `Воркер на Google остановлен, но его вход в ChatGPT не отозван: ChatGPT не подтвердил отзыв (${reply.reason}). Он удалится вместе с проектом.`));
      return false;
    }
    io.print(reply.outcome === 'revoked' ? t('The worker on Google is stopped, its ChatGPT sign-in is revoked.', 'Воркер на Google остановлен, его вход в ChatGPT отозван.') :
      t('The worker on Google is stopped.', 'Воркер на Google остановлен.'));
    return true;
  }
  why ??= reply === null ? t('the script has no access', 'у скрипта нет доступа') : reply.error === 'forbidden' ?
    t('it does not take the secret of this Mac', 'он не принимает секрет этого Mac') : t(`it refused (${reply.error})`, `он отказал (${reply.error})`);
  io.print(t(`The worker on Google did not answer: ${why}. Its schedule and ChatGPT sign-in go with the project.`,
    `Воркер на Google не ответил: ${why}. Его расписание и вход в ChatGPT удалятся вместе с проектом.`));
  return false;
}

// Removes what the CLI can of the worker on Google: stops it, deletes its deployment, ends the
// CLI's Google sign-in and forgets both secrets. The project itself only the user can delete:
// the Apps Script API has no call for it. Returns the manual steps for what is left.
async function removeGoogle(options: CommandOptions & { now: () => number }, google: GoogleWorker | null): Promise<string[]> {
  const { fetch, googleKeychain, secretKeychain, io, open, now } = options;
  const stopped = google ? await stopGoogleWorker(options, google.url) : false;
  let token = await readSecret(googleKeychain);
  if (google?.deploymentId) {
    // The deployment goes with the project too, so a failure here does not stop the removal.
    try {
      const api = await connectGoogle({ fetch, keychain: googleKeychain, io, open, now });
      token = api.refreshToken;
      await api.deleteDeployment(google.scriptId, google.deploymentId);
      io.print(t('The worker\'s web app on Google is deleted.', 'Web app воркера на Google удалён.'));
    } catch (error) {
      if (!(error instanceof GoogleFailure)) throw error;
      io.print(t(`The worker's web app on Google is not deleted (${error.reason}). It goes with the project.`,
        `Web app воркера на Google не удалён (${error.reason}). Он удалится вместе с проектом.`));
    }
  }
  let ended = true;
  if (token) {
    try {
      await revokeGoogle(fetch, token);
      io.print(t('The aures sign-in to Google is revoked.', 'Вход aures в Google отозван.'));
    } catch (error) {
      if (!(error instanceof GoogleFailure)) throw error;
      ended = false;
    }
  }
  if (google || token) {
    await removeFromKeychain(io, [googleKeychain, secretKeychain], t('The Google sign-in and the worker secret are removed from the Keychain.',
      'Вход в Google и секрет воркера удалены из Связки ключей.'));
  }
  const steps: string[] = [];
  if (google) {
    steps.push(t(`delete the project ${PROJECT_TITLE} on ${projectUrl(google.scriptId)}`,
      `удалите проект ${PROJECT_TITLE} на странице ${projectUrl(google.scriptId)}`));
    // The stopped worker has dropped its authorization itself (doPost uninstall), and the live
    // removal of 2026-10-24 left nothing of it on the connections page; one that did not answer
    // keeps its entry there for the user to take back.
    if (google.url && !stopped) steps.push(t(`take back the access of ${PROJECT_TITLE} on ${CONNECTIONS}`,
      `закройте доступ ${PROJECT_TITLE} на странице ${CONNECTIONS}`));
  }
  if (!ended) steps.push(t(`take back the access of ${GOOGLE_APP} on ${CONNECTIONS}`, `закройте доступ ${GOOGLE_APP} на странице ${CONNECTIONS}`));
  return steps;
}

// Removes these Keychain entries and says so; a locked Keychain is named for the user to clean by hand.
async function removeFromKeychain(io: Printer, entries: Keychain[], done: string): Promise<void> {
  try {
    for (const entry of entries) await entry.remove();
    io.print(done);
  } catch (error) {
    if (!(error instanceof KeychainUnavailable)) throw error;
    io.print(t('The Keychain is unavailable: delete the codex-auto-resets entry in it by hand.', 'Связка ключей недоступна: удалите в ней запись codex-auto-resets вручную.'));
  }
}

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

// `aures uninstall`: removes the worker on both platforms (ADR-0007), wherever it is found. On
// GitHub it revokes the worker session in OpenAI where it can and deletes the worker
// repository; a failed revocation does not stop the removal: the session's tokens go with the
// repository and its key. On Google see removeGoogle. The check from this Mac goes too: its
// agent, its session (revoked where it can be) and files, and the Keychain entries. Last come the
// steps only the user can do, with their links.
export async function uninstall(options: CommandOptions): Promise<number> {
  const { fetch, keychain, io, open, copy, mac, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = options;
  return command('uninstall', io, async () => {
    const install = await mac.files.readInstall();
    const google = install?.google ?? null;
    // GitHub is looked at where a worker may be there: the record names it, there is no record
    // (an install before Google, or another Mac), or the GitHub sign-in is kept (a retired worker,
    // CONTEXT.md «Погашенный воркер»). A locked Keychain may hide that sign-in.
    const onGitHub = install?.platform !== 'google' || await keychain.read().then(Boolean, error => {
      if (error instanceof KeychainUnavailable) return true;
      throw error;
    });
    let github: { api: GitHubApi; repo: Repository } | null = null;
    if (onGitHub) {
      // A worker moved to Google may have left its GitHub sign-in in the Keychain (a locked one
      // hides whether it did); without this line the sign-in below asks for GitHub out of nowhere.
      if (install?.platform === 'google') io.print(t('This Mac may still keep the GitHub sign-in of an earlier worker: aures checks whether its repository is there and offers to delete it with the rest.',
        'На этом Mac мог остаться вход в GitHub от прежнего воркера: aures проверит, есть ли его репозиторий, и предложит удалить его вместе с остальным.'));
      // The token in the Keychain cannot delete repositories; this one is used once and not kept.
      io.print(t('To delete the repository GitHub asks for a separate permission: sign in once more.',
        'Для удаления репозитория GitHub просит отдельное разрешение: войдите ещё раз.'));
      const token = await githubDeviceLogin({ fetch, now, sleep, scopes: UNINSTALL_SCOPES, onCode: showCode(io, open, copy) });
      const api = new GitHubApi({ fetch, token });
      const repo = await api.repository(`${await api.login()}/${WORKER_REPOSITORY}`);
      if (!repo) io.print(t('There is no worker repository.', 'Репозитория воркера нет.'));
      else if (repo.description !== WORKER_DESCRIPTION) {
        io.print(t(`The repository ${repo.html_url} was not created by aures and is left as it is.`,
          `Репозиторий ${repo.html_url} создан не aures, оставлен как есть.`));
      } else github = { api, repo };
    }
    const found = [
      github && t(`the repository ${github.repo.html_url} with all its history`, `репозиторий ${github.repo.html_url} со всей историей`),
      google && t(`the worker on Google (${projectUrl(google.scriptId)}: its schedule, ChatGPT sign-in and web app)`,
        `воркер на Google (${projectUrl(google.scriptId)}: расписание, вход воркера в ChatGPT и web app)`),
    ].filter(Boolean);
    if (found.length) {
      const signIns = onGitHub && google ? t('the GitHub and Google sign-ins', 'входы в GitHub и Google') :
        onGitHub ? t('the GitHub sign-in', 'вход в GitHub') : t('the Google sign-in', 'вход в Google');
      io.print(t(`This deletes ${found.join(', ')}, the check from this Mac and ${signIns} in the Keychain.`,
        `Будут удалены ${found.join(', ')}, проверка с этого Mac и ${signIns} из Связки ключей.`));
      if (!YES.includes((await io.prompt(t('Delete? [y/N] ', 'Удалить? [y/N] '))).trim().toLowerCase())) {
        io.print(t('Cancelled.', 'Отменено.'));
        return 0;
      }
    }
    if (github) {
      await revokeWorkerSession({ ...github, io, now, sleep });
      await github.api.deleteRepository(github.repo.full_name);
      io.print(t('The worker repository is deleted.', 'Репозиторий воркера удалён.'));
    }
    // Before forgetMac, which takes the install record with it: a failure here leaves the record for a repeated uninstall.
    const steps = await removeGoogle({ ...options, now }, google);
    await forgetMac({ mac, fetch, io });
    if (onGitHub) {
      await removeFromKeychain(io, [keychain], t('The GitHub sign-in is removed from the Keychain.', 'Вход в GitHub удалён из Связки ключей.'));
      steps.push(t(`take back the GitHub access with the Revoke button on ${OAUTH_APP}`, `закройте доступ к GitHub кнопкой Revoke на странице ${OAUTH_APP}`));
    }
    if (steps.length === 1) io.print(`${t('Last step', 'Последний шаг')}: ${steps[0]}`);
    else if (steps.length) {
      io.print(t('Left to do by hand:', 'Осталось сделать вручную:'));
      steps.forEach((step, i) => io.print(`  ${i + 1}. ${capitalized(step)}`));
    }
    return 0;
  });
}
