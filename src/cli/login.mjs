import { randomUUID } from 'node:crypto';
import { deviceLogin } from '../chatgpt/session.mjs';
import { FILES, STATE_KEY_SECRET, LOGIN_SECRET } from '../worker/layout.mjs';
import { CommandFailed, showCode, workingLine, connectGitHub, installedWorker, runnableWorkflow, readSummary, failedRunAdvice,
  runWorkerNow, command } from './common.mjs';

const OTHER_ACCOUNT = 'Вы вошли в другой аккаунт ChatGPT, а воркер установлен для прежнего: новый вход отклонён. ' +
  'Войдите в прежний аккаунт. Чтобы перевести воркер на другой аккаунт, удалите его (`codex-auto-resets uninstall`) ' +
  'и установите заново (`codex-auto-resets setup`).';

// `codex-auto-resets login`: a new worker session after the old one is lost. The CLI cannot
// open the sealed state, so it hands the session to the worker through the login secret; the
// worker takes it in place of the old one, keeping rules and history, and rejects another
// ChatGPT account. The verdict comes back in the open summary.
export async function login({ fetch, keychain, io, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeZone }) {
  return command('login', io, async () => {
    const { api, login: owner } = await connectGitHub({ fetch, keychain, io, now, sleep });
    const repo = await installedWorker({ api, login: owner });
    const name = repo.full_name;
    const [state, workflow, hasKey] = await Promise.all([api.file(name, FILES.state), api.file(name, FILES.workflow),
      api.hasSecret(name, STATE_KEY_SECRET)]);
    if (!state || !hasKey || !workflow) {
      throw new CommandFailed('Установка воркера не завершена. Запустите `codex-auto-resets setup`: он войдёт в ChatGPT сам.');
    }
    if (!workflow.text.includes(LOGIN_SECRET)) {
      throw new CommandFailed('Воркер в репозитории старше этой версии и не принимает новый вход. ' +
        'Обновите его: `codex-auto-resets upgrade`, затем повторите login.');
    }
    await runnableWorkflow(api, repo);

    io.print('Вход в ChatGPT для сессии воркера (она отдельна от Codex на этом компьютере).');
    const session = await deviceLogin({ fetch, now, sleep, onCode: showCode(io) });
    const id = randomUUID();
    await api.putSecret(name, LOGIN_SECRET, JSON.stringify({ id, session }));
    io.print('Запуск воркера с новой сессией…');
    // The secret goes even when the run is not seen through: a rejected session is another
    // account's live one, and a stale secret would bring back rotated tokens over a newer state.
    let run, logged;
    try { ({ run, logged } = await runWorkerNow({ api, repo, inputs: {}, now, sleep })); } finally {
      await api.deleteSecret(name, LOGIN_SECRET).catch(() => {});
    }
    const summary = await readSummary(api, repo);
    const verdict = summary?.login?.id === id ? summary.login.result : null;
    if (verdict === 'rejected') throw new CommandFailed(OTHER_ACCOUNT);
    if (verdict !== 'accepted' || run.conclusion !== 'success') {
      throw new CommandFailed(`${run.conclusion === 'success' ? 'Воркер не принял новый вход.' : failedRunAdvice(logged ?? {})}\n` +
        `Запуск: ${run.html_url}`);
    }
    io.print('Новый вход принят: правила и история сохранены.');
    io.print(logged?.outcome === 'transient_error' ? 'Сбросы воркер прочитает на следующем запуске: ChatGPT временно недоступен.' :
      workingLine(summary, timeZone));
    return 0;
  });
}
