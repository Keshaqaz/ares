import { request, claims, SessionLost, TransientFailure } from './http.mjs';

export const ISSUER = 'https://auth.openai.com';
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
// Refresh only when the access token would not outlive this tick: each refresh rotates
// the refresh token, and a crash before the commit loses the session.
export const REFRESH_MARGIN_MS = 10 * 60_000;
const LOST_CODES = ['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'];
const TOKENS = { access_token: 'accessToken', id_token: 'idToken', refresh_token: 'refreshToken' };

export const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60_000;

export class LoginFailed extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

// Device-code login for `setup` and `login`: the user enters onCode's userCode at
// verificationUrl while we poll. Returns a fresh worker session.
export async function deviceLogin({ fetch, onCode, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now }) {
  const json = { 'content-type': 'application/json' };
  const issued = await request(fetch, `${ISSUER}/api/accounts/deviceauth/usercode`,
    { method: 'POST', headers: json, body: JSON.stringify({ client_id: CODEX_CLIENT_ID }) });
  const device = issued.value;
  const userCode = device?.user_code ?? device?.usercode;
  if (issued.status !== 200 || typeof device?.device_auth_id !== 'string' || typeof userCode !== 'string') {
    throw new LoginFailed(`usercode_${issued.status}`);
  }
  await onCode({ userCode, verificationUrl: `${ISSUER}/codex/device` });
  const interval = Math.max(1, Number(device.interval) || 5) * 1000;
  const deadline = now() + DEVICE_LOGIN_TIMEOUT_MS;
  let grant = null;
  while (!grant) {
    if (now() >= deadline) throw new LoginFailed('timeout');
    await sleep(Math.min(interval, Math.max(0, deadline - now())));
    let poll;
    try {
      poll = await request(fetch, `${ISSUER}/api/accounts/deviceauth/token`, { method: 'POST', headers: json,
        body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: userCode }) });
    } catch (error) {
      if (error instanceof TransientFailure) continue; // one lost poll should not end the login
      throw error;
    }
    // 403/404: the user has not entered the code yet.
    if (poll.status === 403 || poll.status === 404) continue;
    if (poll.status !== 200 || typeof poll.value?.authorization_code !== 'string' ||
        typeof poll.value.code_verifier !== 'string') throw new LoginFailed(`poll_${poll.status}`);
    grant = poll.value;
  }
  // The server holds the PKCE pair and returns the verifier with the code.
  const exchange = await request(fetch, `${ISSUER}/oauth/token`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: grant.authorization_code,
      redirect_uri: `${ISSUER}/deviceauth/callback`, client_id: CODEX_CLIENT_ID, code_verifier: grant.code_verifier }).toString() });
  const tokens = exchange.value;
  if (exchange.status !== 200 || !Object.keys(TOKENS).every(key => typeof tokens?.[key] === 'string' && tokens[key])) {
    throw new LoginFailed(`exchange_${exchange.status}`);
  }
  const accountId = claims(tokens.id_token)?.['https://api.openai.com/auth']?.chatgpt_account_id;
  if (typeof accountId !== 'string' || !accountId) throw new LoginFailed('no_account');
  return { accessToken: tokens.access_token, idToken: tokens.id_token, refreshToken: tokens.refresh_token, accountId };
}

export function needsRefresh(session, now) {
  const exp = claims(session.accessToken)?.exp;
  return !Number.isSafeInteger(exp) || exp * 1000 - now <= REFRESH_MARGIN_MS;
}

// Rotates the refresh token. Fields missing from the reply keep their previous values.
export async function refresh(fetch, session) {
  const { status, value } = await request(fetch, `${ISSUER}/oauth/token`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: 'refresh_token', refresh_token: session.refreshToken }) });
  const code = value?.error?.code ?? value?.error;
  if (status === 401 || LOST_CODES.includes(code) || status === 400 && code === 'invalid_grant') {
    throw new SessionLost(LOST_CODES.includes(code) ? code : status === 401 ? 'unauthorized' : 'invalid_grant');
  }
  if (status !== 200 || !value || typeof value !== 'object') throw new TransientFailure(`refresh_${status}`);
  const next = { ...session };
  for (const [field, key] of Object.entries(TOKENS)) {
    if (value[field] == null) continue;
    if (typeof value[field] !== 'string' || !value[field]) throw new TransientFailure('refresh_invalid_reply');
    next[key] = value[field];
  }
  return next;
}

// Revokes the worker session's refresh token before uninstall (live check 01: a refresh after
// it gets 401 refresh_token_invalidated). Throws TransientFailure unless OpenAI confirms it.
export async function revoke(fetch, session) {
  const { status } = await request(fetch, `${ISSUER}/oauth/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID, token_type_hint: 'refresh_token', token: session.refreshToken }) });
  if (status !== 200) throw new TransientFailure(`revoke_${status}`);
}
