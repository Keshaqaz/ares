import sodium from 'libsodium-wrappers';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthFailure, decodeBundle, encodeBundle, bundleBytes, hostCredentials, tuple, sameTuple, grantFingerprint, hash } from './auth-bundle.mjs';
import { readQuotaReceipt } from '../workflow/private-job.mjs';
import { admitObserverQuota } from '../schedule/schedule-planner.mjs';
import { projectUsage } from '../account/check-observer.mjs';
import { HostOAuth } from './host-oauth.mjs';

const fail = kind => { throw new AuthFailure(kind); };
const history = s => hash(JSON.stringify([s.requests, s.cycles, s.groups]));
const fixed = e => new Set(['oauth_revoked', 'oauth_expired', 'oauth_reused', 'oauth_invalid_grant',
  'oauth_unconfirmed', 'oauth_rejected', 'oauth_invalid_response', 'oauth_revoke_rejected', 'oauth_revoke_unconfirmed',
  'quota_unavailable', 'service_quota_insufficient', 'provider_quota_insufficient', 'invalid_quota',
  'paid_usage_protection_required', 'serialized_writer_required', 'durable_revoke_required', 'state_readback_failed',
  'verifier_state_changed', 'access_expired', 'access_expiry_unknown', 'baseline_unconfirmed', 'probe_window_missed',
  'runtime_cleanup_failed']).has(e?.kind) ? e.kind : 'verification_unknown';

export function validateRevokePlan(p) {
  if (!p || Object.keys(p).some(k => !['schema', 'futureMinutes', 'oldRefresh', 'quarantinePublicKey'].includes(k)) ||
      p.schema !== 1 || !Number.isSafeInteger(p.futureMinutes) || p.futureMinutes < 0 || typeof p.oldRefresh !== 'boolean') fail('invalid_revoke_plan');
  if (p.oldRefresh) {
    if (typeof p.quarantinePublicKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(p.quarantinePublicKey) ||
        Buffer.from(p.quarantinePublicKey, 'base64').length !== 32) fail('quarantine_key_required');
  } else if (p.quarantinePublicKey !== undefined) fail('invalid_revoke_plan');
}

// Capability deliberately has only one read method. No HostAuthSession guard is changed.
// A fresh isolated stock child is terminated and its private home removed per probe.
export function createRevokeVerifier({ runtime, tokens, expiresAt, now, admit, fetchImpl = fetch,
  syntheticBackend = null }) {
  if (syntheticBackend && !/^http:\/\/127\.0\.0\.1:\d+$/.test(syntheticBackend)) fail('invalid_verifier_backend');
  let access = { ...tokens };
  const base = syntheticBackend ? `${syntheticBackend}/api/codex` : 'https://chatgpt.com/backend-api/wham';
  return {
    async probe() {
      if (!access) fail('verifier_closed');
      if (now() >= expiresAt) return { state: 'naturalExpiry', at: now(), beforeExpiry: false };
      await admit();
      let handle, value, rpcFailed = false;
      try {
        handle = await runtime.open({ ...access });
        await admit(); // after async child startup, immediately before account RPC
        if (now() >= expiresAt) fail('access_expired');
        value = await handle.request('account/rateLimits/read', { excludeResetCreditDetails: false, supportsLunaReserve: false });
      } catch { rpcFailed = true; }
      finally {
        if (handle) { try { await handle.close(); } catch { fail('runtime_cleanup_failed'); } }
      }
      if (!rpcFailed) {
        if (now() >= expiresAt) return { state: 'naturalExpiry', at: now(), beforeExpiry: false };
        const p = projectUsage(value, access.chatgptAccountId, now());
        return { state: p.identityMatches && ['details', 'empty'].includes(p.details.kind) ? 'success' : 'unknown',
          at: now(), beforeExpiry: now() < expiresAt, identityMatches: p.identityMatches, details: p.details };
      }
      // Stock intentionally erases HTTP error text. Corroborate with exactly one
      // GET per capability; never parse/log the body, never infer 401 from rpc_error.
      const capabilities = {};
      for (const [name, path] of [['usage', '/usage'], ['details', '/rate-limit-reset-credits']]) {
        await admit();
        if (now() >= expiresAt) { capabilities[name] = { state: 'naturalExpiry', status: null }; continue; }
        try {
          const requestAt = now();
          const response = await fetchImpl(base + path, { method: 'GET', redirect: 'error',
            signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${access.accessToken}`,
              'chatgpt-account-id': access.chatgptAccountId } });
          await response.body?.cancel();
          capabilities[name] = { status: response.status, requestAt, responseAt: now(), state: response.status === 401 && now() < expiresAt ?
            'authDeniedBeforeExpiry' : 'unknown' }; // HTTP200 alone is not valid details.
        } catch { capabilities[name] = { status: null, state: 'unknown' }; }
      }
      return { state: Object.values(capabilities).every(c => c.state === 'authDeniedBeforeExpiry') ?
        'authDeniedBeforeExpiry' : 'unknown', at: now(), beforeExpiry: now() < expiresAt, capabilities };
    },
    close() { if (access) { access.accessToken = ''; access.chatgptAccountId = ''; } access = null; },
  };
}

// Called only inside the installation writer, from an exact encrypted admin command.
// Durable local revoke is itself the non-retry marker, including a lost HTTP response.
export async function runRevokeValidation({ admin, storage, workflow, serialization, snapshot, grant,
  expectedVersion, oauth, runtime, quotaProvider, plan, now = () => Math.floor(Date.now() / 1000),
  sleep = seconds => delay(seconds * 1000), fetchImpl = fetch, syntheticBackend = null }) {
  validateRevokePlan(plan);
  if (plan.oldRefresh) {
    await sodium.ready;
    try { sodium.crypto_box_seal(Buffer.from('quarantine-key-preflight'), Buffer.from(plan.quarantinePublicKey, 'base64')); }
    catch { fail('quarantine_key_required'); }
  }
  let bundle = decodeBundle(snapshot);
  let credentials = hostCredentials(bundleBytes(bundle));
  if (credentials.expiresAt === null) fail('access_expiry_unknown');
  // 300s observation + bounded startup/HTTP/provider overhead, no refresh to extend it.
  if (credentials.expiresAt <= now() + 420) fail('access_expired');
  let expected = await storage.read();
  const originalHistory = history(expected), expiry = credentials.expiresAt;
  const report = { schema: 1, preparation: false, generation: bundle.generation, expiresAt: expiry,
    tupleHash: hash(JSON.stringify(tuple(bundle))), historyHash: originalHistory,
    localStopped: false, revoke: 'notSent', propagation: 'unverified',
    probes: [], refresh: plan.oldRefresh ? 'notSent' : 'notAuthorized' };
  const check = async () => {
    await serialization.assertOwner();
    const s = await storage.read();
    if (JSON.stringify(s) !== JSON.stringify(expected) || history(s) !== originalHistory || !s.disabled ||
        s.auth?.phase !== 'ready' || s.auth.protocol !== 2 || !sameTuple(s.auth.committed, tuple(bundle)) ||
        s.auth.grantFingerprint !== grantFingerprint(grant) || (await workflow.read()).expressions.length) fail('verifier_state_changed');
    return s;
  };
  const admit = async () => {
    await check();
    if (!quotaProvider) fail('quota_unavailable');
    const receipt = await quotaProvider();
    const quota = readQuotaReceipt(JSON.stringify(receipt), now());
    if (!quota || !Number.isSafeInteger(receipt.evidence?.outstandingMinutes) || receipt.evidence.outstandingMinutes < 10) fail('quota_unavailable');
    admitObserverQuota(quota, now(), plan.futureMinutes);
    await check();
    if (now() >= Math.min(quota.validUntil, quota.periods[0].end)) fail('quota_unavailable');
    if (report.cutoff && now() >= report.cutoff) fail('probe_window_missed');
  };
  // Production uses HostOAuth's pinned endpoints. Capture status only; test
  // adapters may supply an in-memory OAuth object instead.
  const transport = oauth instanceof HostOAuth ? new HostOAuth({ now, timeoutMs: oauth.timeoutMs,
    syntheticEndpoint: oauth.endpoint.startsWith('http://127.0.0.1:') ? oauth.endpoint : null,
    fetchImpl: async (url, options) => {
      const response = await oauth.fetch(url, options);
      const stage = url.endsWith('/revoke') ? 'revokeHttpStatus' : 'refreshHttpStatus';
      report[stage] = response.status;
      if (stage === 'refreshHttpStatus' && (response.status >= 500 || response.status === 429)) {
        await response.body?.cancel(); fail('oauth_unconfirmed');
      }
      return response;
    } }) : oauth;
  const verifier = createRevokeVerifier({ runtime, tokens: { accessToken: credentials.auth.tokens.access_token,
    chatgptAccountId: credentials.accountId, ...(credentials.planType ? { chatgptPlanType: credentials.planType } : {}) },
    expiresAt: expiry, now, admit, fetchImpl, syntheticBackend });
  try {
    if (expected.version !== expectedVersion || expected.revoked) fail('durable_revoke_required');
    report.baseline = await verifier.probe();
    if (report.baseline.state !== 'success' || !report.baseline.beforeExpiry || expiry <= now() + 420) fail('baseline_unconfirmed');
    await admit();
    expected = await admin.disable(expected.version, { revoke: true });
    await admin.confirm(expected);
    await check();
    report.localStopped = true;
    await admit();
    // No asynchronous work between the durable marker and the single admin call
    // except mandatory readbacks/admission. Crashed jobs cannot repeat this call.
    report.revoke = 'unconfirmed'; report.revokeAt = now();
    try { report.revoke = (await admin.revokeSession(encodeBundle(bundle), grant, expected.version, transport)).kind; }
    catch (error) { report.errorKind = fixed(error); return report; }
    const t0 = now(); report.observationStart = t0; report.cutoff = t0 + 345;
    for (const offset of [0, 60, 300]) {
      await sleep(Math.max(0, t0 + offset - now()));
      if (now() > t0 + offset + 30 || now() >= report.cutoff) fail('probe_window_missed');
      const probe = await verifier.probe(); report.probes.push({ offset, ...probe });
      if (probe.state !== 'success') { report.stopReason = probe.state; break; }
    }
    if (plan.oldRefresh && !report.probes.some(p => ['unknown', 'naturalExpiry'].includes(p.state))) {
      await sleep(Math.max(0, t0 + 300 - now()));
      if (now() > t0 + 330) fail('probe_window_missed');
      await admit();
      report.refresh = 'unconfirmed';
      report.refreshRequestAt = now();
      try {
        const target = await transport.refresh(bundle); // Exactly one; never publish or runtime.open(target).
        await sodium.ready;
        report.quarantine = { algorithm: 'libsodium-sealed-box',
          ciphertext: Buffer.from(sodium.crypto_box_seal(Buffer.from(encodeBundle(target)),
            Buffer.from(plan.quarantinePublicKey, 'base64'))).toString('base64') };
        report.refresh = 'successQuarantined'; report.stopReason = 'cleanupDecisionRequired';
      } catch (error) { report.refresh = fixed(error); }
      report.refreshResponseAt = now();
    }
    await check();
    report.finalVersion = expected.version;
    return report;
  } catch (error) { report.errorKind = fixed(error); return report; }
  finally {
    verifier.close();
    credentials.auth.tokens.access_token = ''; credentials.auth.tokens.refresh_token = ''; credentials.auth.tokens.id_token = '';
    credentials = null; bundle = null; snapshot = null;
    // JS cannot promise physical erasure of immutable strings. Owned child homes
    // are removed by runtime.close; process exit is the final memory boundary.
  }
}
