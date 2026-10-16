import { randomUUID } from 'node:crypto';
import { validateAccountRequest } from './account.mjs';
import { AuthFailure, decodeBundle, encodeBundle, tuple, sameTuple, grantFingerprint, validateAuth,
  hostCredentials, bundleBytes } from './auth-bundle.mjs';

const methods = new Set(['account/read', 'account/rateLimits/read', 'account/rateLimitResetCredit/consume']);
const ready = auth => { auth.phase = 'ready'; auth.target = null; auth.operationId = null; auth.owner = null; auth.transition = null; };

export class HostAuthSession {
  authMode = 'chatgptAuthTokens';
  #reservations = new Map();
  constructor({ store, secrets, serialization, oauth, vault, runtime, snapshot, grant, owner,
    now = () => Math.floor(Date.now() / 1000), refreshWindow = 300 }) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(owner ?? '') || !Number.isSafeInteger(refreshWindow) || refreshWindow < 300) {
      throw new AuthFailure('invalid_host_auth_configuration');
    }
    Object.assign(this, { store, secrets, serialization, oauth, vault, runtime, owner, now, refreshWindow });
    this.bundle = decodeBundle(snapshot); this.fingerprint = grantFingerprint(grant);
    this.stopped = false; this.busy = false;
  }
  async writer() {
    try { await this.serialization.assertOwner(); } catch { throw new AuthFailure('serialized_writer_required'); }
  }
  check(state, { setup = false, expectedVersion, reservation = null } = {}) {
    if (!state.auth) throw new AuthFailure('auth_state_missing');
    validateAuth(state.auth);
    if (state.auth.protocol !== 2 || this.bundle.schema !== 2) throw new AuthFailure('incompatible_auth_protocol');
    if (state.revoked || state.reconnectRequested || state.auth.reconnectReason) throw new AuthFailure('reconnect_required');
    if (setup ? !state.disabled : state.disabled) throw new AuthFailure('disabled');
    if (expectedVersion !== undefined && state.version !== expectedVersion) throw new AuthFailure('state_conflict');
    if (state.auth.grantFingerprint !== this.fingerprint) throw new AuthFailure('stale_grant');
    if (!setup && state.requests.some(row => row.state === 'unconfirmed' && row.requestId !== reservation?.requestId)) {
      throw new AuthFailure('consume_outcome_unknown');
    }
    if (reservation && !state.requests.some(row => row.state === 'unconfirmed' &&
        row.requestId === reservation.requestId && row.creditId === reservation.creditId &&
        row.idempotencyKey === reservation.idempotencyKey)) throw new AuthFailure('consume_reservation_required');
  }
  async mutate(state, fn) {
    await this.writer();
    const result = (await this.store.update(s => {
      if (s.version !== state.version) throw new AuthFailure('state_conflict');
      fn(s);
    })).state;
    if (JSON.stringify(await this.store.read()) !== JSON.stringify(result)) throw new AuthFailure('state_readback_failed');
    return result;
  }
  async admit(options = {}) {
    await this.writer();
    let state = await this.store.read(); this.check(state, options);
    if (options.noMaintenance && state.auth.phase !== 'ready') throw new AuthFailure('refresh_required');
    if (state.auth.phase === 'inflight') throw new AuthFailure('reconnect_required');
    if (state.auth.phase === 'publishing') {
      // Possession of the exact fresh repository Secret snapshot is publication evidence.
      if (state.auth.transition !== 'rotation' || !sameTuple(tuple(this.bundle), state.auth.target)) throw new AuthFailure('stale_snapshot');
      await this.secrets.preflight();
      state = await this.mutate(state, s => { s.auth.committed = s.auth.target; ready(s.auth); });
    }
    if (!sameTuple(tuple(this.bundle), state.auth.committed)) throw new AuthFailure('stale_snapshot');
    await this.secrets.preflight();
    return state;
  }
  async locked(fn) {
    if (this.stopped) throw new AuthFailure('job_stopped');
    if (this.busy) throw new AuthFailure('auth_busy');
    this.busy = true;
    try { return await fn(); }
    catch (error) {
      this.stopped = true;
      // No backend body, token, URL or raw transport exception escapes.
      throw new AuthFailure(error instanceof AuthFailure ? error.kind : 'auth_failed');
    } finally { this.busy = false; }
  }
  async maintain(state, { force = false, setup = false, reservation = null } = {}) {
    const credentials = hostCredentials(bundleBytes(this.bundle));
    if (!force && credentials.expiresAt !== null && credentials.expiresAt > this.now() + this.refreshWindow) return state;
    const operationId = randomUUID();
    state = await this.mutate(state, s => {
      this.check(s, { setup, reservation });
      if (s.auth.phase !== 'ready') throw new AuthFailure('reconnect_required');
      s.auth.phase = 'inflight'; s.auth.operationId = operationId; s.auth.owner = this.owner;
      s.auth.transition = 'rotation'; s.auth.receipt = null;
    });
    // Intent/readback BEFORE the only OAuth network call. A lost response remains inflight.
    await this.writer();
    const next = await this.oauth.refresh(this.bundle);
    const record = { operationId, owner: this.owner, intentVersion: state.version,
      grantFingerprint: this.fingerprint, previous: tuple(this.bundle), bundle: next };
    await this.vault.save(record);
    state = await this.publish(state, record, { setup, reservation });
    this.bundle = next;
    return state;
  }
  async publish(state, record, { setup = false, reservation = null } = {}) {
    const next = decodeBundle(encodeBundle(record.bundle));
    this.check(state, { setup, reservation });
    if (next.schema !== 2 || state.auth.operationId !== record.operationId || state.auth.owner !== record.owner ||
        record.grantFingerprint !== this.fingerprint || !sameTuple(record.previous, state.auth.committed) ||
        next.sessionId !== record.previous.sessionId || next.generation !== record.previous.generation + 1 ||
        next.identityDigest !== record.previous.identityDigest) throw new AuthFailure('local_auth_unconfirmed');
    if (state.auth.phase === 'inflight') {
      if (state.version !== record.intentVersion) throw new AuthFailure('state_conflict');
      state = await this.mutate(state, s => { s.auth.phase = 'publishing'; s.auth.target = tuple(next); });
    } else if (state.auth.phase !== 'publishing' || state.version !== record.intentVersion + 1 ||
        !sameTuple(tuple(next), state.auth.target)) throw new AuthFailure('local_auth_unconfirmed');
    await this.writer();
    await this.secrets.publish(next); // Repeating persistence reuses this exact target.
    return this.mutate(state, s => { s.auth.committed = s.auth.target; ready(s.auth); });
  }
  async recoverLocal(options = {}) {
    return this.locked(async () => {
      await this.writer();
      const state = await this.store.read(); this.check(state, options);
      const record = await this.vault.read();
      // Recovery never refreshes, starts a process, clears unknown consume, or starts a new hour.
      const result = await this.publish(state, record, options);
      this.bundle = record.bundle;
      return { kind: 'publicationRecovered', version: result.version };
    });
  }
  async service({ force = false, setup = false, expectedVersion } = {}) {
    return this.locked(async () => {
      const state = await this.maintain(await this.admit({ setup, expectedVersion }), { force, setup });
      this.freshCredentials();
      return { kind: 'authServiced', generation: this.bundle.generation, version: state.version };
    });
  }
  async setupRead(expectedVersion, options = {}) {
    return this.request('account/read', { refreshToken: false }, { ...options, setup: true, expectedVersion });
  }
  async setupMetadata(expectedVersion, options = {}) {
    return this.request('account/rateLimits/read', { excludeResetCreditDetails: false, supportsLunaReserve: false },
      { ...options, setup: true, expectedVersion });
  }
  // 17 supplies the durable journal writer. Capture a NEW reservation in this
  // job; possession of an old unconfirmed ID/key is never authorization to replay.
  async reserveConsume(reserve) {
    return this.locked(async () => {
      const before = await this.admit();
      const result = await reserve();
      const after = await this.store.read();
      if (!result.request) { this.check(after); return null; }
      this.check(after, { reservation: result.request });
      if (before.requests.some(r => r.requestId === result.request?.requestId) ||
          after.version !== result.version || !sameTuple(before.auth.committed, after.auth.committed) ||
          after.auth.phase !== 'ready' || after.version <= before.version) throw new AuthFailure('consume_reservation_required');
      const proof = Object.freeze({ requestId: result.request.requestId, expectedVersion: after.version });
      this.#reservations.set(proof, Object.freeze({ ...result.request }));
      return proof;
    });
  }
  freshCredentials() {
    const credentials = hostCredentials(bundleBytes(this.bundle));
    if (credentials.expiresAt === null) throw new AuthFailure('access_expiry_unknown');
    if (credentials.expiresAt <= this.now() + this.refreshWindow) throw new AuthFailure('access_expired');
    return credentials;
  }
  async request(method, params = {}, { dispatch = null, finalDispatch = null, onResponse = null, allowRefresh = true, setup = false, expectedVersion, requestId = null, reservationProof = null } = {}) {
    if (!methods.has(method) || setup && !(method === 'account/read' && params.refreshToken === false || method === 'account/rateLimits/read')) throw new AuthFailure('method_forbidden');
    if (!allowRefresh && !setup) throw new AuthFailure('method_forbidden');
    validateAccountRequest(method, params);
    const consume = method === 'account/rateLimitResetCredit/consume';
    const captured = this.#reservations.get(reservationProof);
    if (setup && !Number.isSafeInteger(expectedVersion)) throw new AuthFailure('setup_version_required');
    if (consume && (!captured || captured.requestId !== requestId || reservationProof.expectedVersion !== expectedVersion ||
        captured.creditId !== params.creditId || captured.idempotencyKey !== params.idempotencyKey ||
        !requestId || typeof params.creditId !== 'string' || typeof params.idempotencyKey !== 'string' ||
        typeof dispatch !== 'function' || !Number.isSafeInteger(expectedVersion))) throw new AuthFailure('consume_reservation_required');
    if (!consume && requestId !== null) throw new AuthFailure('method_forbidden');
    dispatch ??= send => send();
    const reservation = consume ? Object.freeze({ requestId, creditId: params.creditId, idempotencyKey: params.idempotencyKey }) : null;
    if (consume) this.#reservations.delete(reservationProof);
    params = { ...params };
    return this.locked(async () => {
      let handle;
      try {
        const admitted = await this.admit({ setup, expectedVersion, reservation, noMaintenance: !allowRefresh });
        if (!allowRefresh) {
          if (admitted.auth.phase !== 'ready') throw new AuthFailure('refresh_required');
          const expiry = hostCredentials(bundleBytes(this.bundle)).expiresAt;
          if (expiry === null || expiry <= this.now() + this.refreshWindow) throw new AuthFailure('refresh_required');
        }
        const state = allowRefresh ? await this.maintain(admitted, { setup, reservation }) : admitted;
        const credentials = this.freshCredentials();
        // Only this projection crosses the process boundary.
        handle = await this.runtime.open({ accessToken: credentials.auth.tokens.access_token,
          chatgptAccountId: credentials.accountId, ...(credentials.planType ? { chatgptPlanType: credentials.planType } : {}) });
        const context = Object.freeze({ baseVersion: admitted.version, expectedVersion: state.version,
          authVersions: Object.freeze(Array.from({ length: state.version - admitted.version }, (_, i) => admitted.version + i + 1)),
          committed: Object.freeze(tuple(this.bundle)) });
        let sent = false;
        const response = await dispatch(async () => {
          if (sent) throw new AuthFailure('dispatch_already_sent');
          await this.writer();
          const latest = await this.store.read(); this.check(latest, { setup, reservation });
          if (latest.version !== context.expectedVersion || latest.auth.phase !== 'ready' ||
              !sameTuple(latest.auth.committed, context.committed)) throw new AuthFailure('state_conflict');
          if (credentials.expiresAt <= this.now() + this.refreshWindow) throw new AuthFailure('access_expired');
          // The journal owner checks deadline/disable/version after ALL async
          // auth work. Its callback and handle.request share the final turn.
          return (finalDispatch ?? (send => send()))(() => {
            if (sent) throw new AuthFailure('dispatch_already_sent');
            if (credentials.expiresAt <= this.now() + this.refreshWindow) throw new AuthFailure('access_expired');
            sent = true;
            return Promise.resolve(handle.request(method, params)).then(value => {
              // Preserve a received response before cleanup; cleanup failure
              // cannot turn a confirmed consume into a new attempt.
              onResponse?.(value);
              return value;
            });
          }, context);
        }, context);
        if (!sent) throw new AuthFailure('dispatch_not_sent');
        return response;
      } finally {
        if (handle) {
          try { await handle.close(); }
          catch { throw new AuthFailure('runtime_cleanup_failed'); }
          if (handle.closed !== true) throw new AuthFailure('runtime_cleanup_failed');
        }
      }
    });
  }
}
