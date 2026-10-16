import sodium from 'libsodium-wrappers';
import { AuthFailure, encodeBundle, hash } from './auth-bundle.mjs';
import { migrateState, validateState, initialState, StateFailure } from './state-store.mjs';

// A single PAT (AUTO_RESET_GITHUB_TOKEN), scoped by the user to this private repository.
// GitHub concurrency belongs to the workflow/setup stream (17/18), not to Contents CAS.
export class GitHubStorage {
  constructor({ repository, token, serialization, fetchImpl = fetch, timeoutMs = 15_000 }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') ||
        typeof token !== 'string' || !token || typeof serialization?.assertOwner !== 'function') {
      throw new AuthFailure('invalid_storage_configuration');
    }
    this.repository = repository;
    this.token = token;
    this.serialization = serialization;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.statePath = '/contents/state.json';
    this.branch = 'auto-reset-state';
  }

  async api(path, { method = 'GET', body, statuses = [200] } = {}) {
    try {
      const response = await this.fetch(`https://api.github.com/repos/${this.repository}${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json',
          'x-github-api-version': '2026-03-10', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!statuses.includes(response.status)) {
        // Never retain GitHub's body, headers, URL or underlying exception.
        throw new AuthFailure([401, 403].includes(response.status) ? 'stop_grant' :
          response.status === 409 ? 'state_conflict' : response.status === 404 ? 'storage_missing' : 'storage_failed');
      }
      if (response.status === 204) return null;
      const raw = await response.text();
      if (raw === '' && path.startsWith('/actions/secrets/') && method === 'PUT') return null;
      if (Buffer.byteLength(raw) > 24 * 1024 * 1024) throw new AuthFailure('storage_failed');
      return JSON.parse(raw);
    } catch (error) {
      if (error instanceof AuthFailure) throw error;
      throw new AuthFailure('storage_unconfirmed');
    }
  }

  async assertOwner() {
    try { await this.serialization.assertOwner(); }
    catch { throw new AuthFailure('serialized_writer_required'); }
  }

  async preflight() {
    await this.assertOwner();
    const repo = await this.api('');
    if (repo?.private !== true || repo.full_name?.toLowerCase() !== this.repository.toLowerCase()) {
      throw new AuthFailure('private_repository_required');
    }
    await this.publicKey();
  }
  async publicKey() {
    const key = await this.api('/actions/secrets/public-key');
    if (typeof key?.key_id !== 'string' || !key.key_id || typeof key?.key !== 'string' ||
        Buffer.from(key.key, 'base64').length !== 32) throw new AuthFailure('invalid_repository_key');
    return key;
  }
  async publish(bundle) {
    await this.assertOwner();
    const plaintext = encodeBundle(bundle);
    const key = await this.publicKey();
    await sodium.ready;
    let encrypted;
    try { encrypted = sodium.crypto_box_seal(Buffer.from(plaintext), Buffer.from(key.key, 'base64')); }
    catch { throw new AuthFailure('secret_encryption_failed'); }
    await this.api('/actions/secrets/AUTO_RESET_AUTH_BUNDLE', { method: 'PUT', statuses: [201, 204],
      body: { encrypted_value: Buffer.from(encrypted).toString('base64'), key_id: key.key_id } });
  }
  async deleteBundle() {
    await this.assertOwner();
    const { state } = await this.load();
    if (!state.disabled || !state.revoked) throw new AuthFailure('durable_revoke_required');
    await this.api('/actions/secrets/AUTO_RESET_AUTH_BUNDLE', { method: 'DELETE', statuses: [204, 404] });
    // This removes storage only. Remote ChatGPT/PAT revocation is a separate user action.
  }

  async load() {
    await this.assertOwner();
    const response = await this.api(`${this.statePath}?ref=${this.branch}`);
    try {
      if (response?.type !== 'file' || response.encoding !== 'base64' ||
          typeof response.sha !== 'string' || !/^[a-f0-9]{40,64}$/.test(response.sha) ||
          typeof response.content !== 'string') throw new Error();
      const raw = Buffer.from(response.content, 'base64');
      if (raw.length > 16 * 1024 * 1024) throw new Error();
      return { state: migrateState(JSON.parse(raw.toString('utf8'))), sha: response.sha };
    } catch { throw new StateFailure('invalid_state'); }
  }
  async initializeDisabled(language, programCommit) {
    await this.preflight();
    try { return await this.read(); }
    catch (error) { if (error.kind !== 'storage_missing') throw error; }
    const repo = await this.api('');
    const ref = await this.api(`/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
    try { await this.api(`/git/ref/heads/${this.branch}`); }
    catch (error) {
      if (error.kind !== 'storage_missing') throw error;
      await this.api('/git/refs', { method: 'POST', statuses: [201], body: { ref: `refs/heads/${this.branch}`, sha: ref.object.sha } });
    }
    const state = initialState(language); state.disabled = true;
    state.installation = { programCommit, seedSession: null, checkedSession: null, operation: null, grant: null };
    let failure;
    try { await this.api(this.statePath, { method: 'PUT', statuses: [201], body: {
      branch: this.branch, message: 'Initialize disabled auto-reset installation', content: Buffer.from(JSON.stringify(state)).toString('base64') } }); }
    catch (error) { failure = error; }
    const fresh = await this.read();
    if (JSON.stringify(fresh) !== JSON.stringify(state)) throw failure ?? new StateFailure('state_write_unconfirmed');
    return fresh;
  }
  async read() { return this.inspect(state => state); }
  async inspect(fn) { return fn((await this.load()).state); }
  async update(fn) {
    const { state, sha } = await this.load();
    const before = JSON.stringify(state);
    const result = fn(state);
    if (result instanceof Promise) throw new StateFailure('async_state_mutation');
    if (JSON.stringify(state) !== before) {
      state.version++;
      validateState(state);
      await this.write(state, sha);
    }
    return { state, result };
  }
  async write(state, sha) {
    await this.assertOwner();
    validateState(state);
    const content = JSON.stringify(state);
    let failure;
    try {
      await this.api(this.statePath, { method: 'PUT', statuses: [200, 201], body: {
        message: `auto-reset state ${state.version}`, branch: this.branch, sha,
        content: Buffer.from(content).toString('base64'),
      } });
    } catch (error) { failure = error; }
    // Read back the complete document, including journal and operation/version.
    // A lost response can be recovered by exact proof; a conflict never retries the RPC.
    let fresh = await this.load();
    // Contents can briefly return the preceding branch revision after a successful
    // PUT. Retry only readback of an older version: never the mutation or RPC.
    for (const delay of [100, 300, 1000]) {
      if (fresh.state.version >= state.version) break;
      await new Promise(resolve => setTimeout(resolve, delay));
      fresh = await this.load();
    }
    if (hash(JSON.stringify(fresh.state)) !== hash(content)) {
      throw failure ?? new AuthFailure('state_write_unconfirmed');
    }
  }
}
