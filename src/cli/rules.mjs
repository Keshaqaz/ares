import { FILES } from '../worker/layout.mjs';
import { readRules, BrokenState } from '../worker/state-file.mjs';
import { CommandFailed, UNFINISHED, connectGitHub, installedWorker, chooseRules, command } from './common.mjs';
import { followWeeklyRule } from './mac-check.mjs';

// `codex-auto-resets rules`: switches the general rules. The CLI is the only writer of the
// open rules file; the worker reads it on every run, so a change works from the next one.
// This Mac follows the weekly rule, changed or not.
export async function rules({ fetch, keychain, io, mac, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  return command('rules', io, async () => {
    const { api, login } = await connectGitHub({ fetch, keychain, io, now, sleep });
    const repo = await installedWorker({ api, login });
    const file = await api.file(repo.full_name, FILES.rules);
    if (!file) throw new CommandFailed(UNFINISHED);
    let current;
    try { current = readRules(file.text); } catch (error) {
      if (!(error instanceof BrokenState)) throw error;
      io.print(`Правила не читаются (${error.reason}), выберите их заново.`);
    }
    const chosen = await chooseRules(io, current);
    if (current && chosen.beforeExpiry === current.beforeExpiry && chosen.weeklyAutoApply === current.weeklyAutoApply) {
      io.print('Правила не изменились.');
    } else {
      await api.putFile(repo.full_name, FILES.rules, `${JSON.stringify(chosen, null, 2)}\n`,
        { message: 'Change the general rules', sha: file.sha });
      io.print('Правила сохранены и заработают со следующего запуска воркера.');
    }
    await followWeeklyRule({ weekly: chosen.weeklyAutoApply, mac, fetch, io, now, sleep });
    return 0;
  });
}
