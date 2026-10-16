import { AuthSession } from '../src/auth-session.mjs';
import { FileStateStore } from '../src/state-store.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { authBytes, syntheticGrant } from './auth-fixture.mjs';
import { encodeBundle } from '../src/auth-bundle.mjs';

const [root, cut] = process.argv.slice(2);
const disk = new FileStateStore(join(root, 'state.json'));
const boundary = async name => {
  if (name === cut) {
    process.send({ boundary: name, home });
    await new Promise(() => {});
  }
};
let home;
const store = {
  read: () => disk.read(),
  update: async fn => {
    const answer = await disk.update(fn);
    await boundary(answer.state.auth.phase);
    return answer;
  },
};
const secrets = {
  preflight: async () => {},
  publish: async bundle => {
    await writeFile(join(root, 'snapshot.json'), encodeBundle(bundle), { mode: 0o600 });
    await boundary('secret');
  },
};
const runtime = {
  authBarrierSupported: true,
  open: async path => {
    home = path;
    const handle = {
      closed: false,
      request: async () => {
        await writeFile(join(home, 'auth.json'), authBytes(1), { mode: 0o600 });
        await boundary('rotation');
        return { account: { type: 'chatgpt' } };
      },
      finish: async () => { handle.closed = true; return {
        quiescent: true, refreshSettled: true, saveSucceeded: true, forcedRefreshSucceeded: true,
      }; },
      close: async () => { handle.closed = true; },
    };
    return handle;
  },
};
const snapshot = await readFile(join(root, 'snapshot.json'), 'utf8');
const session = new AuthSession({ store, secrets, runtime, snapshot, grant: syntheticGrant, owner: 'crash-015' });
await session.request('account/read', { refreshToken: true });
