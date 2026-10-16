import assert from 'node:assert/strict';
import { CycleEngine } from '../src/reset-cycles.mjs';
import { AccountAdapter } from '../src/account.mjs';
import { MockRpc } from './mock-rpc.mjs';

// The request owner in 17 will bridge CycleEngine's reservation and final dispatch.
// Build the exact durable journal here using 14, without sending a fake consume.
export async function reserve(store, id = 'selected-013', now = Math.floor(Date.now() / 1000)) {
  const rpc = new MockRpc();
  rpc.state.rows = [{ id, reset_type: 'codex_rate_limits', status: 'available', granted_at: '2026-10-01T00:00:00Z',
    expires_at: null }]; rpc.state.count = 1;
  let request;
  const engine = new CycleEngine(store, new AccountAdapter(rpc, { now: () => now }), {
    now: () => now, checkpoint: async (cut, row) => {
      if (cut === 'afterReserve') { request = row; throw new Error('reserved_without_send'); }
    } });
  await engine.command({ action: 'select', creditId: id, scheduledAt: now,
    commandId: `command-${id}`, expectedVersion: (await store.read()).version });
  // The weekly-only automation option gates every durable consume reservation.
  await engine.command({ action: 'weekly-auto', enabled: true, commandId: `weekly-${id}`,
    expectedVersion: (await store.read()).version });
  await assert.rejects(engine.run(), /reserved_without_send/);
  return { request, version: (await store.read()).version };
}

