#!/usr/bin/env node
// Fixed source allowlist, canonical ustar metadata, and verification of the saved
// artifact. Source bytes are read once for both hashes and archive contents.
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile, lstat, mkdir } from 'node:fs/promises';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const args = process.argv.slice(2);
if (args.length > 1 || args.some(a => a !== '--verify')) throw new Error('usage: node scripts/release-package.mjs [--verify]');
const verify = args.includes('--verify');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'runtime-lock.json'), 'utf8'));
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(pkg.version)) throw new Error('invalid package version');
const allow = ['package.json', 'package-lock.json', 'runtime-lock.json', 'LICENSE',
  'README.md', 'src', 'scripts', 'test', 'templates', 'docs', 'worker'];
const noise = n => n === '.DS_Store' || n.startsWith('._');
const blocked = n => n.startsWith('.') || /^(auth|state|credentials?|tokens?|logs?|cache)([.-]|$)/i.test(n) && !n.endsWith('.mjs') && !n.endsWith('.md');
async function walk(entry) {
  const info = await lstat(join(root, entry));
  if (info.isSymbolicLink()) throw new Error(`symbolic link in release input: ${entry}`);
  if (info.isFile()) return [entry];
  if (!info.isDirectory()) throw new Error(`special file in release input: ${entry}`);
  const files = [];
  for (const name of (await readdir(join(root, entry))).sort()) {
    if (noise(name) || `${entry}/${name}` === 'docs/agents') continue;
    if (blocked(name) || /[\r\n\\]/.test(name)) throw new Error(`unexpected release input: ${entry}/${name}`);
    files.push(...await walk(`${entry}/${name}`));
  }
  return files;
}
const files = (await Promise.all(allow.map(walk))).flat().sort();
const sha256 = data => createHash('sha256').update(data).digest('hex');
const patterns = [
  [/ghp_[A-Za-z0-9]{36}/, 'GitHub classic PAT'],
  [/github_pat_[A-Za-z0-9_]{22,}/, 'GitHub fine-grained PAT'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
  [/sk-[A-Za-z0-9]{20,}/, 'API token'],
];
const inputs = await Promise.all(files.map(async path => {
  const data = await readFile(join(root, path));
  for (const [pattern, label] of patterns) if (pattern.test(data.toString('utf8'))) throw new Error(`${label} in ${path}`);
  return { path, data, mode: path.endsWith('.sh') || data.subarray(0, 2).toString() === '#!' ? 0o755 : 0o644 };
}));
const included = new Set(files);
for (const { path, data } of inputs.filter(f => f.path.endsWith('.md'))) {
  for (const match of data.toString('utf8').matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(path), target));
    if (!included.has(resolved)) throw new Error(`missing packaged link: ${path} -> ${target}`);
  }
}
function header({ path, data, mode }) {
  const h = Buffer.alloc(512);
  const string = (s, offset, length) => {
    if (Buffer.byteLength(s) > length) throw new Error(`ustar field too long: ${path}`);
    h.write(s, offset, length, 'utf8');
  };
  const octal = (n, offset, length) => string(n.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  let name = path, prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const split = path.lastIndexOf('/');
    if (split < 0) throw new Error(`ustar name too long: ${path}`);
    prefix = path.slice(0, split); name = path.slice(split + 1);
  }
  string(name, 0, 100); octal(mode, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
  octal(data.length, 124, 12); octal(0, 136, 12); h.fill(32, 148, 156);
  string('0', 156, 1); string('ustar\0', 257, 6); string('00', 263, 2); string(prefix, 345, 155);
  const sum = h.reduce((n, b) => n + b, 0);
  string(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
const archive = Buffer.concat([...inputs.flatMap(f => [header(f), f.data, Buffer.alloc((512 - f.data.length % 512) % 512)]), Buffer.alloc(1024)]);
const name = `auto-reset-src-${pkg.version}.tar`;
const entries = inputs.map(({ path, data, mode }) => ({ path, sha256: sha256(data), bytes: data.length, mode }));
const manifest = { schema: 2, name, version: pkg.version, generatedBy: 'scripts/release-package.mjs',
  reproduction: 'node scripts/release-package.mjs --verify', format: 'ustar; mtime/uid/gid=0; sorted paths; normalized modes',
  pins: { node: lock.node, appServer: lock.appServer.version, appServerCommit: lock.appServer.commit,
    protocol: 2, dependencies: lock.dependencies }, archiveSha256: sha256(archive), files: entries };
await mkdir(dist, { recursive: true });
if (verify) {
  const saved = JSON.parse(await readFile(join(dist, 'release-manifest.json'), 'utf8'));
  if (JSON.stringify(saved) !== JSON.stringify(manifest)) throw new Error('input/pins/archive drifted from saved manifest');
  if (sha256(await readFile(join(dist, name))) !== manifest.archiveSha256) throw new Error('saved archive bytes differ from manifest');
  console.log(`verify ok: ${name} ${manifest.archiveSha256} (${entries.length} files)`);
} else {
  await writeFile(join(dist, name), archive);
  await writeFile(join(dist, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`built ${name} ${manifest.archiveSha256} (${entries.length} files); packaged links and secret scan passed`);
}
