const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));
const sha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const id = x => typeof x === 'string' && x.length > 0 && x.length <= 256;
const code = x => typeof x === 'string' && /^[a-z][a-z0-9_]{0,127}$/.test(x);
const metadata = v => only(v, ['kind', 'availableCount', 'credits']) &&
  ['unavailable', 'empty', 'countOnly', 'partial', 'details'].includes(v.kind) &&
  (v.availableCount === null || Number.isSafeInteger(v.availableCount) && v.availableCount >= 0) &&
  Array.isArray(v.credits) && v.credits.every(c => only(c, ['id', 'resetType', 'status', 'grantedAt', 'expiry']) &&
    id(c.id) && ['codexRateLimits', 'unknown'].includes(c.resetType) &&
    ['available', 'redeeming', 'redeemed', 'unknown'].includes(c.status) && Number.isSafeInteger(c.grantedAt) &&
    only(c.expiry, ['kind', 'unixSeconds']) && (['unknown', 'none'].includes(c.expiry.kind) && c.expiry.unixSeconds === undefined ||
      c.expiry.kind === 'at' && Number.isSafeInteger(c.expiry.unixSeconds)));
const quota = q => only(q, ['policy', 'verified', 'checkedAt']) && typeof q.verified === 'boolean' &&
  (q.checkedAt === undefined || Number.isSafeInteger(q.checkedAt) && q.checkedAt >= 0) &&
  (!q.verified || q.checkedAt !== undefined) &&
  only(q.policy, ['schema', 'repository', 'budget', 'stopUsage', 'verifiedAt', 'plan']) &&
  q.policy.schema === 1 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(q.policy.repository) &&
  q.policy.budget === 0 && q.policy.stopUsage === true &&
  Number.isSafeInteger(q.policy.verifiedAt) && q.policy.verifiedAt >= 0 && ['free', 'pro'].includes(q.policy.plan);
// External timer: the timer app (ticket 42) — App ID, slug for its settings link, installation
// ID — or, until c moves it to the app, the timer token's expiry (ticket 38). Either way a pending
// probe slot and its confirmation by an empty dispatch.
const time = x => x === null || Number.isSafeInteger(x) && x >= 0;
const positive = x => Number.isSafeInteger(x) && x > 0;
export const timerApp = t => only(t, ['appId', 'appSlug', 'installationId']) && positive(t.appId) && positive(t.installationId) &&
  typeof t.appSlug === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(t.appSlug);
const timer = t => object(t) && time(t.probeAt) && time(t.confirmedAt) && (t.confirmedAt === null || t.probeAt !== null && t.confirmedAt >= t.probeAt) &&
  (Object.hasOwn(t, 'expiresAt') ? only(t, ['expiresAt', 'probeAt', 'confirmedAt']) && Number.isSafeInteger(t.expiresAt) && t.expiresAt >= 0 :
    only(t, ['appId', 'appSlug', 'installationId', 'probeAt', 'confirmedAt']) &&
    timerApp({ appId: t.appId, appSlug: t.appSlug, installationId: t.installationId }));
// Installation token expiry (ticket 40); null when unknown. Absent only in state written before 40.
const grant = g => g === null || only(g, ['expiresAt']) && time(g.expiresAt);
export function validInstallation(i) {
  return only(i, ['programCommit', 'seedSession', 'checkedSession', 'operation', 'metadata', 'quota', 'timer', 'grant']) &&
    sha(i.programCommit) && (i.quota === undefined || i.quota === null || quota(i.quota)) &&
    (i.timer === undefined || i.timer === null || timer(i.timer)) && (i.grant === undefined || grant(i.grant)) && (i.metadata === undefined || i.metadata === null || metadata(i.metadata)) &&
    [i.seedSession, i.checkedSession].every(x => x === null || id(x)) &&
    (i.operation === null || only(i.operation, ['commandId', 'fingerprint', 'action', 'phase', 'problem', 'quotaPublication']) &&
      (i.operation.quotaPublication === undefined || i.operation.quotaPublication === true) && id(i.operation.commandId) && /^[a-f0-9]{64}$/.test(i.operation.fingerprint) && /^[a-z][a-z0-9_-]{0,127}$/.test(i.operation.action) &&
      ['pending', 'done'].includes(i.operation.phase) && (i.operation.problem === undefined || i.operation.problem === null || code(i.operation.problem)));
}
