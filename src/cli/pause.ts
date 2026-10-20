// «Пауза» and «Снять с паузы» (CONTEXT.md, «Воркер на паузе»): the worker's schedule goes off
// and comes back while its session, its state and the rules stay, so unpausing needs no new
// ChatGPT sign-in. The install record keeps the pause in `paused`, which the check from this Mac
// already reads (a paused worker is woken by no pass), and the overview shows it as a standing
// warning and «сгорит» marks. The buttons of the screen «Воркер» call these actions too.
import { CommandFailed, WORKFLOW_FILE, unfinished, command } from './common.ts';
import type { CommandOptions } from './common.ts';
import { openWorker } from './active-worker.ts';
import type { GitHubWorker } from './active-worker.ts';
import type { Install } from './watch-files.ts';
import { t } from './language.ts';

// The install record with the pause field set or dropped.
const withPause = (install: Install, paused: boolean): Install => {
  const { paused: _was, ...rest } = install;
  return paused ? { ...rest, paused: true } : rest;
};

// Takes the worker's schedule off (paused) or brings it back: on GitHub the workflow is
// disabled and enabled, on Google doPost schedule takes the trigger off and on (ADR-0007).
// Nothing else is touched: the session is not revoked and the state stays where it is.
async function setPaused(options: CommandOptions, paused: boolean): Promise<number> {
  const { io, mac: { files } } = options;
  return command(null, io, async () => {
    const worker = await openWorker(options, null);
    if (worker.platform === 'github') await worker.api.setWorkflow(worker.repo.full_name, WORKFLOW_FILE, !paused);
    else await worker.ask('schedule', { on: !paused });
    // The record follows the platform: a crash before it leaves an ordinary worker with no
    // schedule, which the overview names, not a pause that is not there.
    const install = await files.readInstall();
    if (!install) throw new CommandFailed(unfinished());
    await files.writeInstall(withPause(install, paused));
    io.print(paused ?
      t('The worker is paused: its schedule is off, the sign-in and the data stay. «Apply now» keeps working.',
        'Воркер на паузе: расписание снято, вход и данные остаются. «Применить сейчас» продолжает работать.') :
      t('The worker is off pause: its schedule is back.', 'Воркер снят с паузы: расписание вернулось.'));
    return 0;
  });
}

// «Пауза»: the schedule goes off, the worker itself stays as it is.
export async function pauseWorker(options: CommandOptions): Promise<number> {
  return setPaused(options, true);
}

// «Снять с паузы»: the schedule comes back to the same worker.
export async function unpauseWorker(options: CommandOptions): Promise<number> {
  return setPaused(options, false);
}

// GitHub takes no dispatch to a disabled workflow, so «Применить сейчас» and a trial run on a
// paused worker enable it for that one run and disable it again after: the run happens, the
// pause stays. Called only for a worker whose install record says paused.
export async function runWhileEnabled<T>({ api, repo }: GitHubWorker, run: () => Promise<T>): Promise<T> {
  const name = repo.full_name;
  await api.setWorkflow(name, WORKFLOW_FILE, true);
  try { return await run(); } finally { await api.setWorkflow(name, WORKFLOW_FILE, false); }
}
