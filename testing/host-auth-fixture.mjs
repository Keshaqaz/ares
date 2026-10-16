import { join } from 'node:path';
import { authFixture, syntheticGrant } from './auth-fixture.mjs';
import { jwt, syntheticAccountId } from './fake-backend.mjs';
import { AuthFailure, makeBundle, readyAuth, encodeBundle } from '../src/auth-bundle.mjs';
import { HostOAuth, LocalAuthVault } from '../src/host-oauth.mjs';
import { HostAuthSession } from '../src/host-auth-session.mjs';
import { CycleEngine } from '../src/reset-cycles.mjs';
import { AccountAdapter } from '../src/account.mjs';
import { MockRpc } from './mock-rpc.mjs';

export const NOW = 1791417600;
export function hostBytes(generation = 0, { accountId = syntheticAccountId, userId = 'user-synthetic',
  exp = NOW + (generation ? 3600 : 60) } = {}) {
  const parts = jwt(generation).split('.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  claims.exp = exp;
  claims['https://api.openai.com/auth'].chatgpt_account_id = accountId;
  claims['https://api.openai.com/auth'].chatgpt_user_id = userId;
  parts[1] = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = parts.join('.');
  return Buffer.from(JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { access_token: token, id_token: token, refresh_token: `synthetic-refresh-${generation}`, account_id: accountId },
    last_refresh: new Date(NOW * 1000).toISOString() }));
}
export async function hostFixture(t) {
  const w = await authFixture(t);
  w.initial = makeBundle(hostBytes(), { protocol: 2 }); w.secret = w.initial;
  await w.disk.update(s => { s.auth = readyAuth(w.initial, syntheticGrant); });
  w.events = []; w.clock = NOW; w.refreshes = 0;
  w.emit = async e => { w.events.push(e); await w.hook(e); };
  w.serialization = { assertOwner: async () => { if (w.writerLost) throw new Error(); } };
  w.oauth = new HostOAuth({ now: () => w.clock, fetchImpl: async (url, options) => {
    const data = JSON.parse(options.body);
    if (data.client_id !== 'app_EMoamEEZ73f0CkXaXp7hrann' || data.grant_type !== 'refresh_token' ||
        data.refresh_token !== JSON.parse(Buffer.from(w.secret.authBase64, 'base64')).tokens.refresh_token) throw new Error();
    w.refreshes++; await w.emit('oauth.rotation');
    if (w.responseLost) throw new Error('synthetic-refresh-leak');
    const tokens = JSON.parse(hostBytes(w.refreshes, w.identity)).tokens;
    const body = w.oauthBody ?? { access_token: tokens.access_token, id_token: tokens.id_token, refresh_token: tokens.refresh_token };
    return { status: w.oauthStatus ?? 200, text: async () => w.malformed ? '{broken' : JSON.stringify(body) };
  } });
  w.localVault = new LocalAuthVault(join(w.root, 'credentials', 'target.json'));
  w.vault = { save: async record => {
    await w.emit('local.before_save');
    if (w.localFailed) throw new AuthFailure('local_auth_save_failed');
    await w.localVault.save(record); await w.emit('local.saved');
  }, read: () => w.localVault.read() };
  w.external = { open: async tokens => {
    if (Object.keys(tokens).some(key => !['accessToken', 'chatgptAccountId', 'chatgptPlanType'].includes(key))) throw new Error();
    w.childTokens = tokens; await w.emit('child.login');
    const handle = { closed: false,
      request: async () => { await w.emit('account.rpc'); if (w.rpcFailed) throw new Error('synthetic-secret-error'); return { account: { type: 'chatgpt' } }; },
      close: async () => { await w.emit('child.closed'); handle.closed = !w.cleanupFailed; } };
    return handle;
  } };
  w.host = (snapshot = w.secret, extra = {}) => new HostAuthSession({ store: w.store, secrets: w.secrets,
    serialization: w.serialization, oauth: w.oauth, vault: w.vault, runtime: w.external,
    snapshot: encodeBundle(snapshot), grant: syntheticGrant, owner: 'host-023', now: () => w.clock, ...extra });
  return w;
}

export async function addHistory(w) {
  await w.disk.update(s => { s.settings.weeklyAutoReset = true; });
  const rpc = new MockRpc();
  const engine = new CycleEngine(w.disk, new AccountAdapter(rpc, { now: () => NOW }), { now: () => NOW });
  for (const [id, loss] of [['applied-023', false], ['unknown-023', true]]) {
    const interval = loss ? 3660 : 3600;
    rpc.state.rows = [{ id, reset_type: 'codex_rate_limits', status: 'available',
      granted_at: '2026-10-01T00:00:00Z', expires_at: new Date((NOW + interval) * 1000).toISOString(), title: null, description: null }];
    rpc.state.count = 1; rpc.state.outcome = 'reset'; rpc.state.loss = loss;
    await engine.command({ action: 'select', creditId: id, deltaSeconds: interval,
      commandId: `command-${id}`, expectedVersion: (await w.disk.read()).version });
    await engine.run(id);
  }
  return w.disk.read();
}
