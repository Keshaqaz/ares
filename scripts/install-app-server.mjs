import { readFile, mkdir, mkdtemp, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pins = JSON.parse(await readFile(new URL('../src/runtime-lock.json', import.meta.url), 'utf8'));
if (process.version !== `v${pins.node}`) throw new Error('node_version_mismatch');
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('installer_requires_linux_x64');
const target = resolve('.runtime/codex');
const source = pins.appServer.linuxX64;
const temp = await mkdtemp(join(tmpdir(), 'auto-reset-install-'));
try {
  const response = await fetch(source.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error('download_failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('checksum_mismatch');
  const archive = join(temp, 'codex.tar.gz');
  await writeFile(archive, bytes);
  const exec = promisify(execFile);
  // Official archive has a single executable. Extraction is restricted to that exact member.
  await exec('tar', ['-xzf', archive, '-C', temp, 'codex-x86_64-unknown-linux-musl']);
  const executable = join(temp, 'codex-x86_64-unknown-linux-musl');
  await chmod(executable, 0o755);
  const version = await exec(executable, ['--version'], { timeout: 5000 });
  if (version.stdout.trim() !== `codex-cli ${pins.appServer.version}`) throw new Error('binary_version_mismatch');
  await mkdir(resolve('.runtime'), { recursive: true });
  // Copy through a file on the target filesystem for atomic rename across /tmp mounts.
  await writeFile(`${target}.new`, await readFile(executable), { mode: 0o755 });
  await rename(`${target}.new`, target);
  console.log(JSON.stringify({ installed: target, version: pins.appServer.version, sha256: source.sha256 }));
} finally { await rm(temp, { recursive: true, force: true }); }
