import pkg from '../../package.json' with { type: 'json' };

// Live check 01: every endpoint accepts the honest User-Agent, so no Codex headers.
export const USER_AGENT = `codex-auto-resets/${pkg.version}`;

// A failure that a later tick may not see again: network, 5xx, unexpected reply.
export class TransientFailure extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
// The worker session is gone; only a new login brings it back.
export class SessionLost extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

export async function request(fetch, url, { method = 'GET', headers = {}, body, timeoutMs = 15_000 } = {}) {
  let response, text;
  try {
    response = await fetch(url, { method, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': USER_AGENT, ...headers } });
    text = await response.text();
  } catch { throw new TransientFailure('network'); }
  let value = null;
  try { value = text ? JSON.parse(text) : null; } catch { /* non-JSON error pages stay null */ }
  return { status: response.status, value };
}

export function claims(jwt) {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}
