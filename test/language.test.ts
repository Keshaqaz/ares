import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { languageOfLocale, readSystemLanguage, startLanguage } from '../src/cli/language.ts';
import type { SpawnDefaults } from '../src/cli/language.ts';
import { WatchFiles } from '../src/cli/watch-files.ts';

// Fake `/usr/bin/defaults read -g AppleLanguages`: prints stdout and exits with code, ends
// in an error instead, or cannot run at all.
function fakeDefaults({ stdout = '', code = 0, error = false, refuse = false }:
  { stdout?: string; code?: number; error?: boolean; refuse?: boolean } = {}) {
  const calls: { file: string; args: string[]; options: unknown }[] = [];
  const spawnImpl: SpawnDefaults = (file, args, options) => {
    calls.push({ file, args, options });
    if (refuse) throw new Error('spawn ENOENT');
    const out = new PassThrough();
    const child = Object.assign(new ChildProcess(), { stdin: null, stdout: out, stderr: null,
      stdio: [null, out, null, undefined, undefined] as const });
    out.end(stdout);
    setImmediate(() => child.emit(error ? 'error' : 'close', error ? new Error('killed') : code));
    return child;
  };
  return { spawnImpl, calls };
}

test('without a picked language the CLI follows the system: ru* → ru, anything else → en', () => {
  for (const locale of ['ru-RU', 'ru', 'ru_RU.UTF-8', 'RU']) assert.equal(languageOfLocale(locale), 'ru', locale);
  for (const locale of ['en-US', 'en_GB.UTF-8', 'de-DE', '']) assert.equal(languageOfLocale(locale), 'en', locale);
  assert.equal(languageOfLocale(null), 'en', 'nothing read');
  assert.equal(startLanguage(undefined, 'ru-RU'), 'ru', 'settings.json without a language');
  assert.equal(startLanguage(undefined, 'de-DE'), 'en');
  assert.equal(startLanguage(undefined, null), 'en', 'an unreadable system too');
});

test('the language picked in settings.json beats the system, and the system choice writes nothing', async () => {
  const dir = join(await mkdtemp(join(tmpdir(), 'language-')), 'aures');
  const files = new WatchFiles({ dir });
  // As main starts with no settings.json: the system's language, and no file written for it.
  assert.equal(startLanguage(await files.readLanguage(), 'ru-RU'), 'ru');
  assert.equal(await stat(join(dir, 'settings.json')).then(() => true, error => error.code), 'ENOENT');
  // A pick — written by `aures language` or `l` on the screen — wins over the system.
  await files.writeLanguage('en');
  assert.equal(startLanguage(await files.readLanguage(), 'ru-RU'), 'en');
  // A settings.json that does not read counts as no pick.
  await writeFile(join(dir, 'settings.json'), '[]');
  assert.equal(startLanguage(await files.readLanguage(), 'ru-RU'), 'ru');
});

test('the system language is the first of AppleLanguages, and without it the locale environment', async () => {
  const mac = fakeDefaults({ stdout: '(\n    "ru-RU",\n    "en-RU"\n)\n' });
  assert.equal(await readSystemLanguage({ spawnImpl: mac.spawnImpl, env: {} }), 'ru-RU');
  assert.deepEqual(mac.calls, [{ file: '/usr/bin/defaults', args: ['read', '-g', 'AppleLanguages'],
    options: { stdio: ['ignore', 'pipe', 'ignore'] } }]);

  const none = fakeDefaults({ code: 1 });
  assert.equal(await readSystemLanguage({ spawnImpl: none.spawnImpl, env: { LC_ALL: 'ru_RU.UTF-8' } }), 'ru_RU.UTF-8');
  assert.equal(await readSystemLanguage({ spawnImpl: none.spawnImpl, env: { LC_MESSAGES: 'en_US.UTF-8', LANG: 'ru_RU.UTF-8' } }),
    'en_US.UTF-8');
  assert.equal(await readSystemLanguage({ spawnImpl: none.spawnImpl, env: { LANG: 'ru_RU.UTF-8' } }), 'ru_RU.UTF-8');
  assert.equal(await readSystemLanguage({ spawnImpl: none.spawnImpl, env: {} }), null, 'nothing names a language');
});

test('a defaults that does not answer leaves the language to what still reads', async () => {
  const broken = [fakeDefaults({ refuse: true }), fakeDefaults({ error: true }), fakeDefaults({ stdout: '(\n)\n' })];
  for (const mac of broken) {
    assert.equal(await readSystemLanguage({ spawnImpl: mac.spawnImpl, env: { LANG: 'ru_RU.UTF-8' } }), 'ru_RU.UTF-8');
    assert.equal(await readSystemLanguage({ spawnImpl: mac.spawnImpl, env: {} }), null);
  }
});
