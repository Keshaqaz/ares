import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { initialState } from '../src/core/state-store.mjs';
import { renderMonitor, monitorKey, monitorResets, runMonitor, paint } from '../src/installer/monitor-ui.mjs';

const NOW = 1791417600;
const credit = (id, expiry, status = 'available') => ({ id, resetType: 'codexRateLimits', status, grantedAt: NOW - 9000,
  expiry: expiry === null ? { kind: 'none' } : { kind: 'at', unixSeconds: expiry } });
function state({ credits = [credit('late', NOW + 90000), credit('soon', NOW + 1200)], kind = 'details' } = {}) {
  const s = initialState('ru');
  s.installation = { programCommit: 'a'.repeat(40), seedSession: null, checkedSession: null, operation: null,
    metadata: { kind, availableCount: credits.length, credits } };
  return s;
}
const text = (s, view, options = {}) => renderMonitor(s, { screen: 'monitor', focus: 'list', selected: 0, cursor: 0, confirm: null, ...view },
  { now: NOW, width: 80, ...options }).map(l => paint(l, false));
const key = name => ({ name, sequence: name });

test('monitor lists available resets by expiry; applied, expired and foreign types stay hidden', () => {
  const s = state({ credits: [credit('late', NOW + 90000), credit('soon', NOW + 1200), credit('gone', NOW - 1),
    credit('used', NOW + 5000), credit('redeemed', NOW + 5000, 'redeemed'), credit('forever', null)] });
  s.cycles.push({ creditId: 'used', status: 'applied', current: true });
  assert.deepEqual(monitorResets(s, NOW).map(r => r.id), ['soon', 'late', 'forever']);
  const lines = text(s);
  assert.match(lines.join('\n'), /ВЫДАННЫЕ СБРОСЫ · 3/);
  assert.match(lines.join('\n'), /☐ за 30 минут до истечения/);
  assert.match(lines.join('\n'), /☐ автоматически при исчерпании недельной квоты/);
  assert.ok(lines.every(l => [...l].length <= 80), 'every line fits the width: a wrap would break the in-place redraw');
});

test('rule windows, running attempts, partial list, pause and the apply-now dialog are shown honestly', () => {
  const s = state({ kind: 'partial' });
  s.settings.beforeExpiry = true; s.disabled = true;
  s.cycles.push({ cycleId: 'c', creditId: 'late', current: true, status: 'scheduled', hasSchedule: true, scheduledAt: NOW + 88200,
    deadline: NOW + 90000, metadataProblem: null, trigger: 'expiry' },
  { cycleId: 'd', creditId: 'soon', current: true, status: 'waiting', hasSchedule: true, scheduledAt: NOW - 600,
    deadline: NOW + 1200, metadataProblem: null, trigger: 'manual' });
  const out = text(s, { confirm: 'soon' }).join('\n');
  assert.match(out, /late +окно с 09 окт 00:30 UTC +истекает 09 окт 01:00 UTC/);
  assert.match(out, /soon +попытки идут/);
  assert.match(out, /Список неполный/);
  assert.match(out, /Установка на паузе/);
  assert.match(out, /Применить сейчас[\s\S]*сброс soon[\s\S]*без условий правил[\s\S]*n \/ Esc — отмена/);
  assert.match(text(state(), {}, { language: 'en' }).join('\n'), /ISSUED RESETS · 2[\s\S]*GLOBAL RULES/);
});

test('keys: rules block is the last item; Enter/Space toggle one global rule; y confirms apply-now; busy ignores keys', () => {
  const s = state();
  let v = { screen: 'monitor', focus: 'list', selected: 0, cursor: 0, confirm: null };
  v = monitorKey(v, key('up'), s, NOW).view; assert.equal(v.selected, 2); // wraps to the rules block
  v = monitorKey(v, key('return'), s, NOW).view; assert.equal(v.focus, 'rules');
  let r = monitorKey(v, key('space'), s, NOW);
  assert.deepEqual(r.action, { action: 'before-expiry', enabled: true });
  r = monitorKey({ ...v, cursor: 0 }, key('down'), s, NOW);
  s.settings.weeklyAutoReset = true;
  assert.deepEqual(monitorKey(r.view, key('return'), s, NOW).action, { action: 'weekly-auto', enabled: false });
  v = monitorKey(r.view, key('escape'), s, NOW).view; assert.equal(v.focus, 'list');
  v = monitorKey({ ...v, selected: 0 }, key('return'), s, NOW).view; assert.equal(v.confirm, 'soon');
  assert.equal(monitorKey(v, key('n'), s, NOW).view.confirm, null);
  r = monitorKey(v, key('y'), s, NOW);
  assert.deepEqual(r.action, { action: 'apply-now', creditId: 'soon' }); assert.equal(r.view.confirm, null);
  assert.equal(monitorKey({ ...v, confirm: null, busy: true }, key('q'), s, NOW).exit, undefined);
  assert.equal(monitorKey({ ...v, confirm: null }, key('q'), s, NOW).exit, true);
  assert.equal(monitorKey({ ...v, confirm: null }, key('2'), s, NOW).view.screen, 'status');
});

test('inline loop: no alternate screen, apply-now goes through send, state reloads, raw mode is restored', async () => {
  const input = new PassThrough(), output = new PassThrough();
  let rawMode = false; const chunks = [];
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode: value => { rawMode = value; input.isRaw = value; } });
  Object.assign(output, { columns: 90, rows: 30 }); output.on('data', c => chunks.push(String(c)));
  const s = state(), sent = []; let loads = 0, done;
  const settled = new Promise(resolve => { done = resolve; });
  const running = runMonitor({ input, output, language: 'ru', repository: 'owner/repo', now: () => NOW,
    load: async () => { loads++; return s; }, refresh: async () => ({ state: 'idle' }),
    send: async control => { sent.push(control); s.cycles.push({ creditId: 'soon', status: 'applied', current: true }); done(); return { state: 'accepted', problem: null }; } });
  await new Promise(r => setImmediate(r));
  assert.equal(rawMode, true);
  input.write('\r'); input.write('y');
  await settled; await new Promise(r => setTimeout(r, 20));
  input.write('q'); await running;
  assert.deepEqual(sent, [{ action: 'apply-now', creditId: 'soon' }]);
  assert.equal(loads, 2); assert.equal(rawMode, false);
  const all = chunks.join('');
  assert.ok(!all.includes('\x1b[?1049h'), 'monitor stays in the ordinary terminal flow');
  assert.match(all, /\x1b\[\d+A/); // redrawn in place
  assert.match(all, /Команда сохранена/);
  assert.ok(all.endsWith('\x1b[?25h'));
});
