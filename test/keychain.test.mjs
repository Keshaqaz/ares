import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { GitHubTokenKeychain, KeychainUnavailable } from '../src/cli/keychain.mjs';

const TOKEN = 'gho_synthetic0000000000000000000000000000';

// Fake `/usr/bin/security -i`: one command line from stdin against an in-memory Keychain.
function fakeSecurity({ code = null } = {}) {
  const entries = new Map(), calls = [];
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter(), stdin = new PassThrough();
    let line = '';
    child.stdin = stdin; child.stdout = new PassThrough(); child.kill = () => child.emit('close', null);
    stdin.on('data', chunk => { line += chunk; });
    stdin.on('end', () => {
      calls.push({ file, args, options, line });
      const words = line.trim().split(/\s+/), opt = flag => words[words.indexOf(flag) + 1];
      const key = `${opt('-s')}/${opt('-a')}`;
      let exit = 0;
      if (words[0] === 'add-generic-password') entries.set(key, opt('-w'));
      else if (words[0] === 'find-generic-password') { if (entries.has(key)) child.stdout.write(`${entries.get(key)}\n`); else exit = 44; }
      else if (words[0] === 'delete-generic-password') { if (!entries.delete(key)) exit = 44; }
      child.stdout.end();
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
