import { randomUUID } from 'node:crypto';
import { deviceLogin } from '../chatgpt/session.ts';
import { FILES, STATE_KEY_SECRET, LOGIN_SECRET } from '../worker/layout.ts';
import { CommandFailed, RunNotStarted, unfinished, chatgptLogin, showCode, workingLine, connectGitHub, installedWorker, runnableWorkflow, readSummary, failedRunAdvice,
  runWorkerNow, command } from './common.ts';
import type { CommandOptions } from './common.ts';
import { t } from './language.ts';

const otherAccount = (): string => t('This is another ChatGPT account, the sign-in is rejected. Sign in to the one the worker was set up for. ' +
  'To change the account, reinstall the worker: `aures uninstall`, then `aures setup`.',
'Это другой аккаунт ChatGPT, вход отклонён. Войдите в тот, для которого установлен воркер. ' +
  'Чтобы сменить аккаунт, переустановите воркер: `aures uninstall`, затем `aures setup`.');

// `aures login`: a new worker session after the old one is lost. The CLI cannot
// open the sealed state, so it hands the session to the worker through the login secret; the
// worker takes it in place of the old one, keeping rules and history, and rejects another
// ChatGPT account. The verdict comes back in the open summary.
export async function login({ fetch, keychain, io, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeZone }: CommandOptions): Promise<number> {
  return command('login', io, async () => {
    const { api, login: owner } = await connectGitHub({ fetch, keychain, io, now, sleep });
    const repo = await installedWorker({ api, login: owner });
    const name = repo.full_name;
    const [state, workflow, hasKey] = await Promise.all([api.file(name, FILES.state), api.file(name, FILES.workflow),
      api.hasSecret(name, STATE_KEY_SECRET)]);
    if (!state || !hasKey || !workflow) {
      throw new CommandFailed(unfinished());
    }
    if (!workflow.text.includes(LOGIN_SECRET)) {
      throw new CommandFailed(t('The worker is out of date. Update it: `aures upgrade`, then run login again.',
        'Воркер устарел. Обновите его: `aures upgrade`, затем повторите login.'));
    }
    await runnableWorkflow(api, repo);

    io.print(chatgptLogin());
    const session = await deviceLogin({ fetch, now, sleep, onCode: showCode(io) });
    const id = randomUUID();
    await api.putSecret(name, LOGIN_SECRET, JSON.stringify({ id, session }));
    io.print(t('Handing the sign-in to the worker…', 'Передаём вход воркеру…'));
    // The secret goes even when the run is not seen through: a rejected session is another
    // account's live one, and a stale secret would bring back rotated tokens over a newer state.
    let run, logged;
    try { ({ run, logged } = await runWorkerNow({ api, repo, inputs: {}, now, sleep, wait: io.wait })); } catch (error) {
      // A run that starts after the secret is gone runs without the new sign-in.
      if (!(error instanceof RunNotStarted)) throw error;
      throw new CommandFailed(t('The worker has been waiting to start on GitHub for over 10 minutes, the new sign-in has not been passed to it. ' +
        'Run `aures login` again.', 'Воркер ждёт запуска на GitHub дольше 10 минут, новый вход ему не передан. Повторите `aures login`.'));
    } finally {
      await api.deleteSecret(name, LOGIN_SECRET).catch(() => {});
    }
    const summary = await readSummary(api, repo);
    const verdict = summary?.login?.id === id ? summary.login.result : null;
    if (verdict === 'rejected') throw new CommandFailed(otherAccount());
    if (verdict !== 'accepted' || !summary || run.conclusion !== 'success') {
      throw new CommandFailed(`${run.conclusion === 'success' ? t('The worker did not take the new sign-in.', 'Воркер не принял новый вход.') :
        failedRunAdvice(logged ?? {})}\n${t('Details', 'Подробности')}: ${run.html_url}`);
    }
    io.print(t('The sign-in is renewed, the rules and history are in place.', 'Вход обновлён, правила и история на месте.'));
    io.print(logged?.outcome === 'transient_error' ? t('ChatGPT is temporarily unavailable: the resets will be read on the next run.',
      'ChatGPT временно недоступен: сбросы прочитаются при следующем запуске.') :
      workingLine(summary, timeZone));
    return 0;
  });
}
