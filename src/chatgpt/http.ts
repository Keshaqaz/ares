import pkg from '../../package.json' with { type: 'json' };

// Live check 01: every endpoint accepts the honest User-Agent, so no Codex headers.
export const USER_AGENT = `codex-auto-resets/${pkg.version}`;

export type Fetch = typeof fetch;

export type TransientReason = 'network' | `wham_${number}` | 'wham_invalid_usage' | 'wham_invalid_credits' |
  `consume_${number}` | `refresh_${number}` | 'refresh_invalid_reply' | `revoke_${number}`;
export type SessionLostReason = 'access_rejected' | 'unauthorized' | 'invalid_grant' |
  'refresh_token_expired' | 'refresh_token_reused' | 'refresh_token_invalidated';

// A failure that a later tick may not see again: network, 5xx, unexpected reply.
export class TransientFailure extends Error {
  reason: TransientReason;
  constructor(reason: TransientReason) { super(reason); this.reason = reason; }
}
// The worker session is gone; only a new login brings it back.
export class SessionLost extends Error {
  reason: SessionLostReason;
  constructor(reason: SessionLostReason) { super(reason); this.reason = reason; }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}
// value is the parsed JSON body, or null when there is none; its shape is not checked yet.
export interface Reply { status: number; value: unknown }

export async function request(fetch: Fetch, url: string,
  { method = 'GET', headers = {}, body, timeoutMs = 15_000 }: RequestOptions = {}): Promise<Reply> {
  let response, text;
  try {
    response = await fetch(url, { method, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': USER_AGENT, ...headers } });
    text = await response.text();
  } catch { throw new TransientFailure('network'); }
  let value: unknown = null;
  try { value = text ? JSON.parse(text) : null; } catch { /* non-JSON error pages stay null */ }
  return { status: response.status, value };
}

// A JSON object, as opposed to an array, null or a scalar.
export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
// The JSON object, or null for anything else: what `value?.field` reads safely.
export const asObject = (value: unknown): Record<string, unknown> | null => object(value) ? value : null;

export function claims(jwt: string): unknown {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { return null; }
}
