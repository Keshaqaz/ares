import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';

// The launchd agent that runs `codex-auto-resets watch` every 2 minutes while the weekly rule
// is on (ADR-0005). It lives in the user's GUI domain, so it runs only while the user is
// logged in, and launchd starts no pass while the previous one runs.
export const AGENT_LABEL = 'com.github.keshaqaz.codex-auto-resets.watch';
const INTERVAL_S = 120;
const LAUNCHCTL = '/bin/launchctl';
// A bootout returns before launchd has let go of the agent, and a bootstrap right after it
// may fail; it is retried.
const BOOTSTRAP_ATTEMPTS = 3, BOOTSTRAP_PAUSE_MS = 500;

export class LaunchctlFailed extends Error {}

// What the agent runs. Homebrew keeps a version in its own Cellar folder; the opt link moves
// to the new one on `brew upgrade`, so the agent goes through it. From sources: this node and
// this main.mjs.
export function agentProgram({ main, node }) {
  const brew = main.match(/^(.+)\/Cellar\/codex-auto-resets\/[^/]+\/libexec\/src\/cli\/main\.mjs$/);
  return brew ? [`${brew[1]}/opt/codex-auto-resets/bin/codex-auto-resets`, 'watch'] : [node, main, 'watch'];
}

const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const exists = path => stat(path).then(() => true, () => false);

// Exit code of one launchctl command; -1 when it cannot run.
function runLaunchctl(args) {
  return new Promise(resolve => execFile(LAUNCHCTL, args, { timeout: 30_000 },
    error => resolve({ code: !error ? 0 : Number.isInteger(error.code) ? error.code : -1 })));
}

export class LaunchAgent {
  constructor({ home = homedir(), uid = process.getuid(), launchctl = runLaunchctl,
    program = agentProgram({ main: fileURLToPath(new URL('./main.mjs', import.meta.url)), node: process.execPath }),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    Object.assign(this, { home, uid, launchctl, program, sleep });
    this.plistPath = join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
    this.logPath = join(home, 'Library', 'Logs', 'codex-auto-resets', 'watch.log');
  }

  plist() {
    const string = text => `<string>${xml(text)}</string>`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(AGENT_LABEL)}
  <key>ProgramArguments</key>
  <array>
${this.program.map(arg => `    ${string(arg)}`).join('\n')}
  </array>
  <key>StartInterval</key>
  <integer>${INTERVAL_S}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  ${string('Background')}
  <key>StandardOutPath</key>
  ${string(this.logPath)}
  <key>StandardErrorPath</key>
  ${string(this.logPath)}
</dict>
</plist>
`;
  }

  // Writes the plist and (re)loads the agent from it, so a new program path takes effect. A
  // loaded agent with the same plist is left alone: a bootout kills a running pass, and one
  // killed between a refresh and saving the session loses it.
  async install() {
    const plist = this.plist();
    if (await readFile(this.plistPath, 'utf8').catch(() => null) === plist && await this.loaded()) return;
    await mkdir(dirname(this.plistPath), { recursive: true });
    await mkdir(dirname(this.logPath), { recursive: true });
    const aside = `${this.plistPath}.tmp`;
    await writeFile(aside, plist, { mode: 0o644 });
    await rename(aside, this.plistPath);
    await this.launchctl(['bootout', this.target]);
    let code;
    for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt++) {
      if (attempt > 1) await this.sleep(BOOTSTRAP_PAUSE_MS);
      ({ code } = await this.launchctl(['bootstrap', `gui/${this.uid}`, this.plistPath]));
      if (code === 0) return;
    }
    throw new LaunchctlFailed(`bootstrap: ${code}`);
  }

  // Unloads the agent and deletes its plist. True when either was there.
  async remove() {
    const unloaded = (await this.launchctl(['bootout', this.target])).code === 0;
    const had = await exists(this.plistPath);
    await rm(this.plistPath, { force: true });
    return unloaded || had;
  }

  async loaded() { return (await this.launchctl(['print', this.target])).code === 0; }
  async removeLogFolder() { await rm(dirname(this.logPath), { recursive: true, force: true }); }
  get target() { return `gui/${this.uid}/${AGENT_LABEL}`; }
}
