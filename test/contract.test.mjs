import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AccountAdapter, weeklyEvidence, weeklyCurrent, weeklyUsage } from '../src/account.mjs';
import { MockRpc } from '../testing/mock-rpc.mjs';
import { credit, syntheticAccountId } from '../testing/fake-backend.mjs';

const real = process.env.AUTO_RESET_CONTRACT_MODE === 'app-server';
const fixture = async t => {
  let b;
  if (real) b = await (await import('../testing/bench.mjs')).bench();
  else { const rpc = new MockRpc(); b = { account: new AccountAdapter(rpc), rpc, backend: { state: rpc.state }, close: async () => {} }; }
  b.backend.state.weeklyExhausted = true;
  t.after(async () => {
    await b.close();
    assert.deepEqual(b.backend.state.violations, []);
    if (real) {
      assert.ok(b.audit.every(entry => !/^(turn|thread|model)\//.test(entry.method)));
      const allowed = new Set(['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'account/rateLimitResetCredit/consume']);
      assert.ok(b.audit.filter(entry => entry.direction === 'send').every(entry => allowed.has(entry.method)));
    }
  });
  return b;
};
const consumeRequests = b => b.backend.state.requests.filter(row => row.creditId);
const request = () => ({ creditId: 'selected-013', idempotencyKey: randomUUID() });

// The SAME suite is the offline contract set for 13 and later workflow integration (17).
test('selected ID, nullable expiry, refresh, consume and reconnect across stdio', async t => {
  const b = await fixture(t);
  assert.equal((await b.account.read()).kind, 'details');
  assert.deepEqual(b.account.snapshot.credits[1].expiry, { kind: 'none' });
  assert.equal((await b.account.refresh()).kind, 'accountRead');
  assert.equal(b.backend.state.refreshes, 1);
  if (real) assert.equal((await b.auth()).tokens.refresh_token, 'synthetic-refresh-1');
  await b.account.read();
  const attempt = request();
  assert.equal((await b.account.consume(attempt)).state, 'applied');
  assert.deepEqual(consumeRequests(b).map(({ creditId, idempotencyKey }) => ({ creditId, idempotencyKey })), [attempt]);
  await b.account.reconnect();
  assert.equal((await b.account.consume(attempt)).state, 'applied');
  assert.equal(consumeRequests(b).length, 1);
});

test('count-only, null, empty, capped details and invalid expiry', async t => {
  const b = await fixture(t);
  const state = b.backend.state;
  state.detailsStatus = 503;
  assert.equal((await b.account.read()).kind, 'countOnly');
  await assert.rejects(b.account.consume(request()), /selected_credit_not_eligible/);
  state.usageSummary = false;
  assert.equal((await b.account.read()).kind, 'unavailable');
  state.detailsStatus = 200;
  state.rows = [];
  state.count = 0;
  assert.equal((await b.account.read()).kind, 'empty');
  state.count = 2;
  assert.equal((await b.account.read()).kind, 'partial');
  state.rows = [credit()];
  assert.equal((await b.account.read()).kind, 'partial');
  state.rows = [credit('selected-013', { granted_at: 'broken' })];
  state.usageSummary = true;
  assert.equal((await b.account.read()).kind, 'countOnly');
  assert.equal(consumeRequests(b).length, 0);
});

test('unknown resetType/status, redeeming and redeemed rows cannot authorize consume', async t => {
  const b = await fixture(t);
  for (const extra of [{ reset_type: 'new_kind' }, { status: 'new_status' }, { status: 'redeeming' }, { status: 'redeemed' }]) {
    b.backend.state.rows = [credit('selected-013', extra)];
    await b.account.read();
    await assert.rejects(b.account.consume(request()), /selected_credit_not_eligible/);
  }
  assert.equal(consumeRequests(b).length, 0);
});

test('nothingToReset: same logical key does not send; next attempt uses new key and same ID', async t => {
  const b = await fixture(t);
  b.backend.state.outcome = 'nothing_to_reset';
  await b.account.read();
  const first = request();
  assert.equal((await b.account.consume(first)).state, 'nothingToReset');
  assert.equal((await b.account.consume(first)).replayedLocally, true);
  const next = request();
  assert.equal((await b.account.consume(next)).state, 'nothingToReset');
  assert.equal(consumeRequests(b).length, 2);
  assert.notEqual(first.idempotencyKey, next.idempotencyKey);
  await assert.rejects(b.account.consume({ ...first, creditId: 'other-013' }), /key_bound_to_other_credit/);
});

test('noCredit and missing selected ID never prove success or select the other credit', async t => {
  const b = await fixture(t);
  b.backend.state.outcome = 'no_credit';
  await b.account.read();
  assert.equal((await b.account.consume(request())).state, 'noCredit');
  b.backend.state.rows = [credit('other-013')];
  b.backend.state.count = 1;
  await b.account.read();
  await assert.rejects(b.account.consume(request()), /selected_credit_not_eligible/);
  assert.equal(consumeRequests(b).length, 1);
});

for (const scenario of ['already_redeemed', 'unknown', 'malformed', 'lost_response']) {
  test(`${scenario}: unresolved outcome blocks every consume, new key and reconnect included`, async t => {
    const b = await fixture(t);
    if (scenario === 'malformed') b.backend.state.malformed = true;
    else if (scenario === 'lost_response') b.backend.state.loss = true;
    else b.backend.state.outcome = scenario;
    await b.account.read();
    const first = request();
    assert.equal((await b.account.consume(first)).state, 'unconfirmed');
    await b.account.read();
    assert.equal((await b.account.consume(first)).state, 'unconfirmed');
    assert.equal((await b.account.consume(request())).state, 'unconfirmed');
    assert.equal((await b.account.consume({ ...request(), creditId: 'other-013' })).state, 'unconfirmed');
    await b.account.reconnect();
    assert.equal((await b.account.consume(request())).state, 'unconfirmed');
    assert.equal(consumeRequests(b).length, 1);
  });
}

test('concurrent consume and failure of post-consume read do not cause a second consume', async t => {
  const b = await fixture(t);
  await b.account.read();
  b.backend.state.usageStatus = 503;
  const pending = b.account.consume(request());
  assert.equal((await b.account.consume(request())).state, 'unconfirmed');
  const result = await pending;
  assert.equal(result.state, 'applied');
  assert.equal(result.limits.kind, 'unavailable');
  assert.equal(consumeRequests(b).length, 1);
});

// 32: weekly exhaustion evidence contract. The week is confirmed by windowDurationMins
// and the identity-bound denied response, never by primary/secondary position, an
// external five-hour signal or usage percent alone.
const READ = 1893456000;
const w = (usedPercent, windowDurationMins, resetsAt = READ + 604800) => ({ usedPercent, windowDurationMins, resetsAt });
const rates = (primary, secondary, extra = {}) => ({ limitId: 'codex', rateLimitReachedType: 'rate_limit_reached',
  spendControlReached: false, primary, secondary, ...extra });
const read = (rateLimits, overrides = {}) => ({ accountId: syntheticAccountId, ordinaryUsageAllowed: false, rateLimits, ...overrides });
const EVIDENCE = { accountId: syntheticAccountId, readStartedAt: READ, resetsAt: READ + 604800 };

for (const [name, value, expected] of [
  ['weekly exhaustion confirmed with a fresh five-hour window', read(rates(w(10, 300), w(100, 10080))), EVIDENCE],
  ['both windows exhausted still binds the weekly resetsAt', read(rates(w(100, 300), w(100, 10080))), EVIDENCE],
  ['swapped window positions resolve by duration', read(rates(w(100, 10080), w(100, 300))), EVIDENCE],
  ['mapped rateLimitsByLimitId is accepted like the primary block',
    read(undefined, { rateLimitsByLimitId: { codex: rates(w(10, 300), w(100, 10080)) } }), EVIDENCE],
  ['five-hour exhaustion alone is not weekly evidence', read(rates(w(100, 300), w(40, 10080))), null],
  ['allowed=true is not a denial', read(rates(w(10, 300), w(100, 10080)), { ordinaryUsageAllowed: true }), null],
  ['foreign account identity is not weekly evidence',
    read(rates(w(10, 300), w(100, 10080)), { accountId: 'account-other-001' }), null],
  ['spend control reached is not ordinary exhaustion', read(rates(w(10, 300), w(100, 10080), { spendControlReached: true })), null],
  ['non-ordinary reach type is not weekly evidence',
    read(rates(w(10, 300), w(100, 10080), { rateLimitReachedType: 'spend_limit_reached' })), null],
  ['missing weekly window is unknown', read(rates(w(100, 300), undefined)), null],
  ['unknown window duration is not a week', read(rates(w(100, 300), w(100, 1440))), null],
  ['repeated window durations are contradictory', read(rates(w(100, 300), w(100, 300))), null],
  ['weekly resetsAt in the past is stale on arrival', read(rates(w(10, 300), w(100, 10080, READ - 1))), null],
  ['non-integer weekly resetsAt is unknown', read(rates(w(10, 300), w(100, 10080, Number.NaN))), null],
  ['contradicting primary and mapped weeks are unknown',
    read(rates(w(10, 300), w(100, 10080, READ + 604800)), { rateLimitsByLimitId: { codex: rates(w(10, 300), w(100, 10080, READ + 1209600)) } }), null],
]) test(`weekly evidence: ${name}`, () => {
  assert.deepEqual(weeklyEvidence(value, syntheticAccountId, READ), expected);
});

// Watch rule (14 Oct): the weekly percent under the same identity/duration contract; never consume authority.
for (const [name, value, expected] of [
  ['allowed usage reports the weekly percent', read(rates(w(10, 300), w(99.4, 10080)), { ordinaryUsageAllowed: true }),
    { usedPercent: 99.4, resetsAt: READ + 604800 }],
  ['positions resolve by duration', read(rates(w(99, 10080), w(10, 300))), { usedPercent: 99, resetsAt: READ + 604800 }],
  ['foreign account identity is unknown', read(rates(w(10, 300), w(99, 10080)), { accountId: 'account-other-001' }), null],
  ['unknown duration is not a week', read(rates(w(10, 300), w(99, 1440))), null],
  ['missing weekly window is unknown', read(rates(w(10, 300), undefined)), null],
  ['contradicting primary and mapped weeks are unknown',
    read(rates(w(10, 300), w(99, 10080)), { rateLimitsByLimitId: { codex: rates(w(10, 300), w(50, 10080)) } }), null],
]) test(`weekly usage: ${name}`, () => {
  assert.deepEqual(weeklyUsage(value, syntheticAccountId), expected);
});

for (const [name, evidence, now, expected] of [
  ['current at the read moment', EVIDENCE, READ, true],
  ['current at the freshness edge minus one second', EVIDENCE, READ + 299, true],
  ['stale once 300s pass since the read started', EVIDENCE, READ + 300, false],
  ['invalid before the weekly resetsAt passes', { ...EVIDENCE, resetsAt: READ + 150 }, READ + 150, false],
  ['bound to the reading account only', { ...EVIDENCE, accountId: 'account-other-001' }, READ, false],
  ['missing evidence is not current', null, READ, false],
]) test(`weekly freshness: ${name}`, () => {
  assert.equal(weeklyCurrent(evidence, now, syntheticAccountId), expected);
});
