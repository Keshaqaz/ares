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
import { connectGoogle, deployWorker, askWorker, askAfterDeploy, workerDid, brokenOnGoogle, readSecret } from './google.ts';
import type { WorkerReply, WorkerDeployment } from './google.ts';
import { CommandFailed, chatgptLogin, showCode, ruleLabel, failedRunAdvice, workingLine, trialVerdict, notReadYet } from './common.ts';
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

// Both «unverified app» screens, told shortly before the first of them: the CLI's sign-in and
// the script's consent. What to press is told at each screen as it comes.
const warnings = (): string[] => [
  t('Google will show two «unverified app» warnings: when aures signs in to Google and when you let the worker script run. ' +
    'Both the app and the script are yours, Google has just not reviewed them.',
  'Google покажет два предупреждения о непроверенном приложении: при входе aures в Google и когда вы разрешите скрипту воркера работать. ' +
    'И приложение, и скрипт ваши, Google их просто не проверял.'),
];

// The rule names as the screen prints them, only starting a sentence: «перед истечением…».
const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

// What a script whose consent was given without every box tells the user (issue 29): the consent
// opens again, and this time both boxes have to be ticked.
const scopesHint = (): string => t(
  'The worker script was not given every access: not every box of its consent was ticked. ' +
    'aures opens the consent again — tick both boxes (or «Select all») and click «Continue».',
  'Скрипту воркера выданы не все доступы: на согласии отмечены не все галочки. ' +
    'aures откроет согласие ещё раз — отметьте обе галочки (или «Выбрать все») и нажмите «Продолжить».');

// The one line setup on Google prints about the rules it has just written without a question
// (issue 24): both on — the weekly rule needs no Mac check here, the worker watches the limit
// itself — told in the same names as chooseRules and the `aures` screen, with where to change.
const rulesLine = (): string => {
  const [beforeExpiry, weekly] = [ruleLabel('beforeExpiry', 'google'), ruleLabel('weeklyAutoApply')].map(lowerFirst);
  return t(`Rules: ${beforeExpiry} — on, ${weekly} — on. To change: \`aures rules\` or the \`aures\` screen.`,
    `Правила: ${beforeExpiry} — вкл., ${weekly} — вкл. Изменить: \`aures rules\` или экран \`aures\`.`);
};

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

export async function setupGoogle({ fetch, io, mac: { files }, open, copy, googleKeychain, secretKeychain, appsScriptSource, now, sleep, timeZone,
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
  // Asks the worker; a reply that the script was not given every scope (issue 29) has the user
  // redo the consent — the same wait as for a script not allowed at all — and asks again.
  const asking = async (action: string, extra?: Record<string, unknown>): Promise<WorkerReply> => {
    for (;;) {
      const reply = await ask(action, extra);
      if (!reply || reply.error !== 'scopes') return workerDid(reply, COMMAND);
      await consent({ io, open, sleep, url: google?.url ?? '', ask, again: true });
    }
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
    if (!secret) throw new Error('the worker is not deployed');
    io.print(t(`The worker is deployed: ${result.url}`, `Воркер развёрнут: ${result.url}`));
    // The live web app can still serve the previous version for a few seconds, answering
    // forbidden to the fresh secret; askAfterDeploy waits that out.
    status = await askAfterDeploy({ fetch, url: result.url, secret, now, sleep, io, command: COMMAND });
  } else io.print(t(`The worker is deployed: ${google?.url}`, `Воркер развёрнут: ${google?.url}`));

  // A script not allowed yet, or one whose consent lacks a scope (issue 29), goes through the
  // consent; in the latter case its hint says why it opens again.
  if (status === null || status.error === 'scopes') {
    status = await consent({ io, open, sleep, url: google?.url ?? '', ask, again: status?.error === 'scopes' });
  }
  status = workerDid(status, COMMAND);

  if (!status.rules) {
    workerDid(await ask('rules', { rules: { beforeExpiry: true, weeklyAutoApply: true } }), COMMAND);
    io.print(rulesLine());
  }
  // Without a session the worker has no summary.
  if (status.summary) io.print(t('The ChatGPT sign-in is already there.', 'Вход в ChatGPT уже есть.'));
  else {
    io.print(chatgptLogin());
    const session = await deviceLogin({ fetch, now, sleep, onCode: showCode(io, open, copy) });
    const id = randomUUID();
    const taken = await asking('login', { login: { id, session } });
    if ((taken.summary as Summary | null)?.login?.id !== id) {
      throw new CommandFailed(t(`The worker did not take the ChatGPT sign-in (${taken.outcome}${taken.reason ? `: ${taken.reason}` : ''}).`,
        `Воркер не принял вход в ChatGPT (${taken.outcome}${taken.reason ? `: ${taken.reason}` : ''}).`));
    }
    await files.rememberAccount('chatgpt', sessionEmail(session));
  }
  if (status.schedule !== true) {
    if (paused) io.print(t('The worker stays paused: its schedule stays off.', 'Воркер остаётся на паузе: расписание остаётся снятым.'));
    else {
      await asking('schedule', { on: true });
      io.print(t('The worker runs every 5 minutes.', 'Воркер запускается каждые 5 минут.'));
    }
  }
  io.print(t('Checking the worker…', 'Проверяем воркер…'));
  io.print(trialLine(await asking('trial') as unknown as Trial, timeZone));
  return 0;
}

// Opens the web app for the owner to let the script run, and waits until it answers as authorized
// with every scope. A consent with a box left unticked (issue 29) answers 'scopes': the hint says
// what was missed and the consent opens again — once, for the answer may be the one given just
// before; after that the wait goes on, with the URL and the hint already told. again tells that
// this call follows such an answer, so the hint comes first and there is no second opening.
async function consent({ io, open, sleep, url, ask, again = false }:
  { io: Io; open: (url: string) => Promise<void>; sleep: Sleep; url: string; ask: (action: string) => Promise<WorkerReply | null>;
    again?: boolean }): Promise<WorkerReply> {
  for (;;) {
    if (again) io.print(scopesHint());
    io.print(t(`Let the worker script run: ${url}`, `Разрешите скрипту воркера работать: ${url}`));
    io.print(t('The page that opens is in English, «aures-worker (Unverified)»: click «Review permissions», and the consent opens in a popup window.',
      'Открывшаяся страница будет на английском, «aures-worker (Unverified)»: нажмите «Review permissions», согласие откроется во всплывающем окне.'));
    io.print(t('In the window pick the same account, click «Advanced» and then «Go to aures-worker (unsafe)», tick both boxes (or «Select all») ' +
      'and click «Continue». aures goes on by itself.',
    'В окне выберите тот же аккаунт, нажмите «Дополнительные настройки» и «Перейти на страницу "aures-worker" (небезопасно)», ' +
      'отметьте обе галочки (или «Выбрать все») и нажмите «Продолжить». aures продолжит сам.'));
    await open(url);
    io.wait(t('Waiting for the script to be allowed…', 'Ждём, когда скрипту разрешат работать…'));
    try {
      for (;;) {
        const status = await ask('status');
        if (status && status.error !== 'scopes') return status;
        // A consent without every box: the consent opens again, with the hint before it.
        if (status && !again) { again = true; break; }
        await sleep(CONSENT_POLL_MS);
      }
    } finally { io.wait(null); }
  }
}
