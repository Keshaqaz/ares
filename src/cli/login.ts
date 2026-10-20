import { randomUUID } from 'node:crypto';
import { deviceLogin } from '../chatgpt/session.ts';
import { FILES, STATE_KEY_SECRET, LOGIN_SECRET } from '../worker/layout.ts';
import { CommandFailed, RunNotStarted, unfinished, chatgptLogin, showCode, workingLine, runnableWorkflow, readSummary, failedRunAdvice,
  runWorkerNow, command } from './common.ts';
import type { CommandOptions, Io, Sleep } from './common.ts';
import { openWorker } from './active-worker.ts';
import type { GitHubWorker, GoogleWorker } from './active-worker.ts';
import { brokenOnGoogle } from './google.ts';
import type { Fetch } from '../chatgpt/http.ts';
import type { Summary } from '../worker/summary.ts';
import { t } from './language.ts';

const otherAccount = (): string => t('This is another ChatGPT account, the sign-in is rejected. Sign in to the one the worker was set up for. ' +
  'To change the account, reinstall the worker: `aures uninstall`, then `aures setup`.',
'Это другой аккаунт ChatGPT, вход отклонён. Войдите в тот, для которого установлен воркер. ' +
  'Чтобы сменить аккаунт, переустановите воркер: `aures uninstall`, затем `aures setup`.');

const renewed = (): string => t('The sign-in is renewed, the rules and history are in place.', 'Вход обновлён, правила и история на месте.');
const unavailable = (): string => t('ChatGPT is temporarily unavailable: the resets will be read on the next run.',
  'ChatGPT временно недоступен: сбросы прочитаются при следующем запуске.');

// `aures login`: a new worker session after the old one is lost. The worker takes it in place
// of the old one, keeping rules and history, and rejects another ChatGPT account.
export async function login(options: CommandOptions): Promise<number> {
  const { fetch, io, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeZone } = options;
  return command('login', io, async () => {
    const worker = await openWorker(options, 'login');
    const loggingIn = { fetch, io, now, sleep, timeZone };
    return worker.platform === 'google' ? loginGoogle(worker, loggingIn) : loginGitHub(worker, loggingIn);
  });
}
interface LoggingIn { fetch: Fetch; io: Io; now: () => number; sleep: Sleep; timeZone: string | undefined }

// On Google the session goes to the worker in doPost login, and the verdict comes back in its reply.
async function loginGoogle(worker: GoogleWorker, { fetch, io, now, sleep, timeZone }: LoggingIn): Promise<number> {
  io.print(chatgptLogin());
  const session = await deviceLogin({ fetch, now, sleep, onCode: showCode(io) });
  const id = randomUUID();
  io.wait(t('Handing the sign-in to the worker…', 'Передаём вход воркеру…'));
  const reply = await worker.ask('login', { login: { id, session } }).finally(() => io.wait(null));
  const summary = reply.summary as Summary | null;
  const verdict = summary?.login?.id === id ? summary.login.result : null;
  if (verdict === 'rejected') throw new CommandFailed(otherAccount());
  if (verdict !== 'accepted' || !summary) {
    throw new CommandFailed(reply.outcome === 'broken_state' ? brokenOnGoogle(reply.reason) :
      t('The worker did not take the new sign-in.', 'Воркер не принял новый вход.'));
  }
  io.print(renewed());
  io.print(reply.outcome === 'transient_error' ? unavailable() : workingLine(summary, timeZone));
  return 0;
}

// On GitHub the CLI cannot open the sealed state, so it hands the session to the worker through
// the login secret. The verdict comes back in the open summary.
async function loginGitHub({ api, repo }: GitHubWorker, { fetch, io, now, sleep, timeZone }: LoggingIn): Promise<number> {
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
  io.print(renewed());
  io.print(logged?.outcome === 'transient_error' ? unavailable() : workingLine(summary, timeZone));
  return 0;
}
