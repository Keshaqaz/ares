// Single fake HTTP world for the GitHub-only worker: ChatGPT /wham/* and auth.openai.com
// (device flow, refresh token rotation). It is a fetch implementation over a shared clock,
// so tests drive time and the server state together. Never accepts real credentials.
import { USER_AGENT } from '../../src/chatgpt/http.ts';
import type { Fetch } from '../../src/chatgpt/http.ts';
import type { Session } from '../../src/chatgpt/session.ts';

export const ACCESS_LIFETIME_MS = 10 * 24 * 3600 * 1000; // live check 01: exp − iat = 864000 s
// Live check 01 saw a reuse accepted seconds after rotation but did not measure the window;
// 10 s is an assumption.
export const REUSE_GRACE_MS = 10_000;
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const AUTH_CLAIM = 'https://api.openai.com/auth';

// Raw /wham shapes from live check 01. Tests break a reply by putting a value of the wrong
// type into it, so the fields they break take it too.
export interface Credit {
  id: string | number; reset_type: string; is_supported_by_plan: boolean; status: string;
  granted_at: string; expires_at: string | null; redeem_started_at: string | null; redeemed_at: string | null;
  profile_image_url: string; profile_user_id: string; title: string; description: string;
}
export interface Window { used_percent: number | string; limit_window_seconds: number; reset_after_seconds: number; reset_at: number }

export const credit = (id: string | number, expiresAt: number | null, extra: Partial<Credit> = {}): Credit => ({
  id, reset_type: 'codex_rate_limits', is_supported_by_plan: true, status: 'available',
  granted_at: '2026-10-01T00:00:00Z', expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString(),
  redeem_started_at: null, redeemed_at: null, profile_image_url: 'https://example.invalid/p.png',
  profile_user_id: 'user-fake', title: 'Reset', description: 'Fake reset', ...extra,
});
export const window = (seconds: number, usedPercent: number, resetAt: number): Window =>
  ({ used_percent: usedPercent, limit_window_seconds: seconds, reset_after_seconds: 3600, reset_at: Math.floor(resetAt / 1000) });

// A request the world served, with what it read from the body.
export interface SeenRequest {
  host: string; method: string; path: string; userAgent: string | null;
  grant?: string; creditId?: string; key?: string;
}
// A login's tokens on the server; family is 'active' or the code a refresh is rejected with.
export interface FakeSession { access: string | null; refresh: string; family: string }
export interface Redemption { creditId: string; key: string; outcome: string }
// What a broken call answers instead: a status with a JSON body or a text page, or a network error.
export type WhamFailure = { status: number; body?: unknown; text?: string } | 'network';
export type AuthFailure = { status: number | 'network'; body?: unknown };
export type RevokeFailure = { status: number } | 'network';

export interface FakeWorld {
  now: number;
  accountId: string;
  requests: SeenRequest[];
  violations: string[];
  chatgpt: {
    primary: Window | null;
    secondary: Window | null;
    credits: Credit[];
    // For every /wham call.
    fail: WhamFailure | null;
    // POST consume: the code for a fresh key, a real one or not.
    outcome: string;
    // Drops the reply to consume, 'after' the server applied it or 'before'.
    lose: 'before' | 'after' | null;
    // Answers consume with this status without applying.
    consumeFail: { status: number } | null;
    renewsWindows: boolean;
    // Every consume request the server processed.
    redemptions: Redemption[];
  };
  auth: {
    devices: Map<string, { userCode: string; approved: boolean; polls: number }>;
    codes: Map<string, { verifier: string }>;
    refreshes: number;
    fail: AuthFailure | null;
    // Fields dropped from a refresh reply.
    omit: string[];
    // Every login, the latest last.
    sessions: FakeSession[];
    readonly current: FakeSession | null;
    // old refresh token → its rotation
    rotated: Map<string, { at: number; session: FakeSession }>;
    // Refresh tokens revoked through /oauth/revoke.
    revoked: string[];
    // For /oauth/revoke.
    revokeFail: RevokeFailure | null;
  };
  fetch: Fetch;
  advance(ms: number): void;
  login(): Session;
  approve(userCode: string): void;
  revokeAccess(): void;
  endSession(code: string): void;
  refreshCalls(): SeenRequest[];
  consumeCalls(): SeenRequest[];
  spent(): string[];
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: Record<string, unknown>): string => `${encode({ alg: 'none' })}.${encode(claims)}.fake-signature`;
const json = (status: number, value: unknown): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const authError = (status: number, code: string): Response =>
  json(status, { error: { message: code, type: 'invalid_request_error', param: null, code } });

export function fakeWorld({ now = Date.parse('2026-10-20T12:00:00Z'), accountId = 'account-fake' }: { now?: number; accountId?: string } = {}): FakeWorld {
  // The latest session, which the test helpers act on.
  const latest = (): FakeSession => {
    const session = world.auth.current;
    if (!session) throw new Error('fake world: no session');
    return session;
  };
  const world: FakeWorld = {
    now, accountId, requests: [], violations: [],
    // ChatGPT side: raw /wham shapes from live check 01.
    chatgpt: {
      primary: window(18000, 12, now + 3 * 3600_000),
      secondary: window(604800, 40, now + 3 * 24 * 3600_000),
      credits: [credit('reset-a', now + 5 * 24 * 3600_000)],
      fail: null, outcome: 'reset', lose: null, consumeFail: null, renewsWindows: true, redemptions: [],
    },
    // auth.openai.com side.
    // Every login opens its own session, so the worker's and the Mac's live side by side.
    auth: {
      devices: new Map(), codes: new Map(), refreshes: 0, fail: null, omit: [], sessions: [],
      get current() { return this.sessions.at(-1) ?? null; },
      rotated: new Map(), revoked: [], revokeFail: null,
    },
    fetch: async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const method = init.method ?? 'GET';
      const headers = new Headers(init.headers);
      const body = typeof init.body === 'string' ? init.body : init.body?.toString() ?? '';
      const seen: SeenRequest = { host: url.host, method, path: url.pathname, userAgent: headers.get('user-agent') };
      world.requests.push(seen);
      if (headers.get('user-agent') !== USER_AGENT) world.violations.push(`user-agent ${url.pathname}`);
      if (init.redirect !== 'error') world.violations.push(`redirect ${url.pathname}`);
      let reply: Response | null = null;
      if (url.origin === ISSUER && method === 'POST') {
        if (url.pathname === '/oauth/token') reply = await token(seen, body, headers.get('content-type'));
        else if (url.pathname === '/oauth/revoke') reply = await revoke(body, headers.get('content-type'));
        else if (url.pathname === '/api/accounts/deviceauth/usercode') reply = deviceUsercode(JSON.parse(body));
        else if (url.pathname === '/api/accounts/deviceauth/token') reply = devicePoll(JSON.parse(body));
      } else if (url.origin === 'https://chatgpt.com' && url.pathname.startsWith('/backend-api/wham/')) {
        reply = await wham(seen, url.pathname.slice('/backend-api/wham'.length), method, headers, body);
      }
      if (reply) return reply;
      world.violations.push(`${method} ${url.href}`);
      return json(404, {});
    },
    // Test helpers for the world's own state.
    advance: ms => { world.now += ms; },
    login: () => {
      const tokens = mint();
      return { accessToken: tokens.access_token, idToken: tokens.id_token, refreshToken: tokens.refresh_token, accountId: world.accountId };
    },
    approve: userCode => { for (const device of world.auth.devices.values()) if (device.userCode === userCode) device.approved = true; },
    // Both act on the latest session.
    revokeAccess: () => { latest().access = null; },
    endSession: code => { latest().family = code; world.revokeAccess(); },
    refreshCalls: () => world.requests.filter(r => r.path === '/oauth/token' && r.grant === 'refresh_token'),
    consumeCalls: () => world.requests.filter(r => r.path.endsWith('/rate-limit-reset-credits/consume')),
    spent: () => world.chatgpt.redemptions.filter(r => r.outcome === 'reset').map(r => r.creditId),
  };
  let serial = 0;
  // New tokens for this session, or for a new one.
  const mint = (session: FakeSession | null = null) => {
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

  // The client sends strings; the fake reads the fields as they come.
  async function token(seen: SeenRequest, body: string, contentType: string | null): Promise<Response> {
    const data: Record<string, string> = contentType?.startsWith('application/x-www-form-urlencoded') ?
      Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body || '{}');
    seen.grant = data.grant_type;
    if (data.client_id !== CODEX_CLIENT_ID) return authError(400, 'invalid_client');
    if (data.grant_type === 'authorization_code') {
      const grant = world.auth.codes.get(data.code ?? '');
      if (!grant || data.code_verifier !== grant.verifier || data.redirect_uri !== `${ISSUER}/deviceauth/callback`) {
        return json(400, { error: 'invalid_grant' });
      }
      world.auth.codes.delete(data.code ?? '');
      return json(200, mint());
    }
    if (data.grant_type !== 'refresh_token' || !contentType?.startsWith('application/json')) return json(400, { error: 'unsupported_grant_type' });
    if (world.auth.fail) {
      const { status, body: reply } = world.auth.fail;
      if (status === 'network') throw new TypeError('fetch failed');
      return json(status, reply ?? {});
    }
    const rotated = world.auth.rotated.get(data.refresh_token ?? '');
    const session = rotated?.session ?? world.auth.sessions.find(s => s.refresh === data.refresh_token);
    if (!session) return json(400, { error: 'invalid_grant' });
    if (session.family !== 'active') return authError(401, session.family);
    // Live check 01: the server briefly accepts a reused refresh token, then rejects it.
    if (rotated && world.now - rotated.at > REUSE_GRACE_MS) return authError(401, 'refresh_token_reused');
    world.auth.refreshes++;
    if (!rotated) world.auth.rotated.set(data.refresh_token ?? '', { at: world.now, session });
    const reply: Record<string, unknown> = mint(session);
    for (const key of world.auth.omit) delete reply[key];
    return json(200, reply);
  }

  // Live check 01: a refresh after revoking the latest refresh token gets refresh_token_invalidated.
  async function revoke(body: string, contentType: string | null): Promise<Response> {
    if (!contentType?.startsWith('application/json')) return json(400, { error: 'invalid_request' });
    const data: Record<string, unknown> = JSON.parse(body || '{}');
    if (data.client_id !== CODEX_CLIENT_ID) return authError(400, 'invalid_client');
    const { revokeFail } = world.auth;
    if (revokeFail === 'network') throw new TypeError('fetch failed');
    if (revokeFail) return json(revokeFail.status, {});
    if (data.token_type_hint !== 'refresh_token' || typeof data.token !== 'string') return json(400, { error: 'invalid_request' });
    world.auth.revoked.push(data.token);
    const session = world.auth.sessions.find(s => s.refresh === data.token);
    if (session) session.family = 'refresh_token_invalidated';
    return json(200, {});
  }

  function deviceUsercode(data: Record<string, string>): Response {
    if (data.client_id !== CODEX_CLIENT_ID) return json(400, { error: 'invalid_client' });
    const id = `device-${world.auth.devices.size + 1}`;
    const userCode = `FAKE-${1000 + world.auth.devices.size}`;
    world.auth.devices.set(id, { userCode, approved: false, polls: 0 });
    return json(200, { device_auth_id: id, user_code: userCode, interval: '5',
      expires_at: new Date(world.now + 15 * 60_000).toISOString() });
  }
  function devicePoll(data: Record<string, string>): Response {
    const id = data.device_auth_id ?? '';
    const device = world.auth.devices.get(id);
    if (!device || device.userCode !== data.user_code) return json(404, {});
    device.polls++;
    if (!device.approved) return json(403, { error: 'authorization_pending' });
    const code = `fake-code-${id}`;
    const verifier = `fake-verifier-${id}`;
    world.auth.codes.set(code, { verifier });
    world.auth.devices.delete(id);
    return json(200, { status: 'approved', user_code: data.user_code, user_code_expiration: null,
      authorization_code: code, code_challenge: 'fake-challenge', code_verifier: verifier });
  }

  // Backend reply shape from the stock App Server parser: { code, windows_reset }.
  // The server is assumed idempotent by redeem_request_id; live check 10 verifies it.
  async function consume(request: SeenRequest, body: string): Promise<Response> {
    const data: Record<string, unknown> = JSON.parse(body || '{}');
    const { chatgpt } = world;
    const { credit_id: creditId, redeem_request_id: key } = data;
    if (typeof creditId !== 'string' || typeof key !== 'string' || Object.keys(data).length !== 2) {
      world.violations.push('malformed consume');
      return json(400, {});
    }
    request.creditId = creditId;
    request.key = key;
    if (chatgpt.consumeFail) return json(chatgpt.consumeFail.status, { detail: 'fake failure' });
    if (chatgpt.lose === 'before') throw new TypeError('fetch failed');
    const seen = chatgpt.redemptions.find(r => r.key === key);
    if (seen && seen.creditId !== creditId) world.violations.push('key reused for another reset');
    let outcome = seen?.outcome;
    if (!outcome) {
      const row = chatgpt.credits.find(c => c.id === creditId);
      if (row?.status === 'available') outcome = chatgpt.outcome;
      else outcome = row?.status === 'redeemed' ? 'already_redeemed' : 'no_credit';
      if (row && outcome === 'reset') {
        row.status = 'redeemed';
        const renew = (w: Window | null) => w && window(w.limit_window_seconds, 0, world.now + w.limit_window_seconds * 1000);
        if (chatgpt.renewsWindows) [chatgpt.primary, chatgpt.secondary] = [renew(chatgpt.primary), renew(chatgpt.secondary)];
      }
      chatgpt.redemptions.push({ creditId, key, outcome });
    }
    if (chatgpt.lose === 'after') throw new TypeError('fetch failed');
    return json(200, { code: outcome, windows_reset: outcome === 'reset' ? 1 : 0 });
  }

  async function wham(seen: SeenRequest, path: string, method: string, headers: Headers, body: string): Promise<Response | null> {
    const bearer = headers.get('authorization')?.replace(/^Bearer /, '');
    const claims = ((): { exp: number } | null => {
      try { return JSON.parse(Buffer.from(bearer?.split('.')[1] ?? '', 'base64url').toString()); } catch { return null; }
    })();
    if (!bearer || !world.auth.sessions.some(s => s.access === bearer) || !claims || claims.exp * 1000 <= world.now ||
        headers.get('chatgpt-account-id') !== world.accountId) return json(401, { detail: 'Unauthorized' });
    const { fail } = world.chatgpt;
    if (fail === 'network') throw new TypeError('fetch failed');
    if (fail?.text !== undefined) return new Response(fail.text, { status: fail.status });
    if (fail) return json(fail.status, 'body' in fail ? fail.body : { detail: 'fake failure' });
    if (path === '/usage' && method === 'GET') {
      const { primary, secondary, credits } = world.chatgpt;
      const reached = [primary, secondary].some(w => Number(w?.used_percent) >= 100);
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
    if (path === '/rate-limit-reset-credits/consume' && method === 'POST') return consume(seen, body);
    if (path === '/rate-limit-reset-credits' && method === 'GET') {
      const available = world.chatgpt.credits.filter(c => c.status === 'available').length;
      return json(200, { credits: world.chatgpt.credits, available_count: available,
        total_earned_count: world.chatgpt.credits.length, immediate_reset_purchase_eligible: false, history_enabled: true });
    }
    return null;
  }

  return world;
}
