import { GitHubApi, githubDeviceLogin, UNINSTALL_SCOPES } from '../github/api.mjs';
import { GITHUB_OAUTH_CLIENT_ID } from '../github/oauth-app.mjs';
import { FILES, STATE_KEY_SECRET, REVOKE_INPUT } from '../worker/layout.mjs';
import { KeychainUnavailable } from './keychain.mjs';
import { CommandFailed, WORKER_REPOSITORY, WORKER_DESCRIPTION, WORKFLOW_FILE, showCode, runWorkerNow, command } from './common.mjs';

const OAUTH_APP = `https://github.com/settings/connections/applications/${GITHUB_OAUTH_CLIENT_ID}`;

// Has the worker revoke its session and tells the user how it went. Whatever happens, the
// removal goes on.
async function revokeWorkerSession({ api, repo, io, now, sleep }) {
  const reason = await revoke({ api, repo, io, now, sleep });
  if (reason === null) io.print('Сессия воркера в OpenAI отозвана.');
  else if (reason) io.print(`Сессия воркера в OpenAI не отозвана: ${reason}. Её токены удаляются вместе с репозиторием.`);
}

// Why the worker session was not revoked: null when it was, false when there is none.
async function revoke({ api, repo, io, now, sleep }) {
  const name = repo.full_name;
  const [state, workflow, hasKey] = await Promise.all([api.file(name, FILES.state), api.file(name, FILES.workflow),
    api.hasSecret(name, STATE_KEY_SECRET)]);
  // An interrupted setup may have left no session to revoke.
  if (!state || !hasKey) return false;
  if (!workflow) return 'в репозитории нет workflow воркера';
  if (!workflow.text.includes(REVOKE_INPUT)) return 'воркер в репозитории старой версии и не умеет её отзывать';
  if (await api.workflowState(name, WORKFLOW_FILE) !== 'active') return 'workflow воркера отключён в GitHub';
  io.print('Отзыв сессии воркера в OpenAI…');
  let run, logged;
  try { ({ run, logged } = await runWorkerNow({ api, repo, inputs: { [REVOKE_INPUT]: 'true' }, now, sleep })); } catch (error) {
    if (!(error instanceof CommandFailed)) throw error;
    return error.message.replace(/\.$/, '');
  }
  if (logged?.outcome === 'revoked') return null;
  if (logged?.outcome === 'revoke_failed') return `OpenAI не подтвердил отзыв (${logged.reason})`;
  if (logged?.outcome === 'broken_state') return `воркер не смог открыть файл с сессией (${logged.reason})`;
  return `запуск воркера завершился ошибкой: ${run.html_url}`;
}

// `codex-auto-resets uninstall`: revokes the worker session in OpenAI where it can, deletes
// the worker repository and the GitHub token in the Keychain, and links the page where the
// user takes back the OAuth App's access, which only the user can do. A failed revocation
// does not stop the removal: the session's tokens go with the repository and its key.
export async function uninstall({ fetch, keychain, io, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  return command('uninstall', io, async () => {
    // The token in the Keychain cannot delete repositories; this one is used once and not kept.
    io.print('GitHub даёт удалить репозиторий только с отдельным разрешением: войдите в GitHub ещё раз.');
    const token = await githubDeviceLogin({ fetch, now, sleep, scopes: UNINSTALL_SCOPES, onCode: showCode(io) });
    const api = new GitHubApi({ fetch, token });
    const login = await api.login();
    const repo = await api.repository(`${login}/${WORKER_REPOSITORY}`);
    if (!repo) io.print('Репозитория воркера нет.');
    else if (repo.description !== WORKER_DESCRIPTION) io.print(`Репозиторий ${repo.html_url} создан не codex-auto-resets и не удалён.`);
    else {
      io.print(`Будут удалены репозиторий воркера ${repo.html_url} со всей историей и токен GitHub в Keychain.`);
      if ((await io.prompt('Удалить? y — да, Enter — отмена: ')).trim().toLowerCase() !== 'y') {
        io.print('Отменено.');
        return 0;
      }
      await revokeWorkerSession({ api, repo, io, now, sleep });
      await api.deleteRepository(repo.full_name);
      io.print('Репозиторий воркера удалён.');
    }
    try {
      await keychain.remove();
      io.print('Токен GitHub удалён из Keychain.');
    } catch (error) {
      if (!(error instanceof KeychainUnavailable)) throw error;
      io.print('Keychain недоступен: удалите вручную запись codex-auto-resets в приложении «Связка ключей».');
    }
    io.print(`Чтобы закрыть доступ codex-auto-resets к GitHub, нажмите Revoke на странице ${OAUTH_APP}`);
    return 0;
  });
}
