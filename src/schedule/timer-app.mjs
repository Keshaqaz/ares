import { StateFailure } from '../core/state-failure.mjs';

// Timer app (ADR-0003, ticket 42): the GitHub App whose key the external timer holds. Shared by
// the Worker and the installer, so only WebCrypto and web globals, no Node-only APIs or imports
// beyond the repository. The key signs a JWT, which buys a one-hour installation token
// narrowed to the installation repo and these two permissions.
export const TIMER_PERMISSIONS = { actions: 'write', contents: 'read' };
const fail = kind => { throw new StateFailure(kind); };
const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const text = value => base64url(new TextEncoder().encode(JSON.stringify(value)));

// TIMER_APP_KEY is PKCS#8: one base64 line of DER, as the installer pipes it through stdin, or
// PEM pasted by hand. GitHub issues PKCS#1, which WebCrypto cannot import; it is converted first.
export async function importAppKey(value) {
  // -{5} keeps a literal PEM armor line out of the source (release secret scan).
  const m = /^\s*(?:-{5}BEGIN PRIVATE KEY-{5})?([A-Za-z0-9+/=\s]+?)(?:-{5}END PRIVATE KEY-{5})?\s*$/.exec(value ?? '');
  if (!m) fail('key_invalid'); // PKCS#1 ("BEGIN RSA PRIVATE KEY") does not match.
  try {
    const der = Uint8Array.from(atob(m[1].replace(/\s/g, '')), c => c.charCodeAt(0));
    return await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch { fail('key_invalid'); }
}
// RS256 app JWT: iat a minute back for clock drift, nine minutes of life (GitHub allows ten).
export async function appJwt({ appId, key, now }) {
  const body = `${text({ alg: 'RS256', typ: 'JWT' })}.${text({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(body));
  return `${body}.${base64url(signature)}`;
}
// Body of POST /app/installations/{id}/access_tokens: even an App installed on all repositories
// yields a token for the installation repo only, with no right beyond the two.
export const tokenRequest = repository => ({ repositories: [repository.split('/')[1]], permissions: TIMER_PERMISSIONS });
// The 201 answer; expires_at is ISO 8601 UTC. Anything else is not a usable token.
export function readInstallationToken(body) {
  const expiresAt = Date.parse(body?.expires_at ?? '') / 1000;
  if (typeof body?.token !== 'string' || !body.token || !Number.isSafeInteger(expiresAt)) fail('github_unexpected');
  return { token: body.token, expiresAt };
}
