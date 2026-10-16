import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keychain, KEYCHAIN_SERVICE } from '../src/installer/installer-keychain.mjs';
import { messages, loadInstallationToken, keepInstallationToken } from '../src/installer/installer-ui.mjs';
import { Installer } from '../src/installer/installer.mjs';
import { sealAdmin, adminFingerprint } from '../src/installer/installer-admin.mjs';
import { StateFailure } from '../src/core/state-store.mjs';

const REPO = 'synthetic/private', OLD = 'github_pat_synthetic_old', NEW = 'github_pat_synthetic_new';

// Fake `/usr/bin/security -i`: one command line from stdin against an in-memory Keychain.
function fakeSecurity({ entries = new Map(), code = null, fail = null } = {}) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    if (fail === 'throw') throw new Error('spawn failed');
    const child = new EventEmitter(), stdin = new PassThrough(); let line = '';
    child.stdin = stdin; child.stdout = new PassThrough(); child.kill = () => child.emit('close', null);
    stdin.on('data', b => { line += b; });
    stdin.on('end', () => {
      const call = { file, args, options, line }; calls.push(call);
      if (fail === 'error') { child.emit('error', new Error('ENOENT')); return; }
      if (fail === 'hang') return;
      const words = line.trim().split(/\s+/), opt = flag => words[words.indexOf(flag) + 1];
      const key = `${opt('-s')}\0${opt('-a')}`;
      let exit = 0;
      if (words[0] === 'add-generic-password') entries.set(key, opt('-w'));
      else if (words[0] === 'find-generic-password') { if (entries.has(key)) child.stdout.write(`${entries.get(key)}\n`); else exit = 44; }
      else if (words[0] === 'delete-generic-password') { if (!entries.delete(key)) exit = 44; }
      child.stdout.end(); setImmediate(() => child.emit('close', code ?? exit));
    });
    return child;
  };
  return { spawnImpl, calls, entries };
}
// The token travels only in stdin: never in argv, the spawn options or the environment.
function assertStdinOnly(calls, ...tokens) {
  for (const { file, args, options } of calls) {
    assert.equal(file, '/usr/bin/security'); assert.deepEqual(args, ['-i']);
    assert.equal(options.env, undefined);
    for (const token of tokens) {
      assert.ok(!JSON.stringify([args, options]).includes(token));
      assert.ok(!Object.values(process.env).some(value => value?.includes(token)));
    }
  }
}

test('Keychain stores the token as generic password auto-reset/owner/repo through stdin only', async () => {
  const security = fakeSecurity(), keychain = new Keychain({ repository: REPO, spawnImpl: security.spawnImpl });
  assert.equal(await keychain.read(), null);
  await keychain.write(OLD);
  assert.equal(await keychain.read(), OLD);
  await keychain.write(NEW); // -U replaces the entry after a rotation.
  assert.equal(await keychain.read(), NEW);
  assert.deepEqual([...security.entries], [[`${KEYCHAIN_SERVICE}\0${REPO}`, NEW]]);
  await keychain.remove(); await keychain.remove(); // A missing entry is already removed.
  assert.equal(await keychain.read(), null);
  assert.deepEqual(security.calls.map(c => c.line), [
    'find-generic-password -s auto-reset -a synthetic/private -w\n',
    `add-generic-password -U -w ${OLD} -s auto-reset -a synthetic/private\n`,
    'find-generic-password -s auto-reset -a synthetic/private -w\n',
    `add-generic-password -U -w ${NEW} -s auto-reset -a synthetic/private\n`,
    'find-generic-password -s auto-reset -a synthetic/private -w\n',
    'delete-generic-password -s auto-reset -a synthetic/private\n',
    'delete-generic-password -s auto-reset -a synthetic/private\n',
    'find-generic-password -s auto-reset -a synthetic/private -w\n']);
  assertStdinOnly(security.calls, OLD, NEW);
});

test('Keychain refusals are keychain_unavailable; unsafe names and values never reach security', async () => {
  for (const options of [{ code: 51 }, { fail: 'throw' }, { fail: 'error' }]) {
    const keychain = new Keychain({ repository: REPO, spawnImpl: fakeSecurity(options).spawnImpl });
    for (const call of [() => keychain.read(), () => keychain.write(OLD), () => keychain.remove()]) {
      await assert.rejects(call(), error => error instanceof StateFailure && error.kind === 'keychain_unavailable');
    }
  }
  const hung = new Keychain({ repository: REPO, spawnImpl: fakeSecurity({ fail: 'hang' }).spawnImpl, timeoutMs: 20 });
  await assert.rejects(hung.read(), /keychain_unavailable/); // A Keychain dialog left open does not hang the installer.
  const security = fakeSecurity();
  await assert.rejects(new Keychain({ repository: 'synthetic/private -a other', spawnImpl: security.spawnImpl }).read(), /keychain_unavailable/);
  for (const value of ['', 'token with space', 'token"quote', `a\nb`]) {
    await assert.rejects(new Keychain({ repository: REPO, spawnImpl: security.spawnImpl }).write(value), /keychain_unavailable/);
  }
  assert.equal(security.calls.length, 0);
  security.entries.set(`${KEYCHAIN_SERVICE}\0${REPO}`, 'not a token'); // A foreign value is asked for again.
  assert.equal(await new Keychain({ repository: REPO, spawnImpl: security.spawnImpl }).read(), null);
});

for (const language of ['ru', 'en']) test(`${language} token step: Keychain first, typed token on absence, rejection or refusal`, async () => {
  const lines = [], ui = { language, text: line => lines.push(line) }, w = messages[language];
  const verified = [], verify = async token => {
    verified.push(token);
    if (token === OLD) throw new StateFailure('installation_token_unauthorized');
    return { expiresAt: null, plan: true, otherRepositories: 0 };
  };
  let prompted = 0; const prompt = async () => { prompted++; return { token: NEW, ...(await verify(NEW)) }; };
  const security = fakeSecurity(), keychain = new Keychain({ repository: REPO, spawnImpl: security.spawnImpl });

  // No entry: typed once, saved after acceptance, and the next run asks nothing.
  let checked = await loadInstallationToken(ui, { keychain, verify, prompt });
  assert.deepEqual([checked.stored, checked.keychain, prompted], [false, keychain, 1]);
  assert.equal(await keepInstallationToken(ui, { keychain: checked.keychain, token: checked.token, repository: REPO }), keychain);
  assert.deepEqual(lines, [w.keychainSaved.replace('{repository}', REPO)]); lines.length = 0;
  checked = await loadInstallationToken(ui, { keychain, verify, prompt });
  assert.deepEqual([checked.token, checked.stored, prompted, lines.length], [NEW, true, 1, 0]);

  // A stale token (401) is replaced by a typed one; the saved one is overwritten.
  security.entries.set(`${KEYCHAIN_SERVICE}\0${REPO}`, OLD);
  checked = await loadInstallationToken(ui, { keychain, verify, prompt });
  assert.deepEqual([checked.token, checked.stored, prompted], [NEW, false, 2]);
  assert.deepEqual(lines, [w.keychainStale]); lines.length = 0;
  await keepInstallationToken(ui, { keychain, token: NEW, repository: REPO });
  assert.equal(security.entries.get(`${KEYCHAIN_SERVICE}\0${REPO}`), NEW); lines.length = 0;

  // Other failures of a stored token are not hidden behind a prompt.
  await assert.rejects(loadInstallationToken(ui, { keychain, prompt,
    verify: async () => { throw new StateFailure('installation_github_unreachable'); } }), /installation_github_unreachable/);

  // An unreadable Keychain: hidden input without saving.
  const refused = new Keychain({ repository: REPO, spawnImpl: fakeSecurity({ code: 51 }).spawnImpl });
  checked = await loadInstallationToken(ui, { keychain: refused, verify, prompt });
  assert.deepEqual([checked.token, checked.keychain, checked.stored, prompted], [NEW, null, false, 3]);
  assert.equal(await keepInstallationToken(ui, { keychain: checked.keychain, token: NEW, repository: REPO }), null);
  assert.deepEqual(lines, [w.keychainUnavailable]); lines.length = 0;
  // A refused write keeps the run going and is not followed afterwards.
  assert.equal(await keepInstallationToken(ui, { keychain: refused, token: NEW, repository: REPO }), null);
  assert.deepEqual(lines, [w.keychainUnavailable]);
  assertStdinOnly(security.calls, OLD, NEW);
});

// Fake installation: the pending admin command is accepted (done) or still pending in state.
async function installation(t, { keychain = null, phase = 'done', action = 'rotate-grant' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'installer-keychain-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const journalPath = join(dir, 'journal.json'), dispatched = [], connected = [];
  const command = sealAdmin(REPO, OLD, { action, commandId: 'admin-1', expectedVersion: 3 },
    action === 'rotate-grant' ? { newGrant: NEW, grantExpiresAt: 1_900_000_000 } : {});
  const github = token => ({ repository: REPO, token, dispatch: async c => { dispatched.push(c.commandId); return { state: 'unconfirmed' }; },
    status: async () => ({ version: 4, commands: [{ commandId: 'admin-1', fingerprint: adminFingerprint(command) }],
      installation: { operation: { commandId: 'admin-1', phase } } }) });
  const make = () => new Installer({ platform: 'darwin', journalPath, github: github(OLD), keychain,
    connect: token => { connected.push(token); return github(token); } });
  const first = make(); first.journal.pending = command; await first.save();
  return { make, first, dispatched, connected, journalPath };
}

test('confirmed rotate-grant switches the session to the new token and updates the Keychain, also on resume in a later run', async t => {
  const security = fakeSecurity(), keychain = new Keychain({ repository: REPO, spawnImpl: security.spawnImpl });
  await keychain.write(OLD);
  const { make, first, dispatched, connected, journalPath } = await installation(t, { keychain });
  assert.ok(!(await readFile(journalPath, 'utf8')).includes(NEW)); // The journal holds only ciphertext.
  // The first run exits before the receipt: the Keychain keeps the old token.
  const later = make(); await later.load();
  assert.equal(first.journal.pending.commandId, later.journal.pending.commandId);
  assert.equal(await keychain.read(), OLD);
  const receipt = await later.resume();
  assert.deepEqual([receipt.state, receipt.problem, receipt.keychain], ['accepted', null, 'keychainUpdated']);
  assert.equal(await keychain.read(), NEW);
  assert.deepEqual([later.github.token, later.grantExpiresAt, connected, dispatched], [NEW, 1_900_000_000, [NEW], []]);
  assert.equal(later.journal.pending, null);
  assertStdinOnly(security.calls, OLD, NEW);
});

test('rotation still pending or failed leaves the Keychain; a refused write is reported, the session still switches', async t => {
  const security = fakeSecurity(), keychain = new Keychain({ repository: REPO, spawnImpl: security.spawnImpl });
  await keychain.write(OLD);
  const pending = await installation(t, { keychain, phase: 'pending' });
  assert.equal((await pending.first.resume()).state, 'unconfirmed');
  assert.deepEqual([pending.dispatched, await keychain.read(), pending.first.github.token], [['admin-1'], OLD, OLD]);

  const refused = await installation(t, { keychain: new Keychain({ repository: REPO, spawnImpl: fakeSecurity({ code: 51 }).spawnImpl }) });
  const receipt = await refused.first.resume();
  assert.deepEqual([receipt.keychain, refused.first.github.token], ['keychainNotUpdated', NEW]);
  const hidden = await installation(t); // Hidden input this run: told to type the new token next time.
  assert.deepEqual([(await hidden.first.resume()).keychain, hidden.first.github.token], ['keychainNotUpdated', NEW]);
});

test('confirmed uninstall removes the Keychain entry; a refusal names the manual command', async t => {
  const security = fakeSecurity(), keychain = new Keychain({ repository: REPO, spawnImpl: security.spawnImpl });
  await keychain.write(OLD);
  const pending = await installation(t, { keychain, action: 'uninstall', phase: 'pending' });
  await pending.first.resume();
  assert.equal(await keychain.read(), OLD); // Uninstall not finished: the token is still needed for Resume.
  const done = await installation(t, { keychain, action: 'uninstall' });
  assert.equal((await done.first.resume()).keychain, 'keychainRemoved');
  assert.equal(await keychain.read(), null);
  const refused = await installation(t, { action: 'uninstall', keychain: new Keychain({ repository: REPO, spawnImpl: fakeSecurity({ code: 51 }).spawnImpl }) });
  assert.equal((await refused.first.resume()).keychain, 'keychainNotRemoved');
  assert.equal((await (await installation(t, { action: 'uninstall' })).first.resume()).keychain, null);
  for (const language of ['ru', 'en']) {
    assert.match(messages[language].keychainNotRemoved.replace('{repository}', REPO),
      /security delete-generic-password -s auto-reset -a synthetic\/private$/);
    for (const key of ['keychainSaved', 'keychainUnavailable', 'keychainStale', 'keychainUpdated', 'keychainNotUpdated', 'keychainRemoved']) {
      assert.equal(typeof messages[language][key], 'string', key);
    }
  }
  assertStdinOnly(security.calls, OLD);
});

test('installer CLI follows the Keychain: no token prompt when stored, no fixed rotation hint', async () => {
  const source = await readFile(new URL('../src/installer/install-cli.mjs', import.meta.url), 'utf8');
  assert.match(source, /loadInstallationToken\(ui, \{ keychain: new Keychain\(\{ repository \}\)/);
  assert.match(source, /keepInstallationToken\(ui, \{ keychain: checked\.keychain, token, repository \}\)/);
  assert.ok(!source.includes('enter the new installation token on the next run'));
});
