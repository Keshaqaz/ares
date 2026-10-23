import { FILES } from '../worker/layout.ts';
import { readRules, BrokenState } from '../worker/state-file.ts';
import { CommandFailed, unfinished, chooseRules, command } from './common.ts';
import type { CommandOptions, Printer, Sleep } from './common.ts';
import type { OpenUrl, CopyText } from './browser.ts';
import { openWorker, rulesOf } from './active-worker.ts';
import type { Worker } from './active-worker.ts';
import type { Fetch } from '../chatgpt/http.ts';
import type { Rules } from '../worker/state-file.ts';
import { t } from './language.ts';
import { followWeeklyRule } from './mac-check.ts';
import type { Mac } from './mac-check.ts';

// The rules as the worker keeps them now: current is undefined when there are none or, with
// broken naming why, when they do not read. write puts other rules in their place.
export interface StoredRules { current: Rules | undefined; broken: string | null; write(rules: Rules): Promise<void> }
export async function storedRules(worker: Worker): Promise<StoredRules> {
  if (worker.platform === 'google') {
    return { current: rulesOf((await worker.status()).rules) ?? undefined, broken: null, write: async ({ beforeExpiry, weeklyAutoApply }) => { await worker.ask('rules', { rules: { beforeExpiry, weeklyAutoApply } }); } };
  }
  const { api, repo } = worker;
  const file = await api.file(repo.full_name, FILES.rules);
  if (!file) throw new CommandFailed(unfinished());
  const write = async (rules: Rules) => {
    await api.putFile(repo.full_name, FILES.rules, `${JSON.stringify(rules, null, 2)}\n`, { message: 'Change the general rules', sha: file.sha });
  };
  try { return { current: readRules(file.text), broken: null, write }; } catch (error) {
    if (!(error instanceof BrokenState)) throw error;
    return { current: undefined, broken: error.reason, write };
  }
}

// Writes the chosen rules over the stored ones and brings this Mac in line with the weekly
// rule, changed or not. The check from this Mac does not wake the worker on Google yet, so
// there it is left as it is.
export interface SaveRulesOptions {
  worker: Worker;
  stored: StoredRules;
  chosen: Rules;
  mac: Mac;
  fetch: Fetch;
  io: Printer;
  open: OpenUrl;
  copy: CopyText;
  now: () => number;
  sleep: Sleep;
}
export async function saveRules({ worker, stored: { current, write }, chosen, mac, fetch, io, open, copy, now, sleep }: SaveRulesOptions): Promise<void> {
  if (current && chosen.beforeExpiry === current.beforeExpiry && chosen.weeklyAutoApply === current.weeklyAutoApply) {
    io.print(t('The rules did not change.', 'Правила не изменились.'));
  } else {
    await write(chosen);
    io.print(t('The rules are saved and take effect from the next worker run.', 'Правила сохранены и заработают со следующего запуска воркера.'));
  }
  if (worker.platform === 'github') await followWeeklyRule({ weekly: chosen.weeklyAutoApply, mac, fetch, io, open, copy, now, sleep });
}

// `aures rules`: switches the general rules. The CLI is the only writer of the rules; the
// worker reads them on every run, so a change works from the next one.
export async function rules(options: CommandOptions): Promise<number> {
  const { fetch, io, open, copy, mac, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = options;
  return command('rules', io, async () => {
    const worker = await openWorker(options, 'rules');
    const stored = await storedRules(worker);
    if (stored.broken) io.print(t(`The rules do not read (${stored.broken}), choose them again.`, `Правила не читаются (${stored.broken}), выберите их заново.`));
    const chosen = await chooseRules(io, stored.current, worker.platform);
    await saveRules({ worker, stored, chosen, mac, fetch, io, open, copy, now, sleep });
    return 0;
  });
}
