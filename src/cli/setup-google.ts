// `aures setup` on Google Apps Script (ADR-0007): the Google sign-in, the deploy, the script's
// consent, then everything else through doPost with the secret: the rules, the ChatGPT sign-in,
// the schedule and the trial run. The install record keeps the project from the moment it
// exists, so a repeated or interrupted setup goes on in the same project and adds only what is
// missing.
import { randomUUID } from 'node:crypto';
import { deviceLogin, sessionEmail } from '../chatgpt/session.ts';
import type { Summary } from '../worker/summary.ts';
import type { WouldApply } from '../worker/tick.ts';
import { GoogleFailure } from '../google/api.ts';
import { connectGoogle, deployWorker, askWorker, workerDid, brokenOnGoogle, readSecret } from './google.ts';
import type { WorkerReply, WorkerDeployment } from './google.ts';
import { CommandFailed, chatgptLogin, showCode, chooseRules, failedRunAdvice, workingLine, trialVerdict, notReadYet } from './common.ts';
import type { Io, Sleep } from './common.ts';
import { KeychainUnavailable } from './keychain.ts';
import type { Keychain } from './keychain.ts';
import type { SetupOptions } from './setup.ts';
import type { GoogleWorker } from './watch-files.ts';
import type { RunOutcome } from '../worker/run.ts';
import { t } from './language.ts';

// Until the script answers as authorized the CLI asks again this often.
const CONSENT_POLL_MS = 5_000;
const COMMAND = 'setup';

// Both «unverified app» screens, told before the first of them: the CLI's sign-in and the script's consent.
const warnings = (): string[] => [
  t('Google will show «Google hasn\'t verified this app» twice: when aures signs in to Google and when you let the worker script run. ' +
    'Both the app and the script are yours, Google has just not reviewed them.',
  'Google дважды покажет «Google не проверял это приложение»: при входе aures в Google и когда вы разрешите скрипту воркера работать. ' +
    'И приложение, и скрипт ваши, Google их просто не проверял.'),
  t('To go on, click «Advanced», then «Go to … (unsafe)».', 'Чтобы пройти, нажмите «Дополнительные настройки», затем «Перейти… (небезопасно)».'),
];

// What the trial run tells, by the reply of doPost trial.
export interface Trial { outcome: RunOutcome; reason?: string; wouldApply: WouldApply | null; summary: Summary | null }
export function trialLine({ outcome, reason, wouldApply, summary }: Trial, timeZone: string | undefined): string {
  if (outcome === 'broken_state') {
    throw new CommandFailed(brokenOnGoogle(reason));
  }
  if (outcome === 'reauth_required') throw new CommandFailed(failedRunAdvice({ outcome }));
  const verdict = trialVerdict({ outcome, wouldApply: wouldApply ?? undefined });
  if (summary && outcome !== 'transient_error') return [workingLine(summary, timeZone), verdict].filter(Boolean).join(' ');
  return notReadYet(outcome === 'transient_error');
}

export async function setupGoogle({ fetch, io, mac: { files }, open, googleKeychain, secretKeychain, appsScriptSource, now, sleep, timeZone,
  paused }: SetupOptions & { now: () => number; sleep: Sleep; paused: boolean }): Promise<number> {
  // The record keeps a pause through the repair: the schedule is not brought back and the
  // passes from this Mac keep not waking the worker.
  // The accounts the sign-ins named stay with it.
  const remember = async (google: GoogleWorker) => {
    const accounts = (await files.readInstall())?.accounts;
    await files.writeInstall({ platform: 'google', google, ...paused ? { paused: true } : {}, ...accounts ? { accounts } : {} });
  };
  let google = (await files.readInstall())?.google ?? null;
  let secret = await readSecret(secretKeychain);
  const ask = (action: string, extra?: Record<string, unknown>) => {
    if (!google?.url || !secret) throw new Error('the worker is not deployed');
    return askWorker({ fetch, url: google.url, secret }, action, extra);
  };

  // A deployed worker answers to the secret in the Keychain; one that does not know it gets a new
  // one. A deployment the user deleted is made anew in the same project, under another URL.
  const known = Boolean(google?.url && google.deploymentId && secret);
  let status: WorkerReply | null = null, deployed = known;
  if (known) {
    try {
      status = await ask('status');
      deployed = status?.error !== 'forbidden';
    } catch (error) {
      if (!(error instanceof GoogleFailure && error.reason === 'web_app_404' && google)) throw error;
      google = { scriptId: google.scriptId };
      deployed = false;
    }
  }
  if (!deployed || status === null) for (const line of warnings()) io.print(line);
  if (!deployed) {
    const api = await connectGoogle({ fetch, keychain: googleKeychain, io, open, now, files });
    const deploy = (deployment: GoogleWorker | null) => deployWorker({ api, secretKeychain, io, open, sleep, workerSource: appsScriptSource,
      deployment, onProject: scriptId => remember(google = { scriptId }) });
    let result: WorkerDeployment;
    try { result = await deploy(google); } catch (error) {
      // The user deleted the project: the worker starts over in a new one.
      if (!(error instanceof GoogleFailure && error.reason === 'update_content_404' && google)) throw error;
      io.print(t('The worker project is gone from Google, creating a new one.', 'Проекта воркера в Google больше нет, создаём новый.'));
      result = await deploy(google = null);
    }
    await remember(google = result);
    secret = await readSecret(secretKeychain);
    io.print(t(`The worker is deployed: ${result.url}`, `Воркер развёрнут: ${result.url}`));
    status = await ask('status');
  } else io.print(t(`The worker is deployed: ${google?.url}`, `Воркер развёрнут: ${google?.url}`));

  if (status === null) status = await consent({ io, open, sleep, url: google?.url ?? '', ask });
  status = workerDid(status, COMMAND);

  if (!status.rules) {
    const chosen = await chooseRules(io, undefined, 'google');
    workerDid(await ask('rules', { rules: { beforeExpiry: chosen.beforeExpiry, weeklyAutoApply: chosen.weeklyAutoApply } }), COMMAND);
  }
  // Without a session the worker has no summary.
  if (status.summary) io.print(t('The ChatGPT sign-in is already there.', 'Вход в ChatGPT уже есть.'));
  else {
    io.print(chatgptLogin());
    const session = await deviceLogin({ fetch, now, sleep, onCode: showCode(io) });
    const id = randomUUID();
    const taken = workerDid(await ask('login', { login: { id, session } }), COMMAND);
    if ((taken.summary as Summary | null)?.login?.id !== id) {
      throw new CommandFailed(t(`The worker did not take the ChatGPT sign-in (${taken.outcome}${taken.reason ? `: ${taken.reason}` : ''}).`,
        `Воркер не принял вход в ChatGPT (${taken.outcome}${taken.reason ? `: ${taken.reason}` : ''}).`));
    }
    await files.rememberAccount('chatgpt', sessionEmail(session));
  }
  if (status.schedule !== true) {
    if (paused) io.print(t('The worker stays paused: its schedule stays off.', 'Воркер остаётся на паузе: расписание остаётся снятым.'));
    else {
      workerDid(await ask('schedule', { on: true }), COMMAND);
      io.print(t('The worker runs every 5 minutes.', 'Воркер запускается каждые 5 минут.'));
    }
  }
  io.print(t('Checking the worker…', 'Проверяем воркер…'));
  io.print(trialLine(workerDid(await ask('trial'), COMMAND) as unknown as Trial, timeZone));
  return 0;
}

// Opens the web app for the owner to let the script run, and waits until it answers as authorized.
async function consent({ io, open, sleep, url, ask }:
  { io: Io; open: (url: string) => Promise<void>; sleep: Sleep; url: string; ask: (action: string) => Promise<WorkerReply | null> }):
  Promise<WorkerReply> {
  io.print(t(`Let the worker script run: ${url}`, `Разрешите скрипту воркера работать: ${url}`));
  io.print(t('Pick your account, pass «Google hasn\'t verified this app» through «Advanced» and click «Allow». aures goes on by itself.',
    'Выберите свой аккаунт, пройдите «Google не проверял это приложение» через «Дополнительные настройки» и нажмите «Разрешить». ' +
      'aures продолжит сам.'));
  await open(url);
  io.wait(t('Waiting for the script to be allowed…', 'Ждём, когда скрипту разрешат работать…'));
  try {
    for (;;) {
      const status = await ask('status');
      if (status) return status;
      await sleep(CONSENT_POLL_MS);
    }
  } finally { io.wait(null); }
}
