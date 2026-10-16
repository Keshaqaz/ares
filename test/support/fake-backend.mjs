import http from 'node:http';
import { once } from 'node:events';

export const syntheticAccountId = 'account-synthetic-013';
export function jwt(generation = 0) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({
    email: 'synthetic@example.invalid', exp: 4102444800, generation,
    'https://api.openai.com/auth': {
      chatgpt_account_id: syntheticAccountId, chatgpt_user_id: 'user-synthetic', chatgpt_plan_type: 'pro',
    },
  })}.synthetic-signature`;
}

export const credit = (id = 'selected-013', extra = {}) => ({
  id, reset_type: 'codex_rate_limits', status: 'available',
  granted_at: '2026-10-01T00:00:00Z', expires_at: '2099-10-01T00:00:00Z',
  title: null, description: null, ...extra,
});

// HTTP fixture, NOT an App Server RPC implementation. Never accepts real credentials.
export async function fakeBackend() {
  const state = {
    count: 2, rows: [credit(), credit('other-013', { expires_at: null })], detailsStatus: 200,
    outcome: 'reset', loss: false, malformed: false, requests: [], violations: [], refreshes: 0,
    usageSummary: true, usageStatus: 200, refreshStatus: 200, consumeStatus: 200,
  };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const path = req.url;
    const item = { method: req.method, path };
    state.requests.push(item);
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (path === '/oauth/token' && req.method === 'POST') {
      let data;
      try { data = JSON.parse(body); } catch { data = {}; }
      if (data.grant_type !== 'refresh_token' || !/^synthetic-refresh/.test(data.refresh_token ?? '')) {
        state.violations.push('unexpected_refresh');
        return send(403, {});
      }
      state.refreshes++;
      if (state.refreshStatus !== 200) return send(state.refreshStatus, { error: 'invalid_grant' });
      await state.beforeRefreshReply?.();
      return send(200, { access_token: jwt(state.refreshes), id_token: jwt(state.refreshes),
        refresh_token: `synthetic-refresh-${state.refreshes}`, token_type: 'Bearer' });
    }
    // Strict assertion, without retaining tokens in the audit log.
    if (!req.headers.authorization?.startsWith('Bearer ') ||
        ![jwt(0), ...Array.from({ length: state.refreshes }, (_, index) => jwt(index + 1))]
          .includes(req.headers.authorization.slice(7)) ||
        req.headers['chatgpt-account-id'] !== syntheticAccountId) {
      state.violations.push('unexpected_auth');
      return send(403, {});
    }
    if (path === '/api/codex/accounts/check' && req.method === 'GET') {
      return send(200, { accounts: [{ id: syntheticAccountId,
        workspace_backend_origin: 'https://chatgpt.com', account_routing_override: 'NO_CONSTRAINT', plan_type: 'pro' }] });
    }
    if (path === '/api/codex/usage' && req.method === 'GET') {
      const usage = {
        plan_type: 'pro', account_id: syntheticAccountId, user_id: 'user-synthetic',
        ...(state.weeklyExhausted ? { rate_limit_reached_type: { type: 'rate_limit_reached' }, spend_control: { reached: false } } : {}),
        rate_limit: { allowed: false, limit_reached: true,
          primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 60, reset_at: 2000000000 },
          secondary_window: state.weeklyExhausted ? { used_percent: 100, limit_window_seconds: 604800, reset_after_seconds: 60, reset_at: 2000000000 } : null },
        ...(state.usageSummary ? { rate_limit_reset_credits: { available_count: state.count } } : {}),
      };
      return send(state.usageStatus, state.transformUsage ? state.transformUsage(usage) : usage);
    }
    if (path === '/api/codex/rate-limit-reset-credits' && req.method === 'GET') {
      return send(state.detailsStatus, { available_count: state.count, credits: state.rows });
    }
    if (path === '/api/codex/rate-limit-reset-credits/consume' && req.method === 'POST') {
      let data;
      try { data = JSON.parse(body); } catch { data = {}; }
      item.creditId = data.credit_id;
      item.idempotencyKey = data.redeem_request_id;
      if (!data.credit_id || !data.redeem_request_id || Object.keys(data).length !== 2) {
        state.violations.push('unselected_consume');
        return send(400, {});
      }
      if (state.consumeStatus !== 200) return send(state.consumeStatus, {});
      if (state.loss) {
        // Simulate backend success while the reply is lost; disappearance proves nothing.
        state.rows = state.rows.filter(row => row.id !== data.credit_id);
        state.count = state.rows.length;
        req.socket.destroy();
        return;
      }
      if (state.malformed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{broken');
      }
      if (state.outcome === 'reset') {
        state.rows = state.rows.filter(row => row.id !== data.credit_id);
        state.count = state.rows.length;
      }
      await state.beforeConsumeReply?.();
      // A hook can model a successful mutation followed by an authorization error.
      return send(state.consumeStatus, { code: state.outcome, windows_reset: state.outcome === 'reset' ? 1 : 0 });
    }
    state.violations.push(`${req.method} ${path}`);
    return send(403, {});
  });
  // Proxy sink catches attempts to reach any endpoint except the allowed backend.
  server.on('connect', (req, socket) => {
    state.violations.push(`CONNECT ${req.url}`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, state, close: async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}
