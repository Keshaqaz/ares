import { request, SessionLost, TransientFailure } from './http.mjs';

const BASE = 'https://chatgpt.com/backend-api/wham';
const WEEK_SECONDS = 604800, FIVE_HOURS_SECONDS = 18000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function wham(fetch, session, path, { headers, ...options } = {}) {
  const reply = await request(fetch, `${BASE}${path}`, { ...options,
    headers: { authorization: `Bearer ${session.accessToken}`, 'chatgpt-account-id': session.accountId, ...headers } });
  // Refresh happens only near exp, so a rejected access token means the session is gone.
  if (reply.status === 401) throw new SessionLost('access_rejected');
  return reply;
}

async function get(fetch, session, path) {
  const { status, value } = await wham(fetch, session, path);
  if (status !== 200 || !object(value)) throw new TransientFailure(`wham_${status}`);
  return value;
}

// A window is identified by its length, never by its position in the reply.
function quota(windows, seconds) {
  const window = windows.find(w => w.limit_window_seconds === seconds);
  if (!window) return null;
  if (!Number.isFinite(window.used_percent) || !Number.isSafeInteger(window.reset_at)) throw new TransientFailure('wham_invalid_usage');
  return { usedPercent: window.used_percent, exhausted: window.used_percent >= 100, renewsAt: window.reset_at * 1000 };
}

// Weekly and five-hour quotas, each null when the plan has no such window.
export async function usage(fetch, session) {
  const value = await get(fetch, session, '/usage');
  const limits = value.rate_limit;
  if (!object(limits)) throw new TransientFailure('wham_invalid_usage');
  const windows = [limits.primary_window, limits.secondary_window].filter(object);
  return { weeklyQuota: quota(windows, WEEK_SECONDS), fiveHourQuota: quota(windows, FIVE_HOURS_SECONDS) };
}

// Issued resets that can still be applied on this plan, with their activation deadline (null: none).
export async function issuedResets(fetch, session) {
  const value = await get(fetch, session, '/rate-limit-reset-credits');
  if (!Array.isArray(value.credits)) throw new TransientFailure('wham_invalid_credits');
  return value.credits.filter(row => row?.status === 'available' && row.is_supported_by_plan !== false).map(row => {
    const expiresAt = row.expires_at == null ? null : Date.parse(row.expires_at);
    if (typeof row.id !== 'string' || !row.id || Number.isNaN(expiresAt)) throw new TransientFailure('wham_invalid_credits');
    return { id: row.id, expiresAt };
  });
}

// Stock App Server parser: the backend answers { code, windows_reset }.
const CONSUME_RESULTS = ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'];

// One POST consume for the chosen reset. The server dedupes by redeemRequestId, so a retry
// of the same attempt reuses it. Throws TransientFailure when the result is unknown.
export async function consume(fetch, session, { creditId, redeemRequestId }) {
  const { status, value } = await wham(fetch, session, '/rate-limit-reset-credits/consume', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redeem_request_id: redeemRequestId, credit_id: creditId }) });
  if (status !== 200 || !CONSUME_RESULTS.includes(value?.code)) throw new TransientFailure(`consume_${status}`);
  return value.code;
}
