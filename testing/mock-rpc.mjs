import { RpcFailure } from '../src/stdio.mjs';
import { credit, syntheticAccountId } from './fake-backend.mjs';

// Synthetic RPC fixture only; it is NOT the official App Server.
export class MockRpc {
  constructor() {
    this.accountId = syntheticAccountId;
    this.state = { count: 2, rows: [credit(), credit('other-013', { expires_at: null })],
      detailsStatus: 200, usageSummary: true, usageStatus: 200, refreshStatus: 200,
      outcome: 'reset', loss: false, malformed: false, requests: [], violations: [], refreshes: 0 };
  }
  async start() { return { userAgent: 'mock-app-server/0.160.1' }; }
  async close() {}
  async request(method, params) {
    if (method === 'account/read') {
      this.state.refreshes++;
      return { account: { type: 'chatgpt' } };
    }
    if (method === 'account/rateLimits/read') {
      if (this.state.usageStatus !== 200) throw new RpcFailure('rpc_error', -32603);
      const invalidTimestamp = this.state.rows.some(row => !Number.isFinite(Date.parse(row.granted_at)) ||
        (row.expires_at !== null && row.expires_at !== undefined && !Number.isFinite(Date.parse(row.expires_at))));
      const details = this.state.detailsStatus === 200 && !invalidTimestamp;
      return {
        accountId: this.accountId, ordinaryUsageAllowed: false,
        rateLimits: this.state.limits ?? { limitId: 'codex', rateLimitReachedType: 'rate_limit_reached', spendControlReached: false,
          primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 2000000000 },
          secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 2000000000 } },
        rateLimitResetCredits: !details && !this.state.usageSummary ? null : {
          availableCount: this.state.count,
          credits: !details ? null : this.state.rows.map(row => ({
            id: row.id, resetType: row.reset_type === 'codex_rate_limits' ? 'codexRateLimits' : 'unknown',
            status: ['available', 'redeeming', 'redeemed'].includes(row.status) ? row.status : 'unknown',
            grantedAt: Math.floor(Date.parse(row.granted_at) / 1000),
            expiresAt: row.expires_at == null ? null : Math.floor(Date.parse(row.expires_at) / 1000),
          })),
        },
      };
    }
    if (method === 'account/rateLimitResetCredit/consume') {
      this.state.requests.push({ creditId: params.creditId, idempotencyKey: params.idempotencyKey });
      if (this.state.loss || this.state.outcome === 'reset') {
        this.state.rows = this.state.rows.filter(row => row.id !== params.creditId);
        this.state.count = this.state.rows.length;
      }
      if (this.state.loss || this.state.malformed) throw new RpcFailure('rpc_error', -32603);
      const outcome = { reset: 'reset', already_redeemed: 'alreadyRedeemed',
        nothing_to_reset: 'nothingToReset', no_credit: 'noCredit' }[this.state.outcome];
      if (!outcome) throw new RpcFailure('rpc_error', -32603);
      return { outcome };
    }
    throw new RpcFailure('method_forbidden');
  }
}
