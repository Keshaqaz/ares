import { readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { FileStateStore } from '../../src/core/state-store.mjs';
import { HostAuthSession } from '../../src/session/host-auth-session.mjs';
import { HostOAuth, LocalAuthVault } from '../../src/session/host-oauth.mjs';
import { encodeBundle } from '../../src/session/auth-bundle.mjs';
import { hostBytes, NOW } from './host-auth-fixture.mjs';
import { syntheticGrant } from './auth-fixture.mjs';

const [root, cut] = process.argv.slice(2);
const disk = new FileStateStore(join(root, 'state.json'));
const halt = async event => {
  if (cut !== event) return;
  process.send({ event });
  await new Promise(() => {});
};
const store = { read: () => disk.read(), update: async fn => {
  const result = await disk.update(fn);
  await halt(result.state.auth.phase); return result;
} };
const oauth = new HostOAuth({ now: () => NOW, fetchImpl: async () => {
  await halt('rotation');
  return { status: 200, text: async () => JSON.stringify(JSON.parse(hostBytes(1)).tokens) };
} });
const vault = new LocalAuthVault(join(root, 'credentials', 'target.json'));
const session = new HostAuthSession({ store, oauth, serialization: { assertOwner: async () => {} },
  snapshot: await readFile(join(root, 'snapshot.json'), 'utf8'), grant: syntheticGrant, owner: 'killed-023', now: () => NOW,
  vault: { save: async record => { await vault.save(record); await halt('local'); }, read: () => vault.read() },
  secrets: { preflight: async () => {}, publish: async bundle => {
    const file = await open(join(root, 'snapshot.json'), 'w', 0o600);
    try { await file.writeFile(encodeBundle(bundle)); await file.sync(); } finally { await file.close(); }
    await halt('secret');
  } }, runtime: { open: async () => { throw new Error('unexpected_child'); } } });
await session.service({ force: true });
process.exitCode = 2; // Every selected cut must have stopped before completion.
