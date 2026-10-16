import { mkdtemp, open, rm, lstat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AuthFailure, decodeBundle, bundleBytes, tuple, sameTuple, hash, grantFingerprint, makeBundle, validateAuth } from './auth-bundle.mjs';

const methods = new Set(['account/read', 'account/rateLimits/read', 'account/rateLimitResetCredit/consume']);
const receipt = (method, response) => method === 'account/read' ? 'accountRead' :
  method === 'account/rateLimits/read' ? 'limitsRead' :
    ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'].includes(response?.outcome) ? response.outcome : 'unknown';

// runtime.open(home) must provide request(), finish() and close(). finish() is a real
// auth barrier, not process exit or a successful account response. Stock 0.160.1 has none.
export class AuthSession {
  constructor({ store, secrets, runtime, snapshot, grant, owner }) {
    if (typeof owner !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner)) throw new AuthFailure('invalid_owner');
    this.store = store;
    this.secrets = secrets;
    this.runtime = runtime;
    this.bundle = decodeBundle(snapshot);
    this.fingerprint = grantFingerprint(grant);
    this.owner = owner;
    this.stopped = false;
    this.busy = false;
  }

  async admit() {
    const state = await this.store.read();
    if (state.disabled || state.revoked || state.reconnectRequested) throw new AuthFailure('disabled');
    if (!state.auth) throw new AuthFailure('auth_state_missing');
    validateAuth(state.auth);
    if (state.auth.protocol !== 1 || this.bundle.schema !== 1) throw new AuthFailure('incompatible_auth_protocol');
    const auth = state.auth;
    if (auth.grantFingerprint !== this.fingerprint) throw new AuthFailure('stale_grant');
    if (auth.reconnectReason || auth.phase === 'inflight') throw new AuthFailure('reconnect_required');
    if (auth.phase === 'publishing') {
      if (!sameTuple(tuple(this.bundle), auth.target)) throw new AuthFailure('stale_snapshot');
      // Only an exact Actions snapshot proves target possession after an interrupted PUT.
      await this.mutate(state.version, s => {
        s.auth.committed = s.auth.target;
        this.ready(s.auth);
      });
      return this.admit();
    }
    if (!sameTuple(tuple(this.bundle), auth.committed)) throw new AuthFailure('stale_snapshot');
    await this.secrets.preflight();
    return state;
  }

  ready(auth) { auth.phase = 'ready'; auth.target = null; auth.operationId = null; auth.owner = null; auth.transition = null; }
  async mutate(version, fn) {
    return (await this.store.update(state => {
      if (state.version !== version) throw new AuthFailure('state_conflict');
      fn(state);
    })).state;
  }

  async request(method, params, { dispatch = send => send() } = {}) {
    if (!methods.has(method)) throw new AuthFailure('method_forbidden');
    if (this.stopped) throw new AuthFailure('job_stopped');
    if (this.busy) throw new AuthFailure('auth_busy');
    this.busy = true;
    let home, processHandle, state;
    try {
      state = await this.admit();
      if (this.runtime?.authBarrierSupported !== true) throw new AuthFailure('runtime_auth_barrier_unavailable');
      const operationId = randomUUID();
      state = await this.mutate(state.version, s => {
        if (s.disabled || s.revoked || s.reconnectRequested || s.auth.phase !== 'ready') throw new AuthFailure('disabled');
        s.auth.phase = 'inflight'; s.auth.operationId = operationId; s.auth.owner = this.owner;
        s.auth.receipt = null; s.auth.transition = 'rotation';
      });
      // No process, filesystem restore or refresh before the confirmed durable intent.
      home = await mkdtemp(join(tmpdir(), 'auto-reset-auth-'));
      const file = await open(join(home, 'auth.json'), 'wx', 0o600);
      try { await file.writeFile(bundleBytes(this.bundle)); await file.sync(); } finally { await file.close(); }
      processHandle = await this.runtime.open(home);
      // The dispatch owner rechecks cycle deadline/disable/version at the actual send,
      // AFTER startup, which may have taken time. It must not launch another RPC.
      const response = await dispatch(() => processHandle.request(method, params));
      const barrier = await processHandle.finish();
      if (processHandle.closed !== true || barrier?.quiescent !== true || barrier.refreshSettled !== true || barrier.saveSucceeded !== true ||
          method === 'account/read' && params?.refreshToken === true && barrier.forcedRefreshSucceeded !== true) {
        throw new AuthFailure('runtime_barrier_failed');
      }
      const path = join(home, 'auth.json');
      const info = await lstat(path);
      if (!info.isFile() || info.size > 48 * 1024 || (info.mode & 0o777) !== 0o600) throw new AuthFailure('runtime_barrier_failed');
      const bytes = await readFile(path);
      const changed = hash(bytes) !== this.bundle.digest;
      const next = makeBundle(bytes, { previous: this.bundle });
      if (method === 'account/read' && params?.refreshToken === true && !changed) throw new AuthFailure('runtime_barrier_failed');
      // Preserve the receipt independently from raw response data (which can contain email).
      state = await this.mutate(state.version, s => {
        this.assertOperation(s, operationId);
        s.auth.receipt = receipt(method, response);
        if (changed) { s.auth.phase = 'publishing'; s.auth.target = tuple(next); }
        else this.ready(s.auth);
      });
      if (changed) {
        await this.secrets.publish(next);
        state = await this.mutate(state.version, s => {
          this.assertOperation(s, operationId);
          s.auth.committed = s.auth.target;
          this.ready(s.auth);
        });
        this.bundle = next;
      }
      return response;
    } catch (error) {
      this.stopped = true; // No refresh/consume/retry in the same job after any failure.
      const kind = error instanceof AuthFailure ? error.kind : 'auth_failed';
      if (state?.auth.phase === 'inflight' && ['runtime_barrier_failed', 'identity_changed', 'invalid_auth_bundle', 'auth_failed'].includes(kind)) {
        try { await this.mutate(state.version, s => {
          s.auth.reconnectReason = kind === 'runtime_barrier_failed' ? 'runtime_barrier_failed' : 'auth_failed';
        }); } catch { /* Inflight itself already forbids all stale sessions. */ }
      }
      throw new AuthFailure(kind);
    } finally {
      // Never remove plaintext while the process might still hold it. close must await exit.
      try { await processHandle?.close(); }
      catch { this.stopped = true; throw new AuthFailure('runtime_cleanup_failed'); }
      finally { if (home && (!processHandle || processHandle.closed === true)) await rm(home, { recursive: true, force: true }); }
      this.busy = false;
    }
  }
  assertOperation(state, id) {
    if (state.auth.operationId !== id || state.auth.owner !== this.owner) throw new AuthFailure('state_conflict');
  }
}
