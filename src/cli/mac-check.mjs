import { deviceLogin, revoke } from '../chatgpt/session.mjs';
import { TransientFailure } from '../chatgpt/http.mjs';
import { LaunchctlFailed } from './launch-agent.mjs';
import { showCode, formatTime } from './common.mjs';

// The out-of-schedule check from this Mac (ADR-0005): the computer session and the launchd
// agent exist only while the weekly rule is on. mac is { files, agent }: the watch files and
// the LaunchAgent.
export const MAC_LOGIN = 'Вход в ChatGPT для этого Mac: он замечает конец недельного лимита (Codex не затронут).';
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
    io.print(MAC_LOGIN);
    await files.writeSession(await deviceLogin({ fetch, now, sleep, onCode: showCode(io) }));
    const { sessionLost, ...rest } = await files.readState();
    await files.writeState(rest);
  }
  if (await installAgent({ agent, io }) && (login || !running)) io.print('Внеочередная проверка с этого Mac включена.');
}

// Loads the agent; a launchctl failure is told to the user and the command goes on. True when it loaded.
async function installAgent({ agent, io }) {
  try { await agent.install(); } catch (error) {
    if (!(error instanceof LaunchctlFailed)) throw error;
    io.print(`Внеочередная проверка с этого Mac не запустилась (launchctl ${error.message}). Повторите ${SETUP}.`);
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
  io.print(!session ? 'Внеочередная проверка с этого Mac выключена.' : unrevoked === null ?
    'Внеочередная проверка с этого Mac выключена, его вход в ChatGPT отозван.' :
    `Внеочередная проверка с этого Mac выключена. Вход Mac в ChatGPT не отозван (${unrevoked}), но удалён с этого Mac.`);
}

// `uninstall`: nothing of the check stays on this Mac.
export const forgetMac = ({ mac, fetch, io }) => stopChecking({ mac, fetch, io, forget: true });

// `upgrade`: the agent is reloaded from a plist with this version's program.
export async function reloadAgent({ weekly, mac: { files, agent }, io }) {
  if (weekly && await files.readSession()) await installAgent({ agent, io });
}

// The status line about the check from this Mac and a warning when the rule wants it and it
// does not work. weekly is null when the rules do not read.
export async function macCheckStatus({ weekly, mac: { files, agent }, timeZone }) {
  const [session, state, loaded] = await Promise.all([files.readSession(), files.readState(), agent.loaded()]);
  const working = loaded && session && !state.sessionLost;
  const label = 'Внеочередная проверка с этого Mac:';
  if (working) {
    const at = state.lastPass?.at;
    return { line: `${label} работает${Number.isFinite(at) ? ` (последняя проверка ${formatTime(at, timeZone)})` : ''}.`, warning: null };
  }
  if (!weekly) return { line: `${label} выключена.`, warning: null };
  return { line: `${label} не работает.`, warning: session && state.sessionLost ?
    `Вход этого Mac в ChatGPT потерян. Войдите заново: ${SETUP}.` : `Внеочередная проверка с этого Mac не запущена. Запустите ${SETUP}.` };
}
