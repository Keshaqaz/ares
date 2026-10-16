import { randomUUID } from 'node:crypto';
import { AuthFailure, makeBundle, decodeBundle, bundleBytes, hostCredentials, tuple, sameTuple, grantFingerprint, readyAuth, validateAuth } from './auth-bundle.mjs';

// Setup/reconnect/grant rotation/uninstall use the same serialized store as jobs.
// Login and remote revoke are human steps in 18/21. No desktop credentials are read here.
export class AuthAdmin {
  constructor({ store, secrets, owner }) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(owner ?? '')) throw new AuthFailure('invalid_owner');
    this.store = store; this.secrets = secrets; this.owner = owner;
    this.protocol = 1;
  }
  async change(expectedVersion, fn) {
    return (await this.store.update(state => {
      if (state.version !== expectedVersion) throw new AuthFailure('state_conflict');
      fn(state);
    })).state;
  }
  async disable(expectedVersion, { revoke = false } = {}) {
    return this.change(expectedVersion, state => {
      state.disabled = true;
      if (revoke) {
        state.revoked = true;
        if (state.installation) { state.installation.seedSession = null; state.installation.checkedSession = null; }
        if (state.auth) state.auth.reconnectReason = 'revoked';
      }
    });
  }
  async seed(bytes, grant, expectedVersion) {
    const bundle = makeBundle(bytes); // Always a new separate CI session identity.
    await this.secrets.preflight();
    const state = await this.change(expectedVersion, state => {
      if (!state.disabled) throw new AuthFailure('durable_disable_required');
      const committed = state.auth?.committed ?? null;
      if (state.auth?.protocol === 2) throw new AuthFailure('incompatible_auth_protocol');
      if (committed && committed.identityDigest !== bundle.identityDigest) throw new AuthFailure('identity_changed');
      state.auth = { ...readyAuth(bundle, grant), phase: 'publishing', committed,
        target: tuple(bundle), operationId: randomUUID(), owner: this.owner, transition: 'seed' };
    });
    await this.secrets.publish(bundle);
    await this.adopt(bundle, grant, state.version);
    return bundle; // Secret value: caller must not log or return it through a public command.
  }
  async adopt(snapshot, grant, expectedVersion) {
    const bundle = typeof snapshot === 'string' ? decodeBundle(snapshot) : decodeBundle(JSON.stringify(snapshot));
    if (bundle.schema !== this.protocol) throw new AuthFailure('incompatible_auth_protocol');
    return this.change(expectedVersion, state => {
      if (!state.disabled || state.auth?.phase !== 'publishing' || state.auth.transition !== 'seed' ||
          state.auth.protocol !== bundle.schema ||
          !sameTuple(tuple(bundle), state.auth.target) || state.auth.grantFingerprint !== grantFingerprint(grant)) {
        throw new AuthFailure('seed_recovery_unconfirmed');
      }
      state.auth = readyAuth(bundle, grant);
      // Cycle/request/group journals, original hour and revoked flag remain untouched.
    });
  }
  async rotateGrant(grant, expectedVersion) {
    await this.secrets.preflight();
    return this.change(expectedVersion, state => {
      if (!state.disabled || !state.auth || state.auth.phase !== 'ready') throw new AuthFailure('durable_disable_required');
      if (state.auth.protocol !== this.protocol) throw new AuthFailure('incompatible_auth_protocol');
      state.auth.grantFingerprint = grantFingerprint(grant);
    });
  }
}

// Only explicit disabled migration may replace protocol 1. The exact old bundle
// proves the full identity; its coarse digest alone cannot bind a user's identity.
export class HostAuthAdmin extends AuthAdmin {
  constructor(options) { super(options); this.serialization = options.serialization; this.protocol = 2; }
  async change(expectedVersion, fn) {
    try { await this.serialization.assertOwner(); } catch { throw new AuthFailure('serialized_writer_required'); }
    return super.change(expectedVersion, fn);
  }
  async revokeSession(snapshot, grant, expectedVersion, oauth) {
    try { await this.serialization.assertOwner(); } catch { throw new AuthFailure('serialized_writer_required'); }
    const bundle = decodeBundle(snapshot);
    const state = await this.store.read();
    if (state.version !== expectedVersion || !state.disabled || !state.revoked || state.auth?.protocol !== 2 ||
        state.auth.phase !== 'ready' || bundle.schema !== 2 || !sameTuple(tuple(bundle), state.auth.committed) ||
        state.auth.grantFingerprint !== grantFingerprint(grant)) throw new AuthFailure('durable_revoke_required');
    await this.confirm(state);
    return oauth.revoke(bundle); // One explicit administrative call, never runner fallback.
  }
  async rotateGrant(grant, expectedVersion) {
    try { await this.serialization.assertOwner(); } catch { throw new AuthFailure('serialized_writer_required'); }
    const result = await super.rotateGrant(grant, expectedVersion);
    await this.confirm(result);
    return result;
  }
  async seed(bytes, grant, expectedVersion, { previousSnapshot = null, preparedBundle = null } = {}) {
    try { await this.serialization.assertOwner(); } catch { throw new AuthFailure('serialized_writer_required'); }
    const bundle = preparedBundle === null ? makeBundle(bytes, { protocol: 2 }) : decodeBundle(JSON.stringify(preparedBundle));
    if (bundle.schema !== 2 || bundle.generation !== 1 || !bundleBytes(bundle).equals(Buffer.from(bytes))) throw new AuthFailure('invalid_seed_bundle');
    const state = await this.store.read();
    if (state.version !== expectedVersion) throw new AuthFailure('state_conflict');
    if (!state.disabled) throw new AuthFailure('durable_disable_required');
    if (state.auth) {
      validateAuth(state.auth);
      if (!state.auth.committed) throw new AuthFailure('seed_recovery_unconfirmed');
      let identity = state.auth.committed.identityDigest;
      if (state.auth.protocol === 1 || state.auth.transition === 'seed' &&
          state.auth.target.identityDigest !== state.auth.committed.identityDigest) {
        const old = decodeBundle(previousSnapshot);
        if (old.schema !== 1 || !sameTuple(tuple(old), state.auth.committed)) throw new AuthFailure('migration_unconfirmed');
        identity = hostCredentials(bundleBytes(old)).identityDigest;
      }
      if (identity !== bundle.identityDigest) throw new AuthFailure('identity_changed');
    }
    await this.secrets.preflight();
    const target = await this.change(expectedVersion, s => {
      s.auth = { ...readyAuth(bundle, grant), phase: 'publishing', committed: s.auth?.committed ?? null,
        target: tuple(bundle), operationId: randomUUID(), owner: this.owner, transition: 'seed' };
    });
    await this.confirm(target);
    try { await this.serialization.assertOwner(); } catch { throw new AuthFailure('serialized_writer_required'); }
    await this.secrets.publish(bundle);
    await this.adopt(bundle, grant, target.version);
    return bundle;
  }
  async confirm(expected) {
    const actual = await this.store.read();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new AuthFailure('state_readback_failed');
  }
  async adopt(snapshot, grant, expectedVersion) {
    try { await this.serialization.assertOwner(); } catch { throw new AuthFailure('serialized_writer_required'); }
    const bundle = typeof snapshot === 'string' ? decodeBundle(snapshot) : decodeBundle(JSON.stringify(snapshot));
    if (bundle.schema !== 2) throw new AuthFailure('incompatible_auth_protocol');
    const result = await super.adopt(bundle, grant, expectedVersion);
    await this.confirm(result);
    return result;
  }
}
