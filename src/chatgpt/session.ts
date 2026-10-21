import { request, claims, object, asObject, SessionLost, TransientFailure } from './http.ts';
import type { Fetch, Reply } from './http.ts';

export const ISSUER = 'https://auth.openai.com';
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
// Refresh only when the access token would not outlive this tick: each refresh rotates
// the refresh token, and a crash before the commit loses the session.
export const REFRESH_MARGIN_MS = 10 * 60_000;
const LOST_CODES = ['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'] as const;
const TOKENS = { access_token: 'accessToken', id_token: 'idToken', refresh_token: 'refreshToken' } as const;

export const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60_000;

// A ChatGPT sign-in of the Codex client: the worker's or the Mac's.
export interface Session { accessToken: string; idToken: string; refreshToken: string; accountId: string }

export type LoginFailedReason = 'timeout' | 'no_account' | `usercode_${number}` | `poll_${number}` | `exchange_${number}`;

export class LoginFailed extends Error {
  reason: LoginFailedReason;
  constructor(reason: LoginFailedReason) { super(reason); this.reason = reason; }
}

export interface DeviceCode { userCode: string; verificationUrl: string }
export interface DeviceLoginOptions {
  fetch: Fetch;
  onCode: (code: DeviceCode) => unknown;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}

const isLostCode = (code: unknown): code is typeof LOST_CODES[number] => LOST_CODES.some(lost => lost === code);

// Device-code login for `setup` and `login`: the user enters onCode's userCode at
// verificationUrl while we poll. Returns a fresh worker session.
export async function deviceLogin({ fetch, onCode, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now }:
  DeviceLoginOptions): Promise<Session> {
  const json = { 'content-type': 'application/json' };
  const issued = await request(fetch, `${ISSUER}/api/accounts/deviceauth/usercode`,
    { method: 'POST', headers: json, body: JSON.stringify({ client_id: CODEX_CLIENT_ID }) });
  const device = asObject(issued.value);
  const userCode = device?.user_code ?? device?.usercode;
  if (issued.status !== 200 || typeof device?.device_auth_id !== 'string' || typeof userCode !== 'string') {
    throw new LoginFailed(`usercode_${issued.status}`);
  }
  const deviceAuthId = device.device_auth_id;
  await onCode({ userCode, verificationUrl: `${ISSUER}/codex/device` });
  const interval = Math.max(1, Number(device.interval) || 5) * 1000;
  const deadline = now() + DEVICE_LOGIN_TIMEOUT_MS;
  let grant = null;
  while (!grant) {
    if (now() >= deadline) throw new LoginFailed('timeout');
    await sleep(Math.min(interval, Math.max(0, deadline - now())));
    let poll: Reply;
    try {
      poll = await request(fetch, `${ISSUER}/api/accounts/deviceauth/token`, { method: 'POST', headers: json,
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }) });
    } catch (error) {
      if (error instanceof TransientFailure) continue; // one lost poll should not end the login
      throw error;
    }
    // 403/404: the user has not entered the code yet.
    if (poll.status === 403 || poll.status === 404) continue;
    const value = asObject(poll.value);
    if (poll.status !== 200 || typeof value?.authorization_code !== 'string' ||
        typeof value.code_verifier !== 'string') throw new LoginFailed(`poll_${poll.status}`);
    grant = { authorization_code: value.authorization_code, code_verifier: value.code_verifier };
  }
  // The server holds the PKCE pair and returns the verifier with the code.
  const exchange = await request(fetch, `${ISSUER}/oauth/token`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: grant.authorization_code,
      redirect_uri: `${ISSUER}/deviceauth/callback`, client_id: CODEX_CLIENT_ID, code_verifier: grant.code_verifier }).toString() });
  const tokens = asObject(exchange.value);
  const { access_token, id_token, refresh_token } = tokens ?? {};
  if (exchange.status !== 200 || typeof access_token !== 'string' || !access_token || typeof id_token !== 'string' || !id_token ||
      typeof refresh_token !== 'string' || !refresh_token) {
    throw new LoginFailed(`exchange_${exchange.status}`);
  }
  const accountId = asObject(asObject(claims(id_token))?.['https://api.openai.com/auth'])?.chatgpt_account_id;
  if (typeof accountId !== 'string' || !accountId) throw new LoginFailed('no_account');
  return { accessToken: access_token, idToken: id_token, refreshToken: refresh_token, accountId };
}

// The email of the ChatGPT account a session is of, from its id_token: at the top or in the
// profile claim. null when the token names none. The CLI shows it; the worker never keeps it.
export function sessionEmail({ idToken }: Pick<Session, 'idToken'>): string | null {
  const token = asObject(claims(idToken));
  const email = token?.email ?? asObject(token?.['https://api.openai.com/profile'])?.email;
  return typeof email === 'string' && email ? email : null;
}

export function needsRefresh(session: Session, now: number): boolean {
  const exp = asObject(claims(session.accessToken))?.exp;
  return typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp * 1000 - now <= REFRESH_MARGIN_MS;
}

// Rotates the refresh token. Fields missing from the reply keep their previous values.
export async function refresh(fetch: Fetch, session: Session): Promise<Session> {
  const { status, value } = await request(fetch, `${ISSUER}/oauth/token`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: session.refreshToken }) });
  const error = asObject(value)?.error;
  const code = asObject(error)?.code ?? error;
  if (status === 401 || isLostCode(code) || status === 400 && code === 'invalid_grant') {
    throw new SessionLost(isLostCode(code) ? code : status === 401 ? 'unauthorized' : 'invalid_grant');
  }
  if (status !== 200 || !value || typeof value !== 'object') throw new TransientFailure(`refresh_${status}`);
  const reply = asObject(value) ?? {}; // an array has none of the token fields
  const next = { ...session };
  for (const [field, key] of Object.entries(TOKENS)) {
    const token = reply[field];
    if (token == null) continue;
    if (typeof token !== 'string' || !token) throw new TransientFailure('refresh_invalid_reply');
    next[key] = token;
  }
  return next;
}

// Revokes the worker session's refresh token before uninstall (live check 01: a refresh after
// it gets 401 refresh_token_invalidated). Throws TransientFailure unless OpenAI confirms it.
export async function revoke(fetch: Fetch, session: Session): Promise<void> {
  const { status } = await request(fetch, `${ISSUER}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID, token_type_hint: 'refresh_token', token: session.refreshToken }) });
  if (status !== 200) throw new TransientFailure(`revoke_${status}`);
}
