import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

// The user's GitHub token in the macOS login Keychain: generic password, service
// `codex-auto-resets`, account `github`. `security -i` reads its command from stdin, so the
// token never reaches argv, env or files.
export const KEYCHAIN_SERVICE = 'codex-auto-resets';
const ACCOUNT = 'github';
const SECURITY = '/usr/bin/security', NOT_FOUND = 44;
// `security -i` splits its line on whitespace and quotes: only token characters reach it.
const TOKEN = /^[A-Za-z0-9_-]{1,255}$/;

export class KeychainUnavailable extends Error {}

// Where the commands keep the GitHub token.
export interface Keychain {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  remove(): Promise<void>;
}

// spawn as the Keychain calls it: stdin and stdout piped, stderr ignored.
export type Spawn = (command: string, args: string[], options: { stdio: ['pipe', 'pipe', 'ignore'] }) =>
  ChildProcessByStdio<Writable, Readable, null>;
export interface GitHubTokenKeychainOptions { spawnImpl?: Spawn; timeoutMs?: number }

export class GitHubTokenKeychain implements Keychain {
  spawnImpl: Spawn;
  timeoutMs: number;
  constructor({ spawnImpl = spawn, timeoutMs = 120_000 }: GitHubTokenKeychainOptions = {}) {
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
  }
  // Exit code of one `security -i` command; -1 when it cannot run. A locked Keychain may ask
  // for the password in a dialog, so the wait is bounded.
  run(command: string): Promise<{ code: number; stdout: string }> {
    return new Promise(resolve => {
      let child: ReturnType<Spawn> | undefined, stdout = '', settled = false;
      const finish = (code: number) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code, stdout }); } };
      const timer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} finish(-1); }, this.timeoutMs);
      try { child = this.spawnImpl(SECURITY, ['-i'], { stdio: ['pipe', 'pipe', 'ignore'] }); } catch { finish(-1); return; }
      child.once('error', () => finish(-1));
      child.once('close', code => finish(code ?? -1));
      child.stdout.on('data', chunk => { if (stdout.length < 64 * 1024) stdout += chunk; });
      child.stdin.on('error', () => {});
      child.stdin.end(`${command} -s ${KEYCHAIN_SERVICE} -a ${ACCOUNT}${command.startsWith('find') ? ' -w' : ''}\n`);
    });
  }
  // null when there is no entry or it does not hold a token.
  async read(): Promise<string | null> {
    const { code, stdout } = await this.run('find-generic-password');
    if (code === NOT_FOUND) return null;
    if (code !== 0) throw new KeychainUnavailable();
    const token = stdout.replace(/\r?\n$/, '');
    return TOKEN.test(token) ? token : null;
  }
  // -U replaces an existing entry.
  async write(token: string): Promise<void> {
    if (!TOKEN.test(token ?? '')) throw new KeychainUnavailable();
    if ((await this.run(`add-generic-password -U -w ${token}`)).code !== 0) throw new KeychainUnavailable();
  }
  async remove(): Promise<void> {
    const { code } = await this.run('delete-generic-password');
    if (code !== 0 && code !== NOT_FOUND) throw new KeychainUnavailable();
  }
}
