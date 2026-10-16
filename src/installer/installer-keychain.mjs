import { spawn } from 'node:child_process';
import { StateFailure } from '../core/state-store.mjs';

// Installation token in the macOS login Keychain (ticket 41): generic password, service
// `auto-reset`, account `owner/repo`. `security -i` reads its command from stdin, so the token
// never reaches argv, env or files. Any refusal is `keychain_unavailable`: the caller falls back
// to hidden input without saving.
export const KEYCHAIN_SERVICE = 'auto-reset';
const SECURITY = '/usr/bin/security', NOT_FOUND = 44;
// `security -i` splits its line on whitespace and quotes: only plain names and token characters reach it.
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, TOKEN = /^[A-Za-z0-9_-]{1,255}$/;
const fail = kind => { throw new StateFailure(kind); };

export class Keychain {
  constructor({ repository, spawnImpl = spawn, timeoutMs = 120_000 }) {
    Object.assign(this, { repository, spawnImpl, timeoutMs });
  }
  // Exit code of one `security -i` command; -1 when it cannot run. A locked Keychain may ask
  // for the password in a dialog, so the wait is bounded.
  run(command) {
    if (!REPOSITORY.test(this.repository ?? '')) return Promise.resolve({ code: -1, stdout: '' });
    return new Promise(resolve => {
      let child, stdout = '', settled = false;
      const finish = code => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout }); } };
      const timer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} finish(-1); }, this.timeoutMs);
      try { child = this.spawnImpl(SECURITY, ['-i'], { stdio: ['pipe', 'pipe', 'ignore'] }); } catch { finish(-1); return; }
      child.once('error', () => finish(-1));
      child.once('close', code => finish(code ?? -1));
      child.stdout.on('data', chunk => { if (stdout.length < 64 * 1024) stdout += chunk; });
      child.stdin.on('error', () => {});
      child.stdin.end(`${command} -s ${KEYCHAIN_SERVICE} -a ${this.repository}${command.startsWith('find') ? ' -w' : ''}\n`);
    });
  }
  // null — no entry (or a value that is not a token): the installer asks for one.
  async read() {
    const { code, stdout } = await this.run('find-generic-password');
    if (code === NOT_FOUND) return null;
    if (code !== 0) fail('keychain_unavailable');
    const token = stdout.replace(/\r?\n$/, '');
    return TOKEN.test(token) ? token : null;
  }
  // -U replaces an existing entry (after a rotation).
  async write(token) {
    if (!TOKEN.test(token ?? '')) fail('keychain_unavailable');
    const { code } = await this.run(`add-generic-password -U -w ${token}`);
    if (code !== 0) fail('keychain_unavailable');
  }
  async remove() {
    const { code } = await this.run('delete-generic-password');
    if (code !== 0 && code !== NOT_FOUND) fail('keychain_unavailable');
  }
}
