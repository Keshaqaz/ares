import { deviceLogin, revoke } from '../chatgpt/session.mjs';
import { TransientFailure } from '../chatgpt/http.mjs';
import { LaunchctlFailed } from './launch-agent.mjs';
import { showCode } from './common.mjs';
import { t } from './language.mjs';

// The out-of-schedule check from this Mac (ADR-0005): the computer session and the launchd
// agent exist only while the weekly rule is on. mac is { files, agent }: the watch files and
// the LaunchAgent.
export const macLogin = () => t('Sign in to ChatGPT for this Mac: it notices the end of the weekly limit (Codex is not affected).',
  'Вход в ChatGPT для этого Mac: он замечает конец недельного лимита (Codex не затронут).');
const SETUP = '`codex-auto-resets setup`';

// Brings this Mac in line with the weekly rule, as setup and rules leave it.
export async function followWeeklyRule({ weekly, mac, fetch, io, now, sleep }) {
  return weekly ? startChecking({ mac, fetch, io, now, sleep }) : stopChecking({ mac, fetch, io });
}

// Opens a computer session when there is none or it is lost, and (re)loads the agent.
async function startChecking({ mac: { files, agent }, fetch, io, now, sleep }) {
  const [session, state, running] = await Promise.all([files.readSession(), files.readState(), agent.loaded()]);
  const login = !session || state.sessionLost;
  if (login) {
    // No pass may run meanwhile: it would write the lost mark back over the new session.
    await agent.remove();
    io.print(macLogin());
    await files.writeSession(await deviceLogin({ fetch, now, sleep, onCode: showCode(io) }));
    const { sessionLost, ...rest } = await files.readState();
    await files.writeState(rest);
  }
  if (await installAgent({ agent, io }) && (login || !running)) io.print(t('The check from this Mac is on.', 'Внеочередная проверка с этого Mac включена.'));
}

// Loads the agent; a launchctl failure is told to the user and the command goes on. True when it loaded.
async function installAgent({ agent, io }) {
  try { await agent.install(); } catch (error) {
    if (!(error instanceof LaunchctlFailed)) throw error;
    io.print(t(`The check from this Mac did not start (launchctl ${error.message}). Run ${SETUP} again.`,
      `Внеочередная проверка с этого Mac не запустилась (launchctl ${error.message}). Повторите ${SETUP}.`));
    return false;
  }
  return true;
}

// Unloads the agent, revokes the computer session where OpenAI confirms it and deletes it
// either way. forget also deletes watch.json and the log, for uninstall.
async function stopChecking({ mac: { files, agent }, fetch, io, forget = false }) {
  const removed = await agent.remove();
  const session = await files.readSession();
  let unrevoked = null;
  if (session) {
    try { await revoke(fetch, session); } catch (error) {
      if (!(error instanceof TransientFailure)) throw error;
      unrevoked = error.reason;
    }
  }
  if (forget) await Promise.all([files.removeAll(), agent.removeLogFolder()]);
  else await files.removeSession();
  if (!removed && !session) return;
  io.print(!session ? t('The check from this Mac is off.', 'Внеочередная проверка с этого Mac выключена.') : unrevoked === null ?
    t('The check from this Mac is off, its ChatGPT sign-in is revoked.', 'Внеочередная проверка с этого Mac выключена, его вход в ChatGPT отозван.') :
    t(`The check from this Mac is off. The Mac's ChatGPT sign-in is not revoked (${unrevoked}), but it is deleted from this Mac.`,
      `Внеочередная проверка с этого Mac выключена. Вход Mac в ChatGPT не отозван (${unrevoked}), но удалён с этого Mac.`));
}

// `uninstall`: nothing of the check stays on this Mac.
export const forgetMac = ({ mac, fetch, io }) => stopChecking({ mac, fetch, io, forget: true });

// `upgrade`: the agent is reloaded from a plist with this version's program.
export async function reloadAgent({ weekly, mac: { files, agent }, io }) {
  if (weekly && await files.readSession()) await installAgent({ agent, io });
}

// The state of the check from this Mac — working, off or broken — and, when the rule wants it
// and it does not work, the problem: session_lost or not_running. weekly is null when the
// rules do not read.
export async function macCheckStatus({ weekly, mac: { files, agent } }) {
  const [session, state, loaded] = await Promise.all([files.readSession(), files.readState(), agent.loaded()]);
  if (loaded && session && !state.sessionLost) {
    const at = state.lastPass?.at;
    return { state: 'working', lastPassAt: Number.isFinite(at) ? at : null, problem: null };
  }
  if (!weekly) return { state: 'off', lastPassAt: null, problem: null };
  return { state: 'broken', lastPassAt: null, problem: session && state.sessionLost ? 'session_lost' : 'not_running' };
}

// What the user does about a broken check.
export const checkAdvice = problem => problem === 'session_lost' ?
  t(`This Mac's ChatGPT sign-in is lost. Sign in again: ${SETUP}.`, `Вход этого Mac в ChatGPT потерян. Войдите заново: ${SETUP}.`) :
  t(`The check from this Mac is not running. Run ${SETUP}.`, `Внеочередная проверка с этого Mac не запущена. Запустите ${SETUP}.`);
