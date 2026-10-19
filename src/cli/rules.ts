import { FILES } from '../worker/layout.ts';
import { readRules, BrokenState } from '../worker/state-file.ts';
import { CommandFailed, unfinished, connectGitHub, installedWorker, chooseRules, command } from './common.ts';
import type { CommandOptions, Printer, Sleep } from './common.ts';
import type { GitHubApi, Repository } from '../github/api.ts';
import type { Fetch } from '../chatgpt/http.ts';
import type { Rules } from '../worker/state-file.ts';
import { t } from './language.ts';
import { followWeeklyRule } from './mac-check.ts';
import type { Mac } from './mac-check.ts';

// Writes the chosen rules over current (null when they did not read) and brings this Mac in
// line with the weekly rule, changed or not.
export interface SaveRulesOptions {
  api: GitHubApi;
  repo: Repository;
  sha: string;
  current: Rules | undefined;
  chosen: Rules;
  mac: Mac;
  fetch: Fetch;
  io: Printer;
  now: () => number;
  sleep: Sleep;
}
export async function saveRules({ api, repo, sha, current, chosen, mac, fetch, io, now, sleep }: SaveRulesOptions): Promise<void> {
  if (current && chosen.beforeExpiry === current.beforeExpiry && chosen.weeklyAutoApply === current.weeklyAutoApply) {
    io.print(t('The rules did not change.', 'Правила не изменились.'));
  } else {
    await api.putFile(repo.full_name, FILES.rules, `${JSON.stringify(chosen, null, 2)}\n`, { message: 'Change the general rules', sha });
    io.print(t('The rules are saved and take effect from the next worker run.', 'Правила сохранены и заработают со следующего запуска воркера.'));
  }
  await followWeeklyRule({ weekly: chosen.weeklyAutoApply, mac, fetch, io, now, sleep });
}

// `aures rules`: switches the general rules. The CLI is the only writer of the
// open rules file; the worker reads it on every run, so a change works from the next one.
export async function rules({ fetch, keychain, io, mac, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }:
  CommandOptions): Promise<number> {
  return command('rules', io, async () => {
    const { api, login } = await connectGitHub({ fetch, keychain, io, now, sleep });
    const repo = await installedWorker({ api, login });
    const file = await api.file(repo.full_name, FILES.rules);
    if (!file) throw new CommandFailed(unfinished());
    let current: Rules | undefined;
    try { current = readRules(file.text); } catch (error) {
      if (!(error instanceof BrokenState)) throw error;
      io.print(t(`The rules do not read (${error.reason}), choose them again.`, `Правила не читаются (${error.reason}), выберите их заново.`));
    }
    const chosen = await chooseRules(io, current);
    await saveRules({ api, repo, sha: file.sha, current, chosen, mac, fetch, io, now, sleep });
    return 0;
  });
}
