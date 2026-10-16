import { RpcFailure } from './stdio.mjs';

// Only the serialized dispatch owner may establish that send() was never called.
export class ConsumeNotSent extends RpcFailure {
  constructor() { super('consume_not_sent'); }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const timestamp = value => Number.isSafeInteger(value);

export function validateAccountRequest(method, params) {
  const fields = {
    'account/read': ['refreshToken'],
    'account/rateLimits/read': ['excludeResetCreditDetails', 'supportsLunaReserve'],
    'account/rateLimitResetCredit/consume': ['creditId', 'idempotencyKey'],
  }[method];
  if (!fields || !object(params) || Object.keys(params).some(key => !fields.includes(key)) ||
      (method.endsWith('/consume') ? !fields.every(key => text(params[key])) :
        Object.values(params).some(value => typeof value !== 'boolean'))) throw new RpcFailure('invalid_account_params');
}

export function parseRateLimits(value) {
  if (!object(value) || !object(value.rateLimits)) throw new RpcFailure('invalid_read');
  const summary = value.rateLimitResetCredits;
  if (summary === null || summary === undefined) {
    return { kind: 'unavailable', availableCount: null, credits: [] };
  }
  if (!object(summary) || !Number.isSafeInteger(summary.availableCount) || summary.availableCount < 0) {
    throw new RpcFailure('invalid_read');
  }
  if (summary.credits === null || summary.credits === undefined) {
    return { kind: 'countOnly', availableCount: summary.availableCount, credits: [] };
  }
  if (!Array.isArray(summary.credits)) throw new RpcFailure('invalid_read');
  const ids = new Set();
  const credits = summary.credits.map(row => {
    if (!object(row) || !text(row.id) || ids.has(row.id) || !timestamp(row.grantedAt) ||
        (row.expiresAt !== undefined && row.expiresAt !== null && !timestamp(row.expiresAt)) ||
        !['codexRateLimits', 'unknown'].includes(row.resetType) ||
        !['available', 'redeeming', 'redeemed', 'unknown'].includes(row.status)) {
      throw new RpcFailure('invalid_read');
    }
    ids.add(row.id);
    return {
      id: row.id, resetType: row.resetType, status: row.status, grantedAt: row.grantedAt,
      expiry: row.expiresAt === undefined ? { kind: 'unknown' } :
        row.expiresAt === null ? { kind: 'none' } : { kind: 'at', unixSeconds: row.expiresAt },
    };
  });
  const availableRows = credits.filter(row => row.status === 'available').length;
  if (availableRows > summary.availableCount) throw new RpcFailure('invalid_read');
  return {
    kind: summary.availableCount > availableRows ? 'partial' : credits.length === 0 ? 'empty' : 'details',
    availableCount: summary.availableCount, credits,
  };
}

// Stock 0.160.1 exposes ordinaryUsageAllowed only for an identity-matched response.
// Bind that response to the caller's expected account; never infer the week from position.
export function weeklyEvidence(value, accountId, readStartedAt) {
  if (!text(accountId) || value?.accountId !== accountId || value.ordinaryUsageAllowed !== false) return null;
  const primary = value.rateLimits?.limitId === 'codex' ? value.rateLimits : null;
  const mapped = value.rateLimitsByLimitId?.codex;
  const candidates = [mapped, primary].filter(x => x !== null && x !== undefined);
  if (!candidates.length) return null;
  const weeks = candidates.map(b => {
    if (!object(b) || b.limitId !== 'codex' || b.rateLimitReachedType !== 'rate_limit_reached' || b.spendControlReached !== false) return null;
    const windows = [b.primary, b.secondary].filter(w => w !== null && w !== undefined);
    if (!windows.length || windows.some(w => !object(w) || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 ||
        ![300, 10080].includes(w.windowDurationMins) || !timestamp(w.resetsAt)) ||
        new Set(windows.map(w => w.windowDurationMins)).size !== windows.length) return null;
    const week = windows.find(w => w.windowDurationMins === 10080);
    return week?.usedPercent >= 100 && week.resetsAt > readStartedAt ? week.resetsAt : null;
  });
  if (weeks.some(w => w === null || w !== weeks[0])) return null;
  return Object.freeze({ accountId, readStartedAt, resetsAt: weeks[0] });
}

// Weekly usage for the watch rule (≥99%): the same identity binding and duration contract as
// weeklyEvidence, without requiring exhaustion. Never an authorization to consume.
export function weeklyUsage(value, accountId) {
  if (!text(accountId) || value?.accountId !== accountId) return null;
  const primary = value.rateLimits?.limitId === 'codex' ? value.rateLimits : null;
  const candidates = [value.rateLimitsByLimitId?.codex, primary].filter(x => x !== null && x !== undefined);
  const weeks = candidates.map(b => {
    if (!object(b) || b.limitId !== 'codex') return null;
    const windows = [b.primary, b.secondary].filter(w => w !== null && w !== undefined);
    if (!windows.length || windows.some(w => !object(w) || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 ||
        ![300, 10080].includes(w.windowDurationMins) || !timestamp(w.resetsAt)) ||
        new Set(windows.map(w => w.windowDurationMins)).size !== windows.length) return null;
    return windows.find(w => w.windowDurationMins === 10080) ?? null;
  });
  if (!weeks.length || weeks.some(w => w === null || w.usedPercent !== weeks[0].usedPercent || w.resetsAt !== weeks[0].resetsAt)) return null;
  return Object.freeze({ usedPercent: weeks[0].usedPercent, resetsAt: weeks[0].resetsAt });
}

export function weeklyCurrent(evidence, now, accountId) {
  return !!evidence && evidence.accountId === accountId && Number.isFinite(now) &&
    now >= evidence.readStartedAt && now < Math.min(evidence.resetsAt, evidence.readStartedAt + 300);
}

// Adapter history is in-memory; CycleEngine adds the durable reservation/recovery boundary.
// Reconnect preserves it; callers must not recreate this object to clear uncertainty.
export class AccountAdapter {
  constructor(rpc, { now = () => Date.now() / 1000, accountId = () => rpc.accountId } = {}) {
    this.rpc = rpc;
    this.now = now;
    this.accountId = accountId;
    this.requests = new Map();
    this.snapshot = null;
  }

  async read() {
    this.snapshot = null; // A failed fresh read cannot authorize use of a stale selectable row.
    const readStartedAt = this.now();
    const value = await this.rpc.request('account/rateLimits/read', {
      excludeResetCreditDetails: false, supportsLunaReserve: false,
    });
    const result = { ...parseRateLimits(value), weekly: weeklyEvidence(value, this.accountId(), readStartedAt),
      weeklyUsage: weeklyUsage(value, this.accountId()) };
    this.snapshot = result;
    return result;
  }

  weeklyReady(evidence = this.snapshot?.weekly) { return weeklyCurrent(evidence, this.now(), this.accountId()); }

  async refresh() {
    this.snapshot = null;
    const response = await this.rpc.request('account/read', { refreshToken: true });
    const external = this.rpc.authMode === 'chatgptAuthTokens';
    if (!object(response) || !object(response.account) ||
        !(external && response.account.type === undefined || ['chatgpt', 'chatgptAuthTokens'].includes(response.account.type))) {
      throw new RpcFailure('reconnect_required');
    }
    this.snapshot = null;
    return { kind: 'accountRead', authType: external ? 'chatgptAuthTokens' : response.account.type,
      tokenRefresh: external || response.account.type === 'chatgptAuthTokens' ? 'externalOwnerRequired' : 'requested' };
  }

  async reconnect() {
    this.snapshot = null;
    await this.rpc.close();
    await this.rpc.start();
    return this.read();
  }

  // requireWeekly=false only for a cycle without the weekly guard (expiry rule, manual apply-now).
  async consume({ creditId, idempotencyKey }, { dispatch = send => send(), refreshAfter = true, requireWeekly = true } = {}) {
    if (!text(creditId) || !text(idempotencyKey)) throw new RpcFailure('selected_id_and_key_required');
    if ([...this.requests.values()].some(row => row.state === 'unconfirmed')) {
      return { state: 'unconfirmed', reason: 'prior_outcome_unconfirmed', next: 'confirmPriorOutcome' };
    }
    if (this.requests.has(idempotencyKey)) {
      const previous = this.requests.get(idempotencyKey);
      if (previous.creditId !== creditId) throw new RpcFailure('key_bound_to_other_credit');
      return { ...previous.result, replayedLocally: true };
    }
    const selected = this.snapshot?.credits.find(row => row.id === creditId);
    if (!selected || selected.resetType !== 'codexRateLimits' || selected.status !== 'available' ||
        selected.expiry.kind === 'unknown' ||
        (selected.expiry.kind === 'at' && selected.expiry.unixSeconds <= this.now())) {
      throw new RpcFailure('selected_credit_not_eligible');
    }
    const evidence = this.snapshot?.weekly;
    if (requireWeekly && !this.weeklyReady(evidence)) throw new ConsumeNotSent();
    const validateSend = () => { if (requireWeekly && !this.weeklyReady(evidence)) throw new ConsumeNotSent(); };
    // Set BEFORE the first byte can leave; concurrent calls see this unresolved request.
    const record = { creditId, state: 'unconfirmed', result: null };
    this.requests.set(idempotencyKey, record);
    this.snapshot = null;
    let result;
    try {
      const response = await dispatch(() => {
        validateSend();
        return this.rpc.request('account/rateLimitResetCredit/consume', { creditId, idempotencyKey });
      }, validateSend);
      const outcomes = {
        reset: { state: 'applied', next: 'refreshLimits' },
        nothingToReset: { state: 'nothingToReset', next: 'newAttemptLaterWithNewKey' },
        noCredit: { state: 'noCredit', next: 'reconcileSelectedId' },
        // No echoed ID/key or proven backend key scope/TTL: insufficient selected-ID evidence.
        alreadyRedeemed: { state: 'unconfirmed', reason: 'redemption_identity_unproven', next: 'confirmPriorOutcome' },
      };
      result = object(response) && Object.keys(response).length === 1 &&
        typeof response.outcome === 'string' && Object.hasOwn(outcomes, response.outcome) ? outcomes[response.outcome] : null;
      result ??= { state: 'unconfirmed', reason: 'unknown_response', next: 'confirmPriorOutcome' };
    } catch (error) {
      result = error instanceof ConsumeNotSent ? { state: 'notSent', next: 'newAttemptLaterWithNewKey' } :
        { state: 'unconfirmed', reason: error instanceof RpcFailure ? error.kind : 'transport_failure',
          next: 'confirmPriorOutcome' };
    }
    record.state = result.state;
    record.result = { creditId, idempotencyKey, ...result };
    // A read failure never changes a confirmed consume into failure, or proves an unknown outcome.
    if (refreshAfter) {
      try { record.result.limits = await this.read(); }
      catch { record.result.limits = { kind: 'unavailable', availableCount: null, credits: [] }; }
    }
    return record.result;
  }
}
