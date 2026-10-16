import { AccountAdapter } from './account.mjs';
import { AuthFailure, hostCredentials, bundleBytes } from '../session/auth-bundle.mjs';

// Bridges the fresh durable reservation to the host's one-use proof. The account
// parser/eligibility/outcome semantics stay in the shared AccountAdapter.
export class HostAccountAdapter extends AccountAdapter {
  constructor(session, options) {
    super({ authMode: 'chatgptAuthTokens', request: (method, params) => session.request(method, params) }, { ...options,
      accountId: () => hostCredentials(bundleBytes(session.bundle)).accountId });
    this.session = session;
    this.reservation = null;
    this.problem = null;
  }
  async read() {
    try { return await super.read(); }
    catch (error) { this.problem ??= error instanceof AuthFailure ? error.kind : 'account_read_failed'; throw error; }
  }
  async reserveConsume(reserve) {
    let result;
    const proof = await this.session.reserveConsume(async () => {
      result = await reserve();
      return { request: result.result, version: result.state.version };
    });
    this.reservation = proof ? { proof, request: result.result, version: result.state.version } : null;
    return result;
  }
  async consume(request, { dispatch, refreshAfter = true, requireWeekly = true } = {}) {
    const captured = this.reservation;
    this.reservation = null;
    if (!captured || request.requestId !== captured.request.requestId ||
        request.creditId !== captured.request.creditId || request.idempotencyKey !== captured.request.idempotencyKey) {
      throw new AuthFailure('consume_reservation_required');
    }
    return super.consume(request, { refreshAfter, requireWeekly, dispatch: async (_send, validateSend) => {
      let received = false, response;
      try {
        return await this.session.request('account/rateLimitResetCredit/consume', {
          creditId: request.creditId, idempotencyKey: request.idempotencyKey,
        }, {
          expectedVersion: captured.version, requestId: request.requestId, reservationProof: captured.proof,
          dispatch: send => send(), finalDispatch: (send, context) => dispatch(() => {
            validateSend(); return send();
          }, context),
          onResponse: value => { received = true; response = value; },
        });
      } catch (error) {
        this.problem ??= error instanceof AuthFailure ? error.kind : 'account_failed';
        if (received) return response; // Adapter still validates outcome and ID/key.
        throw error;
      }
    } });
  }
  async reconnect() { throw new AuthFailure('interactive_reconnect_required'); }
}
