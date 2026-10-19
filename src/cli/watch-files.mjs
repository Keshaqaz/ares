import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';

// What the out-of-schedule check keeps on this Mac: the computer session and watch.json.
// `security -i` cuts its command line at 4096 bytes and runs the rest as another command,
// and a session (three JWTs) is over 4 KB of JSON, so it lives in a 0600 file, not in the
// Keychain (ADR-0005).
export const SUPPORT_DIR = join(homedir(), 'Library', 'Application Support', 'codex-auto-resets');
const SESSION = 'chatgpt-session.json', STATE = 'watch.json';
const SESSION_FIELDS = ['accessToken', 'refreshToken', 'accountId'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class WatchFiles {
  constructor({ dir = SUPPORT_DIR } = {}) { this.dir = dir; }
  // null when the file is missing or does not parse.
  async read(name) {
    try { return JSON.parse(await readFile(join(this.dir, name), 'utf8')); } catch { return null; }
  }
  // Written aside and renamed, so a crash never leaves half a file.
  async write(name, value) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, name), aside = `${file}.tmp`;
    await writeFile(aside, JSON.stringify(value), { mode: 0o600 });
    await rename(aside, file);
  }

  // The computer session, or null when there is none or it is not a session.
  async readSession() {
    const session = await this.read(SESSION);
    return object(session) && SESSION_FIELDS.every(key => typeof session[key] === 'string' && session[key]) ? session : null;
  }
  async writeSession(session) { await this.write(SESSION, session); }
  // A broken watch.json counts as empty.
  async readState() {
    const state = await this.read(STATE);
    return object(state) ? state : {};
  }
  async writeState(state) { await this.write(STATE, state); }
}
