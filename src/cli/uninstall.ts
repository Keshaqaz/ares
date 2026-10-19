import { GitHubApi, githubDeviceLogin, UNINSTALL_SCOPES } from '../github/api.ts';
import { GITHUB_OAUTH_CLIENT_ID } from '../github/oauth-app.ts';
import { FILES, STATE_KEY_SECRET, REVOKE_INPUT } from '../worker/layout.ts';
import { KeychainUnavailable } from './keychain.ts';
import { CommandFailed, YES, WORKER_REPOSITORY, WORKER_DESCRIPTION, WORKFLOW_FILE, showCode, runWorkerNow, command } from './common.ts';
import { forgetMac } from './mac-check.ts';
import type { CommandOptions, Io, Sleep } from './common.ts';
import type { Repository } from '../github/api.ts';
import { t } from './language.ts';

const OAUTH_APP = `https://github.com/settings/connections/applications/${GITHUB_OAUTH_CLIENT_ID}`;

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

// `aures uninstall`: revokes the worker session in OpenAI where it can, deletes
// the worker repository and the GitHub token in the Keychain, and links the page where the
// user takes back the OAuth App's access, which only the user can do. A failed revocation
// does not stop the removal: the session's tokens go with the repository and its key. The
// check from this Mac goes too: its agent, its session (revoked where it can be) and files.
export async function uninstall({ fetch, keychain, io, mac, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }:
  CommandOptions): Promise<number> {
  return command('uninstall', io, async () => {
    // The token in the Keychain cannot delete repositories; this one is used once and not kept.
    io.print(t('To delete the repository GitHub asks for a separate permission: sign in once more.',
      'Для удаления репозитория GitHub просит отдельное разрешение: войдите ещё раз.'));
    const token = await githubDeviceLogin({ fetch, now, sleep, scopes: UNINSTALL_SCOPES, onCode: showCode(io) });
    const api = new GitHubApi({ fetch, token });
    const login = await api.login();
    const repo = await api.repository(`${login}/${WORKER_REPOSITORY}`);
    if (!repo) io.print(t('There is no worker repository.', 'Репозитория воркера нет.'));
    else if (repo.description !== WORKER_DESCRIPTION) {
      io.print(t(`The repository ${repo.html_url} was not created by aures and is left as it is.`,
        `Репозиторий ${repo.html_url} создан не aures, оставлен как есть.`));
    } else {
      io.print(t(`This deletes the repository ${repo.html_url} with all its history, the check from this Mac and the GitHub sign-in in the Keychain.`,
        `Будут удалены репозиторий ${repo.html_url} со всей историей, проверка с этого Mac и вход в GitHub из Связки ключей.`));
      if (!YES.includes((await io.prompt(t('Delete? [y/N] ', 'Удалить? [y/N] '))).trim().toLowerCase())) {
        io.print(t('Cancelled.', 'Отменено.'));
        return 0;
      }
      await revokeWorkerSession({ api, repo, io, now, sleep });
      await api.deleteRepository(repo.full_name);
      io.print(t('The worker repository is deleted.', 'Репозиторий воркера удалён.'));
    }
    await forgetMac({ mac, fetch, io });
    try {
      await keychain.remove();
      io.print(t('The GitHub sign-in is removed from the Keychain.', 'Вход в GitHub удалён из Связки ключей.'));
    } catch (error) {
      if (!(error instanceof KeychainUnavailable)) throw error;
      io.print(t('The Keychain is unavailable: delete the codex-auto-resets entry in it by hand.', 'Связка ключей недоступна: удалите в ней запись codex-auto-resets вручную.'));
    }
    io.print(t(`Last step: take back the GitHub access with the Revoke button on ${OAUTH_APP}`,
      `Последний шаг: закройте доступ к GitHub кнопкой Revoke на странице ${OAUTH_APP}`));
    return 0;
  });
}
