import { mkdtemp, mkdir, open, rename, rm, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuthFailure, hostCredentials, bundleBytes, makeBundle, encodeBundle, decodeBundle } from './auth-bundle.mjs';
import { assertPinnedBinary } from './external-auth-runtime.mjs';

export const OAUTH_PIN = Object.freeze({ endpoint: 'https://auth.openai.com/oauth/token',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', revokeEndpoint: 'https://auth.openai.com/oauth/revoke' });

// Optional fields have the pinned serde Option semantics: omitted/null retains the
// prior value; a provided value must be a nonempty string. No retry or proxy fallback.
export class HostOAuth {
  constructor({ fetchImpl = fetch, timeoutMs = 15_000, now = () => Math.floor(Date.now() / 1000),
    syntheticEndpoint = null } = {}) {
    this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.now = now;
    if (syntheticEndpoint && !/^http:\/\/127\.0\.0\.1:\d+\/oauth\/token$/.test(syntheticEndpoint)) {
      throw new AuthFailure('invalid_oauth_configuration');
    }
    this.endpoint = syntheticEndpoint ?? OAUTH_PIN.endpoint;
  }
  async refresh(bundle) {
    if (bundle.schema !== 2) throw new AuthFailure('incompatible_auth_protocol');
    const { auth } = hostCredentials(bundleBytes(bundle));
    try {
      const response = await this.fetch(this.endpoint, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs), headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: OAUTH_PIN.clientId, grant_type: 'refresh_token', refresh_token: auth.tokens.refresh_token }) });
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 48 * 1024) throw new AuthFailure('oauth_invalid_response');
      const value = JSON.parse(raw);
      if (response.status !== 200) {
        const reasons = { refresh_token_expired: 'oauth_expired', refresh_token_reused: 'oauth_reused',
          refresh_token_invalidated: 'oauth_revoked', invalid_grant: 'oauth_invalid_grant' };
        throw new AuthFailure(reasons[value?.error?.code ?? value?.error] ?? 'oauth_rejected');
      }
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          value.token_type != null && value.token_type.toLowerCase?.() !== 'bearer' ||
          !['access_token', 'id_token', 'refresh_token'].some(key => value[key] != null)) {
        throw new AuthFailure('oauth_invalid_response');
      }
      for (const key of ['access_token', 'id_token', 'refresh_token']) {
        if (value[key] == null) continue;
        if (typeof value[key] !== 'string' || !value[key]) throw new AuthFailure('oauth_invalid_response');
        auth.tokens[key] = value[key];
      }
      auth.last_refresh = new Date(this.now() * 1000).toISOString();
      return makeBundle(Buffer.from(JSON.stringify(auth)), { previous: bundle });
    } catch (error) {
      if (error instanceof AuthFailure) throw error;
      throw new AuthFailure('oauth_unconfirmed');
    }
  }
  async revoke(bundle) {
    if (bundle.schema !== 2) throw new AuthFailure('incompatible_auth_protocol');
    const { auth } = hostCredentials(bundleBytes(bundle));
    const endpoint = this.endpoint === OAUTH_PIN.endpoint ? OAUTH_PIN.revokeEndpoint : this.endpoint.replace('/token', '/revoke');
    try {
      const response = await this.fetch(endpoint, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs), headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: OAUTH_PIN.clientId, token: auth.tokens.refresh_token, token_type_hint: 'refresh_token' }) });
      if (response.status < 200 || response.status >= 300) throw new AuthFailure('oauth_revoke_rejected');
      return { kind: 'revokeAccepted', propagation: 'unverified' };
    } catch (error) {
      throw new AuthFailure(error instanceof AuthFailure ? error.kind : 'oauth_revoke_unconfirmed');
    }
  }
}

// Owned credential cache, never an artifact. Atomic rename + file and directory
// fsync; exact readback. One record ties the new full bundle to a durable intent.
export class LocalAuthVault {
  constructor(path) { this.path = path; }
  async save(record) {
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let file;
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const directory = await lstat(dirname(this.path));
      if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700) throw new Error();
      file = await open(temp, 'wx', 0o600);
      await file.writeFile(JSON.stringify(record)); await file.sync();
      await file.close(); file = null;
      await rename(temp, this.path);
      const dir = await open(dirname(this.path), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      if (JSON.stringify(await this.read()) !== JSON.stringify(record)) throw new Error();
    } catch { throw new AuthFailure('local_auth_save_failed'); }
    finally { await file?.close(); await rm(temp, { force: true }); }
  }
  async read() {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.size > 64 * 1024 || (info.mode & 0o777) !== 0o600) throw new Error();
      const record = JSON.parse(await readFile(this.path, 'utf8'));
      decodeBundle(encodeBundle(record.bundle));
      return record;
    } catch { throw new AuthFailure('local_auth_unconfirmed'); }
  }
  async clear() { await rm(this.path, { force: true }); }
}

// 18 owns presenting/running the interactive login on a trusted machine. The plan
// has a new private HOME/CODEX_HOME and no inherited credentials or client override.
export async function prepareCiLogin({ binary, parent = tmpdir() }) {
  if (typeof binary !== 'string' || !binary.startsWith('/')) throw new AuthFailure('invalid_login_binary');
  await assertPinnedBinary(binary);
  const root = await mkdtemp(join(parent, 'auto-reset-ci-login-'));
  const home = join(root, 'home'), codexHome = join(root, 'codex');
  await mkdir(home, { mode: 0o700 }); await mkdir(codexHome, { mode: 0o700 });
  let closed = false;
  return { file: binary, args: ['-c', 'cli_auth_credentials_store="file"', 'login'],
    env: { HOME: home, CODEX_HOME: codexHome, PATH: process.env.PATH, TMPDIR: root, LANG: 'en_US.UTF-8' },
    codexHome,
    // Caller must await owned login process termination before importing/cleaning.
    complete: async ({ processExited }) => {
      if (!processExited || closed) throw new AuthFailure('login_process_not_closed');
      try {
        const path = join(codexHome, 'auth.json');
        const info = await lstat(path);
        if (!info.isFile() || info.size > 48 * 1024 || (info.mode & 0o777) !== 0o600) throw new Error();
        const auth = JSON.parse(await readFile(path, 'utf8'));
        // Official login may obtain an unrelated API key; never retain it in CI.
        auth.OPENAI_API_KEY = null;
        return makeBundle(Buffer.from(JSON.stringify(auth)), { protocol: 2 });
      } catch { throw new AuthFailure('invalid_login_bundle'); }
    },
    cleanup: async ({ processExited }) => {
      if (!processExited) throw new AuthFailure('login_process_not_closed');
      await rm(root, { recursive: true, force: true }); closed = true;
    },
  };
}
