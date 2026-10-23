import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { archiveName, formula, packRelease, releaseUrl } from '../scripts/release-brew.ts';
import { agentProgram } from '../src/cli/launch-agent.ts';
import pkg from '../package.json' with { type: 'json' };

const run = promisify(execFile);
const MAIN = new URL('../src/cli/main.ts', import.meta.url).pathname;

test('--version prints the package version on any platform', async () => {
  const { stdout } = await run(process.execPath, [MAIN, '--version']);
  assert.equal(stdout, `${pkg.version}\n`);
});

test('the formula installs the release archive behind a node wrapper and tests --version', () => {
  const sha256 = 'a'.repeat(64);
  const text = formula({ version: '1.2.3', sha256 });
  assert.equal(releaseUrl('1.2.3'), 'https://github.com/Keshaqaz/aures/releases/download/v1.2.3/aures-1.2.3.tgz');
  assert.match(text, /^class Aures < Formula$/m);
  // `brew audit --strict`: the description names neither platform alone, stays within
  // 80 characters and starts with neither the formula's name nor an article.
  const desc = text.match(/^  desc "(.+)"$/m)?.[1] ?? '';
  assert.equal(desc, 'Applies ChatGPT Codex resets from your own GitHub or Google Apps Script worker');
  assert.ok(desc.length <= 80, `desc is ${desc.length} characters, over the 80 of brew audit --strict`);
  assert.doesNotMatch(desc, /^(aures|a|an|the)\b/i);
  assert.match(text, new RegExp(`^  url "${releaseUrl('1.2.3')}"$`, 'm'));
  assert.match(text, new RegExp(`^  sha256 "${sha256}"$`, 'm'));
  assert.match(text, /^  license "MIT"$/m);
  assert.match(text, /^  depends_on "node"$/m);
  assert.match(text, /formula_opt_bin\("node"\)}\/node" "#\{libexec}\/src\/cli\/main\.ts" "\$@"/);
  assert.match(text, /assert_equal version\.to_s, shell_output\("#\{bin}\/aures --version"\)\.strip/);
  assert.throws(() => formula({ version: '1.2', sha256 }), RangeError);
  assert.throws(() => formula({ version: '1.2.3', sha256: 'abc' }), RangeError);
});

test('the launchd agent recognizes a keg laid out by the formula and runs it through the opt link', () => {
  const text = formula({ version: '1.2.3', sha256: 'a'.repeat(64) });
  const [, bin] = text.match(/\(bin\/"([^"]+)"\)\.write/) ?? [];
  const [, main] = text.match(/"#\{libexec}\/([^"]+)" "\$@"/) ?? [];
  const keg = '/opt/homebrew/Cellar/aures/1.2.3';
  assert.deepEqual(agentProgram({ main: `${keg}/libexec/${main}`, node: '/opt/homebrew/opt/node/bin/node' }),
    [`/opt/homebrew/opt/aures/bin/${bin}`, 'watch']);
});

test('the release archive carries the CLI, both worker bundles and its dependencies, and runs on its own', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'brew-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { file, sha256 } = await packRelease(dir);
  assert.equal(file, join(dir, archiveName(pkg.version)));
  assert.equal(sha256, createHash('sha256').update(await readFile(file)).digest('hex'));

  await run('tar', ['-xzf', file, '-C', dir]);
  const root = join(dir, 'package');
  assert.deepEqual((await readdir(root)).sort(), ['LICENSE', 'README.md', 'dist', 'node_modules', 'package.json', 'src']);
  assert.deepEqual((await readdir(join(root, 'dist'))).sort(), ['apps-script', 'worker.mjs']);
  assert.deepEqual(await readdir(join(root, 'dist/apps-script')), ['worker.js']);
  assert.deepEqual((await readdir(join(root, 'node_modules'))).sort(), ['libsodium', 'libsodium-wrappers']);
  assert.ok((await stat(join(root, 'src/cli/main.ts'))).isFile());

  // Outside the checkout there is no node_modules up the tree: the archive brings its own.
  const { stdout } = await run(process.execPath, [join(root, 'src/cli/main.ts'), '--version'], { cwd: dir });
  assert.equal(stdout, `${pkg.version}\n`);
});
