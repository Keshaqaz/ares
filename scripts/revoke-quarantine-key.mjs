// Offline key preparation, future execution only. Never place private key in repo/artifacts.
import sodium from 'libsodium-wrappers';
import { mkdir, open, lstat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
try {
  const directory = process.argv[2];
  if (process.argv.length !== 3 || !isAbsolute(directory ?? '')) throw new Error();
  await mkdir(directory, { mode: 0o700 }); // fail if it already exists; never overwrite keys
  if ((await lstat(directory)).mode & 0o077) throw new Error();
  await sodium.ready;
  const keys = sodium.crypto_box_keypair();
  for (const [name, value] of [['private.key', keys.privateKey], ['public.key', keys.publicKey]]) {
    const f = await open(join(directory, name), 'wx', 0o600);
    try { await f.writeFile(Buffer.from(value).toString('base64')); await f.sync(); } finally { await f.close(); }
  }
  const d = await open(directory, 'r'); try { await d.sync(); } finally { await d.close(); }
  keys.privateKey.fill(0);
  process.stdout.write('quarantine_key_prepared\n');
} catch { process.stdout.write('quarantine_key_preparation_failed\n'); process.exitCode = 1; }
