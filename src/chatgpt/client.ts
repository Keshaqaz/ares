import { request, object, asObject, SessionLost, TransientFailure } from './http.ts';
import type { Fetch, Reply, RequestOptions } from './http.ts';
import type { Session } from './session.ts';

const BASE = 'https://chatgpt.com/backend-api/wham';
const WEEK_SECONDS = 604800, FIVE_HOURS_SECONDS = 18000;

// renewsAt: when the window starts over, in ms.
export interface Quota { usedPercent: number; exhausted: boolean; renewsAt: number }
// Each null when the plan has no such window.
export interface Quotas { weeklyQuota: Quota | null; fiveHourQuota: Quota | null }
// expiresAt: the activation deadline in ms, null when there is none.
export interface IssuedReset { id: string; expiresAt: number | null }

async function wham(fetch: Fetch, session: Session, path: string, { headers, ...options }: RequestOptions = {}): Promise<Reply> {
  const reply = await request(fetch, `${BASE}${path}`, { ...options,
    headers: { authorization: `Bearer ${session.accessToken}`, 'chatgpt-account-id': session.accountId, ...headers } });
  // Refresh happens only near exp, so a rejected access token means the session is gone.
  if (reply.status === 401) throw new SessionLost('access_rejected');
  return reply;
}

async function get(fetch: Fetch, session: Session, path: string): Promise<Record<string, unknown>> {
  const { status, value } = await wham(fetch, session, path);
  if (status !== 200 || !object(value)) throw new TransientFailure(`wham_${status}`);
  return value;
}

// A window is identified by its length, never by its position in the reply.
function quota(windows: Record<string, unknown>[], seconds: number): Quota | null {
  const window = windows.find(w => w.limit_window_seconds === seconds);
  if (!window) return null;
  const { used_percent: usedPercent, reset_at: resetAt } = window;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || typeof resetAt !== 'number' ||
      !Number.isSafeInteger(resetAt)) throw new TransientFailure('wham_invalid_usage');
  return { usedPercent, exhausted: usedPercent >= 100, renewsAt: resetAt * 1000 };
}

// Weekly and five-hour quotas, each null when the plan has no such window.
export async function usage(fetch: Fetch, session: Session): Promise<Quotas> {
  const value = await get(fetch, session, '/usage');
  const limits = value.rate_limit;
  if (!object(limits)) throw new TransientFailure('wham_invalid_usage');
  const windows = [limits.primary_window, limits.secondary_window].filter(object);
  return { weeklyQuota: quota(windows, WEEK_SECONDS), fiveHourQuota: quota(windows, FIVE_HOURS_SECONDS) };
}

// Issued resets that can still be applied on this plan, with their activation deadline (null: none).
export async function issuedResets(fetch: Fetch, session: Session): Promise<IssuedReset[]> {
  const value = await get(fetch, session, '/rate-limit-reset-credits');
  if (!Array.isArray(value.credits)) throw new TransientFailure('wham_invalid_credits');
  const credits: unknown[] = value.credits;
  return credits.filter(object).filter(row => row.status === 'available' && row.is_supported_by_plan !== false).map(row => {
    const expiresAt = row.expires_at == null ? null : Date.parse(String(row.expires_at));
    if (typeof row.id !== 'string' || !row.id || Number.isNaN(expiresAt)) throw new TransientFailure('wham_invalid_credits');
    return { id: row.id, expiresAt };
  });
}

// Stock App Server parser: the backend answers { code, windows_reset }.
const CONSUME_RESULTS = ['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'] as const;
export type ConsumeResult = typeof CONSUME_RESULTS[number];
const isConsumeResult = (code: unknown): code is ConsumeResult => CONSUME_RESULTS.some(result => result === code);

// The reset to apply and the attempt's key: redeemRequestId stays the same across retries of one attempt.
export interface ConsumeRequest { creditId: string; redeemRequestId: string }

// One POST consume for the chosen reset. The server dedupes by redeemRequestId, so a retry
// of the same attempt reuses it. Throws TransientFailure when the result is unknown.
export async function consume(fetch: Fetch, session: Session, { creditId, redeemRequestId }: ConsumeRequest): Promise<ConsumeResult> {
  const { status, value } = await wham(fetch, session, '/rate-limit-reset-credits/consume', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redeem_request_id: redeemRequestId, credit_id: creditId }) });
  const code = asObject(value)?.code;
  if (status !== 200 || !isConsumeResult(code)) throw new TransientFailure(`consume_${status}`);
  return code;
}
