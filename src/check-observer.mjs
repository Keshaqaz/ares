import { readFile } from 'node:fs/promises';
import { AuthFailure, hostCredentials, bundleBytes } from './auth-bundle.mjs';
import { parseRateLimits } from './account.mjs';
import { readQuotaReceipt } from './private-job.mjs';
import { admitObserverQuota } from './schedule-planner.mjs';

const pins = JSON.parse(await readFile(new URL('../runtime-lock.json', import.meta.url), 'utf8'));
const reasons = new Set(['rate_limit_reached', 'workspace_member_usage_limit_reached', 'workspace_owner_usage_limit_reached',
  'workspace_owner_credits_depleted', 'workspace_member_credits_depleted']);
const errors = new Set(['refresh_required', 'external_refresh_required', 'access_expired', 'rpc_error', 'rpc_timeout',
  'reconnect_required', 'state_conflict', 'stale_snapshot', 'stale_grant', 'serialized_writer_required',
  'runtime_cleanup_failed', 'unsupported_account', 'invalid_read', 'quota_unavailable', 'invalid_quota',
  'paid_usage_protection_required', 'service_quota_insufficient', 'provider_quota_insufficient',
  'observer_requires_disabled', 'quota_provider_required', 'quota_current_job_missing']);
// Other Failure kinds (transport, runtime, billing) are snake_case code constants,
// never message text; anything else stays a fixed observer_failed.
const fixedError = error => errors.has(error?.kind) ||
  typeof error?.kind === 'string' && error.kind.length <= 64 && /^[a-z]+(_[a-z0-9]+)*$/.test(error.kind) ?
  error.kind : 'observer_failed';
const window = w => w && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 &&
  Number.isSafeInteger(w.windowDurationMins) && w.windowDurationMins > 0 && Number.isSafeInteger(w.resetsAt) ?
  { usedPercent: w.usedPercent, windowDurationMins: w.windowDurationMins, resetsAt: w.resetsAt } : null;
const bucket = b => ({ primary: window(b?.primary), secondary: window(b?.secondary),
  denialReason: reasons.has(b?.rateLimitReachedType) ? b.rateLimitReachedType : 'unknown',
  spendControlReached: typeof b?.spendControlReached === 'boolean' ? b.spendControlReached : null });

// No free-form strings, IDs, response bodies or credential material enter this projection.
export function projectUsage(value, accountId, responseAt) {
  const ordinaryUsageAllowed = typeof value?.ordinaryUsageAllowed === 'boolean' ? value.ordinaryUsageAllowed : null;
  // Stock 0.160.1 supplies a boolean only after BOTH backend account/user match
  // the external auth identity. Still compare its accountId to the current Secret.
  const identityMatches = value?.accountId === accountId && ordinaryUsageAllowed !== null;
  const codex = value?.rateLimitsByLimitId?.codex ?? (value?.rateLimits?.limitId === 'codex' ? value.rateLimits : null);
  const projected = { codex: bucket(codex) };
  let details, detailsErrorKind = null;
  try {
    const metadata = parseRateLimits(value);
    details = { kind: metadata.kind, count: metadata.availableCount };
  } catch { details = { kind: 'invalid', count: null }; detailsErrorKind = 'invalid_read'; }
  const windows = [projected.codex.primary, projected.codex.secondary].filter(Boolean);
  const zeroObserved = identityMatches && ordinaryUsageAllowed === false &&
    projected.codex.denialReason === 'rate_limit_reached' && projected.codex.spendControlReached === false &&
    windows.some(w => w.usedPercent >= 100 && w.resetsAt > responseAt);
  return { identityMatches, ordinaryUsageAllowed, buckets: projected, details, detailsErrorKind, zeroObserved };
}

export async function runCheckObserver({ session, storage, workflow, quotaProvider, futureMinutes, now }) {
  const result = { schema: 1, node: pins.node, appServer: pins.appServer.version,
    generation: session.bundle.generation, account: { state: 'notSent' }, usage: { state: 'notSent' },
    details: { kind: 'unavailable', count: null }, zeroReadConfirmed: false, errorKind: null };
  const accountId = hostCredentials(bundleBytes(session.bundle)).accountId;
  let stage = 'account', validUntil = null;
  const admit = async send => {
    const state = await storage.read();
    if (!state.disabled || state.revoked || (await workflow.read()).expressions.length) throw new AuthFailure('observer_requires_disabled');
    if (!quotaProvider) throw new AuthFailure('quota_provider_required');
    const receipt = await quotaProvider();
    const quota = readQuotaReceipt(JSON.stringify(receipt), now());
    if (!quota || !Number.isSafeInteger(receipt.evidence?.outstandingMinutes) || receipt.evidence.outstandingMinutes < 10) {
      throw new AuthFailure('quota_unavailable');
    }
    admitObserverQuota(quota, now(), futureMinutes);
    validUntil = Math.min(quota.validUntil, quota.periods[0].end);
    // Recheck writer/version/expiry after the asynchronous provider and right
    // before the RPC. No await separates the final guard from send().
    return send();
  };
  try {
    for (stage of ['account', 'usage']) {
      const expectedVersion = (await storage.read()).version;
      // Reject missing/stale quota before starting a runtime as well as after startup.
      await admit(() => undefined);
      result[stage] = { state: 'notSent', version: expectedVersion, requestAt: null, responseAt: null };
      const options = { allowRefresh: false, dispatch: admit,
        finalDispatch: send => {
          if (now() >= validUntil) throw new AuthFailure('quota_unavailable');
          result[stage].requestAt = now(); result[stage].state = 'sent'; return send(); },
        onResponse: value => {
          const responseAt = now();
          result[stage].responseAt = responseAt; result[stage].state = 'received';
          if (stage === 'account') {
            if (!value?.account || ![undefined, 'chatgpt', 'chatgptAuthTokens'].includes(value.account.type)) throw new AuthFailure('unsupported_account');
          } else {
            const projection = projectUsage(value, accountId, responseAt);
            result.usage = { ...result.usage, ...projection };
            result.details = projection.details;
            if (projection.detailsErrorKind) throw new AuthFailure(projection.detailsErrorKind);
            result.zeroReadConfirmed = projection.zeroObserved && result.account.state === 'received' &&
              ['details', 'empty', 'partial'].includes(projection.details.kind);
          }
        } };
      if (stage === 'account') await session.setupRead(expectedVersion, options);
      else await session.setupMetadata(expectedVersion, options);
    }
  } catch (error) {
    result.errorKind = fixedError(error);
    if (result[stage].state !== 'received') result[stage].state = 'failed';
    result.zeroReadConfirmed = false;
  }
  return result;
}
