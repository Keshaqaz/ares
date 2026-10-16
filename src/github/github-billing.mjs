import { StateFailure } from '../core/state-store.mjs';

const fail = kind => { throw new StateFailure(kind); };
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const periodAt = now => {
  const date = new Date(now * 1000), year = date.getUTCFullYear(), month = date.getUTCMonth() + 1;
  return { year, month, start: Date.UTC(year, month - 1, 1) / 1000, end: Date.UTC(year, month, 1) / 1000 };
};

// Billing facts only. A fresh HTTP response does not prove that all jobs have
// reached billing, the included allowance, or a hard-stop budget setting.
// Keep those unknowns out of a SchedulePlanner quota receipt.
export class GitHubBilling {
  constructor({ owner, token, fetchImpl = fetch, now = () => Math.floor(Date.now() / 1000), timeoutMs = 15_000 }) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner ?? '') || typeof token !== 'string' || !token ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail('invalid_billing_configuration');
    this.owner = owner; this.token = token; this.fetch = fetchImpl; this.now = now; this.timeoutMs = timeoutMs;
  }

  async read() {
    const startedAt = this.now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) fail('invalid_clock');
    const period = periodAt(startedAt);
    const get = async path => {
      try {
        const response = await this.fetch(`https://api.github.com${path}`, { method: 'GET', redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs), headers: { authorization: `Bearer ${this.token}`,
            accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' } });
        if (response.status !== 200) fail('billing_unavailable');
        const serverAt = Date.parse(response.headers.get('date')) / 1000;
        const at = this.now();
        if (!Number.isSafeInteger(at) || !Number.isSafeInteger(serverAt) || serverAt > at || at - serverAt > 300) {
          fail('billing_response_stale');
        }
        const raw = await response.text();
        if (Buffer.byteLength(raw) > 2 * 1024 * 1024) fail('billing_invalid_response');
        return { value: JSON.parse(raw), serverAt };
      } catch (error) {
        if (error instanceof StateFailure) throw error;
        fail('billing_unavailable');
      }
    };
    const identity = await get('/user');
    if (identity.value?.login?.toLowerCase() !== this.owner.toLowerCase()) fail('billing_owner_mismatch');
    if (!['free', 'pro'].includes(identity.value?.plan?.name)) fail('billing_plan_unsupported');
    const report = await get(`/users/${this.owner}/settings/billing/usage/summary?year=${period.year}&month=${period.month}`);
    const value = report.value;
    if (value?.user?.toLowerCase() !== this.owner.toLowerCase()) fail('billing_owner_mismatch');
    if (value.timePeriod?.year !== period.year || value.timePeriod?.month !== period.month ||
        value.timePeriod?.day != null || !Array.isArray(value.usageItems)) fail('billing_invalid_response');
    let reportedLinuxMinutes = 0, reportedPaidActionsAmount = 0;
    const unsupportedSkus = new Set(), seen = new Set();
    for (const row of value.usageItems) {
      if (typeof row?.product !== 'string') fail('billing_invalid_response');
      if (row.product.toLowerCase() !== 'actions') continue;
      // GitHub's zero-net storage aggregate can report a discount greater than
      // gross. Storage is not runner minutes; keep its reported net charge and
      // do not infer a negative charge or change Linux minute admission.
      const zeroNetStorage = row.sku === 'actions_storage' && row.unitType === 'gigabyte-hours' &&
        row.netQuantity === 0 && row.netAmount === 0;
      if (typeof row.sku !== 'string' || !row.sku || seen.has(row.sku) ||
          !['grossQuantity', 'discountQuantity', 'netQuantity', 'grossAmount', 'discountAmount', 'netAmount']
            .every(key => amount(row[key])) || (!zeroNetStorage && row.discountQuantity > row.grossQuantity) ||
          row.netQuantity > row.grossQuantity || (!zeroNetStorage && row.discountAmount > row.grossAmount) || row.netAmount > row.grossAmount) {
        fail('billing_invalid_response');
      }
      seen.add(row.sku);
      reportedPaidActionsAmount += row.netAmount;
      if (row.sku === 'actions_linux' && row.unitType === 'minutes' && Number.isSafeInteger(row.grossQuantity)) {
        reportedLinuxMinutes += row.grossQuantity;
      } else if (row.sku !== 'actions_storage' || row.unitType !== 'gigabyte-hours') unsupportedSkus.add(row.sku);
    }
    const finishedAt = this.now();
    if (!Number.isSafeInteger(finishedAt) || finishedAt < startedAt || finishedAt - startedAt > 300 ||
        periodAt(finishedAt).start !== period.start) fail('billing_period_changed');
    if (finishedAt - Math.min(identity.serverAt, report.serverAt) > 300) fail('billing_response_stale');
    if (!Number.isSafeInteger(reportedLinuxMinutes) || !amount(reportedPaidActionsAmount)) fail('billing_invalid_response');
    return { observedAt: Math.min(identity.serverAt, report.serverAt),
      period: { start: period.start, end: period.end }, plan: identity.value.plan.name,
      reportedLinuxMinutes, reportedPaidActionsAmount, unsupportedSkus: [...unsupportedSkus].sort() };
  }
}
