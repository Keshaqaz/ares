import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubBilling } from '../src/github-billing.mjs';

const NOW = Date.UTC(2026, 9, 9, 3) / 1000;
const row = (extra = {}) => ({ product: 'Actions', sku: 'actions_linux', unitType: 'minutes',
  grossQuantity: 32, discountQuantity: 32, netQuantity: 0,
  grossAmount: 0.192, discountAmount: 0.192, netAmount: 0, ...extra });
const fixture = () => {
  const f = { now: NOW, date: NOW, calls: [], identity: { login: 'synthetic-owner', plan: { name: 'free' }, email: 'private@example.invalid' },
    report: { user: 'synthetic-owner', timePeriod: { year: 2026, month: 10 }, usageItems: [row()] } };
  f.billing = new GitHubBilling({ owner: 'synthetic-owner', token: 'synthetic-billing-token', now: () => f.now,
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
      assert.equal(options.headers.authorization, 'Bearer synthetic-billing-token');
      assert.equal(new URL(url).origin, 'https://api.github.com');
      f.calls.push(new URL(url).pathname);
      if (f.fail) throw new Error('Bearer synthetic-billing-token');
      return Response.json(url.endsWith('/user') ? f.identity : f.report,
        { status: f.status ?? 200, headers: { date: new Date(f.date * 1000).toUTCString() } });
    } });
  return f;
};

test('personal billing facts cover full month and distinguish storage without asserting quota or paid guard', async () => {
  const f = fixture();
  f.report.usageItems.push(row({ sku: 'actions_storage', unitType: 'gigabyte-hours', grossQuantity: 0.15, discountQuantity: 0.15 }));
  const facts = await f.billing.read();
  assert.deepEqual(facts, { observedAt: NOW, period: { start: Date.UTC(2026, 9, 1) / 1000, end: Date.UTC(2026, 10, 1) / 1000 },
    plan: 'free', reportedLinuxMinutes: 32, reportedPaidActionsAmount: 0, unsupportedSkus: [] });
  assert.deepEqual(f.calls, ['/user', '/users/synthetic-owner/settings/billing/usage/summary']);
  assert.ok(!/private@example|token|paidUsageBlocked|providerRemainingMinutes/.test(JSON.stringify(facts)));
});

test('other runner SKUs are explicit unknowns and paid Actions spend is retained', async () => {
  const f = fixture(); f.report.usageItems.push(row({ sku: 'actions_macos', netAmount: 0.1 }));
  const facts = await f.billing.read();
  assert.deepEqual(facts.unsupportedSkus, ['actions_macos']); assert.equal(facts.reportedLinuxMinutes, 32);
  assert.equal(facts.reportedPaidActionsAmount, 0.1);
});

test('zero-net storage discount exceeding gross does not invalidate the independent Linux minute report', async () => {
  const f = fixture();
  f.report.usageItems.push(row({ sku: 'actions_storage', unitType: 'gigabyte-hours',
    grossQuantity: 0.170068862, discountQuantity: 0.170894439, netQuantity: 0,
    grossAmount: 0.000057062, discountAmount: 0.000057339, netAmount: 0 }));
  const facts = await f.billing.read();
  assert.equal(facts.reportedLinuxMinutes, 32);
  assert.equal(facts.reportedPaidActionsAmount, 0);
  assert.deepEqual(facts.unsupportedSkus, []);
  for (const change of [
    r => { r.netAmount = 0.000001; },
    r => { r.netQuantity = 0.01; },
    r => { r.netAmount = -1; },
    r => { r.sku = 'actions_linux'; r.unitType = 'minutes'; },
    r => { r.unitType = 'unknown'; },
  ]) {
    const g = fixture(); g.report.usageItems.push(structuredClone(f.report.usageItems[1]));
    change(g.report.usageItems[1]);
    await assert.rejects(g.billing.read(), e => e.kind === 'billing_invalid_response');
  }
});

for (const [name, change, kind] of [
  ['token belongs to another owner', f => { f.identity.login = 'other-owner'; }, 'billing_owner_mismatch'],
  ['report belongs to another owner', f => { f.report.user = 'other-owner'; }, 'billing_owner_mismatch'],
  ['wrong month', f => { f.report.timePeriod.month = 9; }, 'billing_invalid_response'],
  ['daily subset', f => { f.report.timePeriod.day = 9; }, 'billing_invalid_response'],
  ['fractional Linux minutes', f => { f.report.usageItems[0].grossQuantity = 32.1; }, null],
  ['duplicate SKU', f => { f.report.usageItems.push(row()); }, 'billing_invalid_response'],
  ['negative amount', f => { f.report.usageItems[0].netAmount = -1; }, 'billing_invalid_response'],
  ['stale server response', f => { f.date -= 301; }, 'billing_response_stale'],
  ['future server response', f => { f.date += 1; }, 'billing_response_stale'],
  ['scope denied', f => { f.status = 403; }, 'billing_unavailable'],
  ['transport error', f => { f.fail = true; }, 'billing_unavailable'],
]) test(`billing ${name} cannot silently authorize unattended quota`, async () => {
  const f = fixture(); change(f);
  if (kind) await assert.rejects(f.billing.read(), error => error.kind === kind && !error.message.includes('synthetic-billing-token'));
  else assert.deepEqual((await f.billing.read()).unsupportedSkus, ['actions_linux']);
});

test('month changes while reading: stop instead of carrying the old allowance forward', async () => {
  const f = fixture(); let reads = 0;
  f.billing.now = () => ++reads === 4 ? Date.UTC(2026, 10, 1) / 1000 : NOW;
  await assert.rejects(f.billing.read(), error => error.kind === 'billing_period_changed');
});
