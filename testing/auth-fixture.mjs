import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStateStore, initialState } from '../src/state-store.mjs';
import { makeBundle, readyAuth, encodeBundle, AuthFailure } from '../src/auth-bundle.mjs';
import { AuthSession } from '../src/auth-session.mjs';
import { jwt, syntheticAccountId } from './fake-backend.mjs';

export const syntheticGrant = 'synthetic-PAT-never-a-real-grant-015';
export function authBytes(generation = 0) {
  return Buffer.from(JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { access_token: jwt(generation), id_token: jwt(generation),
      refresh_token: `synthetic-refresh-${generation}`, account_id: syntheticAccountId },
    last_refresh: `2026-10-08T00:00:0${generation}.000Z` }));
}

// These are process/storage adapters exercising the real session protocol and disk
// state. They are not OAuth or a proof of the official runtime's auth barrier.
export async function authFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'auth-015-test-'));
  const disk = new FileStateStore(join(root, 'state.json'));
  const initial = makeBundle(authBytes());
  const state = initialState();
  state.auth = readyAuth(initial, syntheticGrant);
  await disk.persist(state);
  const world = { root, disk, initial, secret: initial, events: [], grantValid: true, stateWritable: true,
    rotate: true, authValid: true, barrier: { quiescent: true, refreshSettled: true,
      saveSucceeded: true, forcedRefreshSucceeded: true }, hook: async () => {} };
  t?.after(() => rm(root, { recursive: true, force: true }));
  const emit = async name => { world.events.push(name); await world.hook(name); };
  world.store = {
    read: async () => { await emit('state.read_latest'); return disk.read(); },
    update: async fn => {
      if (!world.stateWritable) throw new AuthFailure('state_write_failed');
      const answer = await disk.update(fn);
      await emit(answer.state.auth?.phase === 'inflight' ? 'state.intent_durable' :
        answer.state.auth?.phase === 'publishing' ? 'state.target_durable' : 'state.ready_durable');
      return answer;
    },
  };
  world.secrets = {
    preflight: async () => { await emit('grant.preflight'); if (!world.grantValid) throw new AuthFailure('stop_grant'); },
    publish: async bundle => {
      if (!world.grantValid) throw new AuthFailure('stop_grant');
      if (world.putAccepted !== false) world.secret = bundle;
      await emit('secret.put');
      if (world.putLost) throw new AuthFailure('storage_unconfirmed');
      await emit('secret.put_confirmed');
    },
  };
  world.runtime = {
    authBarrierSupported: true,
    open: async home => {
      world.home = home;
      await emit('auth.process_start');
      const admitted = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8'));
      const generation = Number(admitted.tokens.refresh_token.split('-').at(-1)) + 1;
      const handle = {
        closed: false,
        request: async method => {
          await emit('account.rpc');
          if (!world.authValid) throw new Error('synthetic-secret-error-that-must-be-sanitized');
          if (world.rotate) {
            await writeFile(join(home, 'auth.json'), world.bytes ?? authBytes(generation), { mode: 0o600 });
            await emit('auth.rotation_completed_locally');
          }
          return method.endsWith('/consume') ? { outcome: 'reset' } : { account: { type: 'chatgpt', email: 'synthetic@example.invalid' } };
        },
        finish: async () => { handle.closed = true; await emit('auth.barrier'); return world.barrier; },
        close: async () => { handle.closed = true; await emit('auth.closed'); },
      };
      return handle;
    },
  };
  world.session = (bundle = world.secret, runtime = world.runtime, grant = syntheticGrant) => new AuthSession({
    store: world.store, secrets: world.secrets, runtime, snapshot: encodeBundle(bundle), grant, owner: 'run-015',
  });
  return world;
}
