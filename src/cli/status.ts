import { connectGitHub, installedWorker, command } from './common.ts';
import type { CommandOptions } from './common.ts';
import { readOverview, renderOverview, paint, WIDTH } from './overview.ts';

// `aures status`: the overview of the screen, printed once: the resets, the
// rules, the worker and the warnings when the worker or the check from this Mac is not running.
export async function status({ fetch, keychain, io, mac, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeZone }: CommandOptions): Promise<number> {
  return command('status', io, async () => {
    const { api, login } = await connectGitHub({ fetch, keychain, io, now, sleep });
    const repo = await installedWorker({ api, login });
    const model = await readOverview({ api, repo, mac, now });
    for (const line of renderOverview(model, { now, timeZone, width: io.width ?? WIDTH })) io.print(paint(line, io.color).trimEnd());
    return 0;
  });
}
