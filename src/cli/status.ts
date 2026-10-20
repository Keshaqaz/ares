import { command } from './common.ts';
import type { CommandOptions } from './common.ts';
import { openWorker } from './active-worker.ts';
import { readOverview, renderOverview, paint, WIDTH } from './overview.ts';

// `aures status`: the overview of the screen, printed once: the resets, the
// rules, the worker and the warnings when the worker or the check from this Mac is not running.
export async function status(options: CommandOptions): Promise<number> {
  const { io, mac, now = Date.now, timeZone } = options;
  return command('status', io, async () => {
    const worker = await openWorker(options, 'status');
    const model = await readOverview({ worker, mac, now });
    for (const line of renderOverview(model, { now, timeZone, width: io.width ?? WIDTH })) io.print(paint(line, io.color).trimEnd());
    return 0;
  });
}
