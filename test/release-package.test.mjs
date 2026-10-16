import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, utimes, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'release-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['src', 'scripts', 'test', 'templates', 'schema', 'docs/agents', 'worker']) await mkdir(join(root, dir), { recursive: true });
  for (const file of ['package.json', 'package-lock.json', 'runtime-lock.json']) await cp(new URL(`../${file}`, import.meta.url), join(root, file));
  for (const file of ['LICENSE', 'NOTICES.md', 'README.md', 'README.ru.md', 'CONTEXT.md']) await writeFile(join(root, file), 'fixture\n');
  await cp(new URL('../scripts/release-package.mjs', import.meta.url), join(root, 'scripts/release-package.mjs'));
  await writeFile(join(root, 'src/demo.mjs'), 'export const demo = true;\n');
  const run = (verify = false) => spawnSync(process.execPath, [join(root, 'scripts/release-package.mjs'), ...(verify ? ['--verify'] : [])], { encoding: 'utf8' });
  const manifest = async () => JSON.parse(await readFile(join(root, 'dist/release-manifest.json'), 'utf8'));
  return { root, run, manifest };
}

test('source package reproducibility ignores input timestamps and modes; verify checks saved bytes and input drift', async t => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  const before = await f.manifest();
  await utimes(join(f.root, 'src/demo.mjs'), 123, 456);
  await chmod(join(f.root, 'src/demo.mjs'), 0o600);
  assert.equal(f.run(true).status, 0);
  assert.equal(f.run().status, 0);
  assert.deepEqual(await f.manifest(), before);
  const archive = join(f.root, 'dist', before.name);
  await writeFile(archive, 'tampered archive');
  assert.notEqual(f.run(true).status, 0);
  assert.equal(f.run().status, 0);
  await writeFile(join(f.root, 'src/demo.mjs'), 'export const demo = false;\n');
  assert.notEqual(f.run(true).status, 0);
});

test('source package rejects symlinks, credential files, secret shapes and broken packaged links', async t => {
  const f = await fixture(t);
  await symlink(join(f.root, 'LICENSE'), join(f.root, 'src/linked.mjs'));
  assert.notEqual(f.run().status, 0); await rm(join(f.root, 'src/linked.mjs'));
  await writeFile(join(f.root, 'src/auth.json'), '{}');
  assert.notEqual(f.run().status, 0); await rm(join(f.root, 'src/auth.json'));
  await writeFile(join(f.root, 'README.md'), 'ghp_' + 'x'.repeat(36));
  assert.notEqual(f.run().status, 0);
  await writeFile(join(f.root, 'README.md'), '[missing](outputs/private.md)');
  assert.notEqual(f.run().status, 0);
  await writeFile(join(f.root, 'README.md'), '[source](src/demo.mjs)');
  assert.equal(f.run().status, 0);
  assert.ok(!(await f.manifest()).files.some(f => f.path.startsWith('docs/agents/')));
});
