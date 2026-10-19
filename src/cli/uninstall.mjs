import { GitHubApi, githubDeviceLogin, UNINSTALL_SCOPES } from '../github/api.mjs';
import { GITHUB_OAUTH_CLIENT_ID } from '../github/oauth-app.mjs';
import { FILES, STATE_KEY_SECRET, REVOKE_INPUT } from '../worker/layout.mjs';
import { KeychainUnavailable } from './keychain.mjs';
import { CommandFailed, YES, WORKER_REPOSITORY, WORKER_DESCRIPTION, WORKFLOW_FILE, showCode, runWorkerNow, command } from './common.mjs';
import { forgetMac } from './mac-check.mjs';

const OAUTH_APP = `https://github.com/settings/connections/applications/${GITHUB_OAUTH_CLIENT_ID}`;

// Has the worker revoke its session and tells the user how it went. Whatever happens, the
// removal goes on.
async function revokeWorkerSession({ api, repo, io, now, sleep }) {
  const reason = await revoke({ api, repo, io, now, sleep });
  if (reason === null) io.print('Вход воркера в ChatGPT отозван.');
  else if (reason) io.print(`Вход воркера в ChatGPT не отозван: ${reason}. Он удалится вместе с репозиторием.`);
}

// Why the worker session was not revoked: null when it was, false when there is none.
async function revoke({ api, repo, io, now, sleep }) {
  const name = repo.full_name;
  const [state, workflow, hasKey] = await Promise.all([api.file(name, FILES.state), api.file(name, FILES.workflow),
    api.hasSecret(name, STATE_KEY_SECRET)]);
  // An interrupted setup may have left no session to revoke.
  if (!state || !hasKey) return false;
  if (!workflow) return 'установка не завершена';
  if (!workflow.text.includes(REVOKE_INPUT)) return 'воркер устарел';
  if (await api.workflowState(name, WORKFLOW_FILE) !== 'active') return 'воркер выключен в GitHub';
  io.print('Отзываем вход воркера в ChatGPT…');
  let run, logged;
  try { ({ run, logged } = await runWorkerNow({ api, repo, inputs: { [REVOKE_INPUT]: 'true' }, now, sleep })); } catch (error) {
    if (!(error instanceof CommandFailed)) throw error;
    return error.message.replace(/\.$/, '');
  }
  if (logged?.outcome === 'revoked') return null;
  if (logged?.outcome === 'revoke_failed') return `ChatGPT не подтвердил отзыв (${logged.reason})`;
  if (logged?.outcome === 'broken_state') return `файл со входом не читается (${logged.reason})`;
  return `воркер завершился с ошибкой: ${run.html_url}`;
}

// `codex-auto-resets uninstall`: revokes the worker session in OpenAI where it can, deletes
// the worker repository and the GitHub token in the Keychain, and links the page where the
// user takes back the OAuth App's access, which only the user can do. A failed revocation
// does not stop the removal: the session's tokens go with the repository and its key. The
// check from this Mac goes too: its agent, its session (revoked where it can be) and files.
export async function uninstall({ fetch, keychain, io, mac, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  return command('uninstall', io, async () => {
    // The token in the Keychain cannot delete repositories; this one is used once and not kept.
    io.print('Для удаления репозитория GitHub просит отдельное разрешение: войдите ещё раз.');
    const token = await githubDeviceLogin({ fetch, now, sleep, scopes: UNINSTALL_SCOPES, onCode: showCode(io) });
    const api = new GitHubApi({ fetch, token });
    const login = await api.login();
    const repo = await api.repository(`${login}/${WORKER_REPOSITORY}`);
    if (!repo) io.print('Репозитория воркера нет.');
    else if (repo.description !== WORKER_DESCRIPTION) io.print(`Репозиторий ${repo.html_url} создан не codex-auto-resets, оставлен как есть.`);
    else {
      io.print(`Будут удалены репозиторий ${repo.html_url} со всей историей и вход в GitHub из Связки ключей.`);
      if (!YES.includes((await io.prompt('Удалить? [y/N] ')).trim().toLowerCase())) {
        io.print('Отменено.');
        return 0;
      }
      await revokeWorkerSession({ api, repo, io, now, sleep });
      await api.deleteRepository(repo.full_name);
      io.print('Репозиторий воркера удалён.');
    }
    await forgetMac({ mac, fetch, io });
    try {
      await keychain.remove();
      io.print('Вход в GitHub удалён из Связки ключей.');
    } catch (error) {
      if (!(error instanceof KeychainUnavailable)) throw error;
      io.print('Связка ключей недоступна: удалите в ней запись codex-auto-resets вручную.');
    }
    io.print(`Последний шаг: закройте доступ к GitHub кнопкой Revoke на странице ${OAUTH_APP}`);
    return 0;
  });
}
