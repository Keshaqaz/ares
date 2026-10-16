// FUTURE LIVE DISPATCH ONLY. Does not load a local CI vault or perform login.
import { Installer } from '../src/installer.mjs';
import { InstallerGitHub } from '../src/installer-github.mjs';
import { StateFailure } from '../src/state-store.mjs';
import { verifyObserverRuntime } from '../src/observer-dispatch.mjs';
import { readFile } from 'node:fs/promises';
const pins = JSON.parse(await readFile(new URL('../runtime-lock.json', import.meta.url), 'utf8'));
try {
  if (process.version !== `v${pins.node}`) throw new StateFailure('node_version_mismatch');
  const minutes = Number(process.argv[2]);
  if (process.argv.length !== 3 || !/^\d+$/.test(process.argv[2]) || !Number.isSafeInteger(minutes)) throw new StateFailure('combined_future_minutes_required');
  if (!process.env.AUTO_RESET_INSTALLER_JOURNAL) throw new StateFailure('installer_journal_required');
  const github = new InstallerGitHub({ repository: process.env.GITHUB_REPOSITORY, token: process.env.AUTO_RESET_GITHUB_TOKEN });
  const installer = new Installer({ github, journalPath: process.env.AUTO_RESET_INSTALLER_JOURNAL });
  await installer.load();
  const s = await github.status();
  if (!s.disabled || s.revoked || s.auth?.phase !== 'ready' || s.installation?.operation?.phase === 'pending') throw new StateFailure('observer_requires_disabled');
  const manifest = process.env.AUTO_RESET_OBSERVER_MANIFEST ?
    JSON.parse(await readFile(process.env.AUTO_RESET_OBSERVER_MANIFEST, 'utf8')) : null;
  await verifyObserverRuntime(github, s, manifest);
  const result = await installer.send('check', { forceRefresh: false, observer: { schema: 1, futureMinutes: minutes } }, s.version);
  process.stdout.write(`${JSON.stringify({ state: result.state ?? 'dispatched' })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ error: error instanceof StateFailure ? error.kind : 'observer_dispatch_failed' })}\n`);
  process.exitCode = 1;
}
