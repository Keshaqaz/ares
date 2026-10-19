// This Mac as the CLI sees it: launchctl, the LaunchAgents and Logs folders and the watch
// files, all in a temporary home.
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LaunchAgent } from '../../src/cli/launch-agent.mjs';
import { WatchFiles } from '../../src/cli/watch-files.mjs';

export const UID = 501;
export const PROGRAM = ['/opt/homebrew/opt/aures/bin/aures', 'watch'];

// launchctl for one user's GUI domain: bootstrap loads the plist as it is on disk now, as
// launchd does; exit codes as launchctl gives them.
export function fakeLaunchctl() {
  const launchctl = {
    loaded: new Map(), // label → plist text it was loaded from
    calls: [],
    fail: null, // { verb, code }: that verb fails
    run: async args => {
      launchctl.calls.push(args);
      const [verb, target, path] = args;
      if (launchctl.fail?.verb === verb) return { code: launchctl.fail.code };
      if (target.split('/')[1] !== String(UID)) return { code: 125 };
      if (verb === 'bootstrap') {
        const plist = await readFile(path, 'utf8').catch(() => null);
        const label = plist?.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
        if (!label) return { code: 5 };
        // An agent already loaded: «Bootstrap failed: 5: Input/output error».
        if (launchctl.loaded.has(label)) return { code: 5 };
        launchctl.loaded.set(label, plist);
        return { code: 0 };
      }
      const label = target.split('/')[2];
      if (verb === 'bootout') return { code: launchctl.loaded.delete(label) ? 0 : 3 };
      if (verb === 'print') return { code: launchctl.loaded.has(label) ? 0 : 113 };
      return { code: 64 };
    },
  };
  return launchctl;
}

export async function fakeMac() {
  const home = await mkdtemp(join(tmpdir(), 'fake-mac-'));
  const launchctl = fakeLaunchctl();
  const agent = new LaunchAgent({ home, uid: UID, program: PROGRAM, launchctl: launchctl.run, sleep: async () => {} });
  const files = new WatchFiles({ dir: join(home, 'Library', 'Application Support', 'codex-auto-resets') });
  return { home, launchctl, agent, files };
}
