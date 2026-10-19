// Single fake HTTP world for the GitHub-only worker: ChatGPT /wham/* and auth.openai.com
// (device flow, refresh token rotation). It is a fetch implementation over a shared clock,
// so tests drive time and the server state together. Never accepts real credentials.
import { USER_AGENT } from '../../src/chatgpt/http.ts';

export const ACCESS_LIFETIME_MS = 10 * 24 * 3600 * 1000; // live check 01: exp − iat = 864000 s
// Live check 01 saw a reuse accepted seconds after rotation but did not measure the window;
// 10 s is an assumption.
export const REUSE_GRACE_MS = 10_000;
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const AUTH_CLAIM = 'https://api.openai.com/auth';

export const credit = (id, expiresAt, extra = {}) => ({
  id, reset_type: 'codex_rate_limits', is_supported_by_plan: true, status: 'available',
  granted_at: '2026-10-01T00:00:00Z', expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString(),
  redeem_started_at: null, redeemed_at: null, profile_image_url: 'https://example.invalid/p.png',
  profile_user_id: 'user-fake', title: 'Reset', description: 'Fake reset', ...extra,
});
export const window = (seconds, usedPercent, resetAt) =>
  ({ used_percent: usedPercent, limit_window_seconds: seconds, reset_after_seconds: 3600, reset_at: Math.floor(resetAt / 1000) });

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = claims => `${encode({ alg: 'none' })}.${encode(claims)}.fake-signature`;
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const authError = (status, code) => json(status, { error: { message: code, type: 'invalid_request_error', param: null, code } });

export function fakeWorld({ now = Date.parse('2026-10-20T12:00:00Z'), accountId = 'account-fake' } = {}) {
  const world = {
    now, accountId, requests: [], violations: [],
    // ChatGPT side: raw /wham shapes from live check 01.
    chatgpt: {
      primary: window(18000, 12, now + 3 * 3600_000),
      secondary: window(604800, 40, now + 3 * 24 * 3600_000),
      credits: [credit('reset-a', now + 5 * 24 * 3600_000)],
      fail: null, // { status, body? or text? } or 'network' for every /wham call
      // POST consume: outcome for a fresh key, lose drops the reply ('after' the server
      // applied it or 'before'), consumeFail answers { status } without applying.
      outcome: 'reset', lose: null, consumeFail: null, renewsWindows: true,
      redemptions: [], // { creditId, key, outcome } for every request the server processed
    },
    // auth.openai.com side.
    // Every login opens its own session, so the worker's and the Mac's live side by side.
    auth: {
      devices: new Map(), codes: new Map(), refreshes: 0, fail: null, omit: [],
      sessions: [], // { access, refresh, family } of every login, the latest last
      get current() { return this.sessions.at(-1) ?? null; },
      rotated: new Map(), // old refresh token → { at, session } of its rotation
      revoked: [], // refresh tokens revoked through /oauth/revoke
      revokeFail: null, // { status } or 'network' for /oauth/revoke
    },
  };
  let serial = 0;
  // New tokens for this session, or for a new one.
  const mint = (session = null) => {
    serial++;
    const iat = Math.floor(world.now / 1000);
    const auth = { chatgpt_account_id: world.accountId, chatgpt_user_id: 'user-fake', chatgpt_plan_type: 'pro' };
    const tokens = {
      access_token: jwt({ iat, exp: iat + ACCESS_LIFETIME_MS / 1000, serial, [AUTH_CLAIM]: auth }),
      id_token: jwt({ iat, exp: iat + 3600, email: 'fake@example.invalid', serial, [AUTH_CLAIM]: auth }),
      refresh_token: `fake-refresh-${serial}`,
    };
    if (session) Object.assign(session, { access: tokens.access_token, refresh: tokens.refresh_token });
    else world.auth.sessions.push({ access: tokens.access_token, refresh: tokens.refresh_token, family: 'active' });
    return { ...tokens, token_type: 'Bearer', expires_in: ACCESS_LIFETIME_MS / 1000, scope: 'openid profile email offline_access',
      earliest_refresh_at: null };
  };

  // Test helpers for the world's own state.
  world.advance = ms => { world.now += ms; };
  world.login = () => {
    const tokens = mint();
    return { accessToken: tokens.access_token, idToken: tokens.id_token, refreshToken: tokens.refresh_token, accountId: world.accountId };
  };
  world.approve = userCode => { for (const device of world.auth.devices.values()) if (device.userCode === userCode) device.approved = true; };
  // Both act on the latest session.
  world.revokeAccess = () => { world.auth.current.access = null; };
  world.endSession = code => { world.auth.current.family = code; world.revokeAccess(); };
  world.refreshCalls = () => world.requests.filter(r => r.path === '/oauth/token' && r.grant === 'refresh_token');

  world.consumeCalls = () => world.requests.filter(r => r.path.endsWith('/rate-limit-reset-credits/consume'));
  world.spent = () => world.chatgpt.redemptions.filter(r => r.outcome === 'reset').map(r => r.creditId);

  async function token(body, contentType) {
    const data = contentType?.startsWith('application/x-www-form-urlencoded') ?
      Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body || '{}');
    world.requests.at(-1).grant = data.grant_type;
    if (data.client_id !== CODEX_CLIENT_ID) return authError(400, 'invalid_client');
    if (data.grant_type === 'authorization_code') {
      const grant = world.auth.codes.get(data.code);
      if (!grant || data.code_verifier !== grant.verifier || data.redirect_uri !== `${ISSUER}/deviceauth/callback`) {
        return json(400, { error: 'invalid_grant' });
      }
      world.auth.codes.delete(data.code);
      return json(200, mint());
    }
    if (data.grant_type !== 'refresh_token' || !contentType?.startsWith('application/json')) return json(400, { error: 'unsupported_grant_type' });
    if (world.auth.fail) {
      const { status, body: reply } = world.auth.fail;
      return status === 'network' ? Promise.reject(new TypeError('fetch failed')) : json(status, reply ?? {});
    }
    const rotated = world.auth.rotated.get(data.refresh_token);
    const session = rotated?.session ?? world.auth.sessions.find(s => s.refresh === data.refresh_token);
    if (!session) return json(400, { error: 'invalid_grant' });
    if (session.family !== 'active') return authError(401, session.family);
    // Live check 01: the server briefly accepts a reused refresh token, then rejects it.
    if (rotated && world.now - rotated.at > REUSE_GRACE_MS) return authError(401, 'refresh_token_reused');
    world.auth.refreshes++;
    if (!rotated) world.auth.rotated.set(data.refresh_token, { at: world.now, session });
    const reply = mint(session);
    for (const key of world.auth.omit) delete reply[key];
    return json(200, reply);
  }

  // Live check 01: a refresh after revoking the latest refresh token gets refresh_token_invalidated.
  function revoke(body, contentType) {
    if (!contentType?.startsWith('application/json')) return json(400, { error: 'invalid_request' });
    const data = JSON.parse(body || '{}');
    if (data.client_id !== CODEX_CLIENT_ID) return authError(400, 'invalid_client');
    const { revokeFail } = world.auth;
    if (revokeFail === 'network') return Promise.reject(new TypeError('fetch failed'));
    if (revokeFail) return json(revokeFail.status, {});
    if (data.token_type_hint !== 'refresh_token' || typeof data.token !== 'string') return json(400, { error: 'invalid_request' });
    world.auth.revoked.push(data.token);
    const session = world.auth.sessions.find(s => s.refresh === data.token);
    if (session) session.family = 'refresh_token_invalidated';
    return json(200, {});
  }

  function deviceUsercode(data) {
    if (data.client_id !== CODEX_CLIENT_ID) return json(400, { error: 'invalid_client' });
    const id = `device-${world.auth.devices.size + 1}`;
    const userCode = `FAKE-${1000 + world.auth.devices.size}`;
    world.auth.devices.set(id, { userCode, approved: false, polls: 0 });
    return json(200, { device_auth_id: id, user_code: userCode, interval: '5',
      expires_at: new Date(world.now + 15 * 60_000).toISOString() });
  }
  function devicePoll(data) {
    const device = world.auth.devices.get(data.device_auth_id);
    if (!device || device.userCode !== data.user_code) return json(404, {});
    device.polls++;
    if (!device.approved) return json(403, { error: 'authorization_pending' });
    const code = `fake-code-${data.device_auth_id}`;
    const verifier = `fake-verifier-${data.device_auth_id}`;
    world.auth.codes.set(code, { verifier });
    world.auth.devices.delete(data.device_auth_id);
    return json(200, { status: 'approved', user_code: data.user_code, user_code_expiration: null,
      authorization_code: code, code_challenge: 'fake-challenge', code_verifier: verifier });
  }

  // Backend reply shape from the stock App Server parser: { code, windows_reset }.
  // The server is assumed idempotent by redeem_request_id; live check 10 verifies it.
  function consume(body) {
    const data = JSON.parse(body || '{}');
    const { chatgpt } = world;
    if (typeof data.credit_id !== 'string' || typeof data.redeem_request_id !== 'string' || Object.keys(data).length !== 2) {
      world.violations.push('malformed consume');
      return json(400, {});
    }
    world.requests.at(-1).creditId = data.credit_id;
    world.requests.at(-1).key = data.redeem_request_id;
    if (chatgpt.consumeFail) return json(chatgpt.consumeFail.status, { detail: 'fake failure' });
    if (chatgpt.lose === 'before') return Promise.reject(new TypeError('fetch failed'));
    const seen = chatgpt.redemptions.find(r => r.key === data.redeem_request_id);
    if (seen && seen.creditId !== data.credit_id) world.violations.push('key reused for another reset');
    let outcome = seen?.outcome;
    if (!outcome) {
      const row = chatgpt.credits.find(c => c.id === data.credit_id);
      if (row?.status === 'available') outcome = chatgpt.outcome;
      else outcome = row?.status === 'redeemed' ? 'already_redeemed' : 'no_credit';
      if (outcome === 'reset') {
        row.status = 'redeemed';
        const renew = w => w && window(w.limit_window_seconds, 0, world.now + w.limit_window_seconds * 1000);
        if (chatgpt.renewsWindows) [chatgpt.primary, chatgpt.secondary] = [renew(chatgpt.primary), renew(chatgpt.secondary)];
      }
      chatgpt.redemptions.push({ creditId: data.credit_id, key: data.redeem_request_id, outcome });
    }
    if (chatgpt.lose === 'after') return Promise.reject(new TypeError('fetch failed'));
    return json(200, { code: outcome, windows_reset: outcome === 'reset' ? 1 : 0 });
  }

  function wham(path, method, headers, body) {
    const bearer = headers.get('authorization')?.replace(/^Bearer /, '');
    const claims = (() => { try { return JSON.parse(Buffer.from(bearer.split('.')[1], 'base64url')); } catch { return null; } })();
    if (!bearer || !world.auth.sessions.some(s => s.access === bearer) || claims.exp * 1000 <= world.now ||
        headers.get('chatgpt-account-id') !== world.accountId) return json(401, { detail: 'Unauthorized' });
    const { fail } = world.chatgpt;
    if (fail === 'network') return Promise.reject(new TypeError('fetch failed'));
    if (fail?.text !== undefined) return new Response(fail.text, { status: fail.status });
    if (fail) return json(fail.status, 'body' in fail ? fail.body : { detail: 'fake failure' });
    if (path === '/usage' && method === 'GET') {
      const { primary, secondary, credits } = world.chatgpt;
      const reached = [primary, secondary].some(w => w?.used_percent >= 100);
      return json(200, {
        user_id: 'user-fake', account_id: world.accountId, email: 'fake@example.invalid', plan_type: 'pro',
        rate_limit: { allowed: !reached, limit_reached: reached, primary_window: primary, secondary_window: secondary },
        code_review_rate_limit: null, additional_rate_limits: null, model_usage: {},
        credits: { has_credits: false, unlimited: false, overage_limit_reached: false, balance: null,
          approx_local_messages: null, approx_cloud_messages: null },
        spend_control: { reached: false, individual_limit: null },
        rate_limit_reached_type: reached ? { type: 'rate_limit_reached' } : null, promo: null,
        rate_limit_reset_credits: { available_count: credits.filter(c => c.status === 'available').length,
          applicable_available_count: credits.filter(c => c.status === 'available').length },
      });
    }
    if (path === '/rate-limit-reset-credits/consume' && method === 'POST') return consume(body);
    if (path === '/rate-limit-reset-credits' && method === 'GET') {
      const available = world.chatgpt.credits.filter(c => c.status === 'available').length;
      return json(200, { credits: world.chatgpt.credits, available_count: available,
        total_earned_count: world.chatgpt.credits.length, immediate_reset_purchase_eligible: false, history_enabled: true });
    }
    return null;
  }

  world.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : init.body?.toString() ?? '';
    world.requests.push({ host: url.host, method, path: url.pathname, userAgent: headers.get('user-agent') });
    if (headers.get('user-agent') !== USER_AGENT) world.violations.push(`user-agent ${url.pathname}`);
    if (init.redirect !== 'error') world.violations.push(`redirect ${url.pathname}`);
    let reply = null;
    if (url.origin === ISSUER && method === 'POST') {
      if (url.pathname === '/oauth/token') reply = await token(body, headers.get('content-type'));
      else if (url.pathname === '/oauth/revoke') reply = await revoke(body, headers.get('content-type'));
      else if (url.pathname === '/api/accounts/deviceauth/usercode') reply = deviceUsercode(JSON.parse(body));
      else if (url.pathname === '/api/accounts/deviceauth/token') reply = devicePoll(JSON.parse(body));
    } else if (url.origin === 'https://chatgpt.com' && url.pathname.startsWith('/backend-api/wham/')) {
      reply = await wham(url.pathname.slice('/backend-api/wham'.length), method, headers, body);
    }
    if (reply) return reply;
    world.violations.push(`${method} ${url.href}`);
    return json(404, {});
  };
  return world;
}
