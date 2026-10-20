import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { GitHubTokenKeychain, KeychainEntry, KeychainUnavailable, GOOGLE_TOKEN_ACCOUNT, WORKER_SECRET_ACCOUNT } from '../src/cli/keychain.ts';
import type { Spawn } from '../src/cli/keychain.ts';

const TOKEN = 'gho_synthetic0000000000000000000000000000';

// Fake `/usr/bin/security -i`: one command line from stdin against an in-memory Keychain.
function fakeSecurity({ code = null }: { code?: number | null } = {}) {
  const entries = new Map<string, string | undefined>();
  const calls: { file: string; args: string[]; options: unknown; line: string }[] = [];
  const spawnImpl: Spawn = (file, args, options) => {
    const stdin = new PassThrough(), stdout = new PassThrough();
    let line = '';
    const child = Object.assign(new ChildProcess(), { stdin, stdout, stderr: null, stdio: [stdin, stdout, null, undefined, undefined] as const,
      kill: () => child.emit('close', null) });
    stdin.on('data', (chunk: Buffer) => { line += chunk; });
    stdin.on('end', () => {
      calls.push({ file, args, options, line });
      const words = line.trim().split(/\s+/), opt = (flag: string) => words[words.indexOf(flag) + 1];
      const key = `${opt('-s')}/${opt('-a')}`;
      let exit = 0;
      if (words[0] === 'add-generic-password') entries.set(key, opt('-w'));
      else if (words[0] === 'find-generic-password') { if (entries.has(key)) stdout.write(`${entries.get(key)}\n`); else exit = 44; }
      else if (words[0] === 'delete-generic-password') { if (!entries.delete(key)) exit = 44; }
      stdout.end();
      setImmediate(() => child.emit('close', code ?? exit));
    });
    return child;
  };
  return { spawnImpl, entries, calls };
}

test('the GitHub token lives in the Keychain as codex-auto-resets/github and travels only through stdin', async () => {
  const security = fakeSecurity();
  const keychain = new GitHubTokenKeychain({ spawnImpl: security.spawnImpl });
  assert.equal(await keychain.read(), null);
  await keychain.write(TOKEN);
  assert.equal(await keychain.read(), TOKEN);
  assert.deepEqual([...security.entries], [['codex-auto-resets/github', TOKEN]]);
  await keychain.remove();
  await keychain.remove();
  assert.equal(await keychain.read(), null);
  for (const { file, args, options } of security.calls) {
    assert.equal(file, '/usr/bin/security');
    assert.deepEqual(args, ['-i']);
    assert.ok(!JSON.stringify(options).includes(TOKEN));
  }
});

test('a refusing Keychain is KeychainUnavailable, and values that are not tokens never reach security', async () => {
  const keychain = new GitHubTokenKeychain({ spawnImpl: fakeSecurity({ code: 51 }).spawnImpl });
  for (const call of [() => keychain.read(), () => keychain.write(TOKEN), () => keychain.remove()]) {
    await assert.rejects(call(), KeychainUnavailable);
  }
  const security = fakeSecurity();
  for (const value of ['', 'token with space', `a\nb`, 'x -s other']) {
    await assert.rejects(new GitHubTokenKeychain({ spawnImpl: security.spawnImpl }).write(value), KeychainUnavailable);
  }
  assert.equal(security.calls.length, 0);
});

test('the Google refresh token and the doPost secret live in entries of their own next to the GitHub token', async () => {
  const security = fakeSecurity();
  const github = new GitHubTokenKeychain({ spawnImpl: security.spawnImpl });
  const google = new KeychainEntry(GOOGLE_TOKEN_ACCOUNT, { spawnImpl: security.spawnImpl });
  const secret = new KeychainEntry(WORKER_SECRET_ACCOUNT, { spawnImpl: security.spawnImpl });
  await github.write(TOKEN);
  await google.write('1//0gSynthetic-refresh_token.0000');
  await secret.write('c2VjcmV0LXN5bnRoZXRpYw');
  assert.deepEqual(Object.fromEntries(security.entries), { 'codex-auto-resets/github': TOKEN,
    'codex-auto-resets/google': '1//0gSynthetic-refresh_token.0000', 'codex-auto-resets/worker-secret': 'c2VjcmV0LXN5bnRoZXRpYw' });
  await google.remove();
  assert.equal(await google.read(), null);
  assert.equal(await github.read(), TOKEN);
});
