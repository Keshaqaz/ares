import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { TerminalUI, messages } from '../src/installer-ui.mjs';
import { StateFailure } from '../src/state-store.mjs';
import { TIMER_GRACE_SECONDS } from '../src/schedule-planner.mjs';
import { wizardMessages, wizardStep, wizardDue, runWizard, WIZARD_STEPS } from '../src/installer-wizard.mjs';

const NOW = 1_791_417_600;
// A paused installation after each wizard step; the fake parts below move it forward.
const fresh = () => ({ disabled: true, revoked: false, reconnectRequested: false, auth: null,
  installation: { seedSession: null, checkedSession: null, quota: null, timer: null } });
const ready = () => {
  const s = fresh();
  s.auth = { phase: 'ready', committed: { sessionId: 's1' }, reconnectReason: null };
  Object.assign(s.installation, { seedSession: 's1', checkedSession: 's1', quota: { policy: {}, verified: true },
    timer: { appId: 1, appSlug: 'timer', installationId: 2, probeAt: NOW - 3000, confirmedAt: NOW - 2000 } });
  return s;
};
const with_ = (change, s = ready()) => { change(s); return s; };

// TerminalUI over streams; a TTY gets readline's own prompt, each answer follows a prompt.
function terminal(language, answers = [], { tty = false } = {}) {
  const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', b => { text += b; });
  if (tty) { input.isTTY = true; output.isTTY = true; output.columns = 100; }
  const ui = new TerminalUI({ input, output }); ui.language = language;
  if (tty) output.on('data', b => { if (String(b).includes('> ') && answers.length) setImmediate(() => input.write(`${answers.shift()}\r`)); });
  else input.end(answers.map(x => `${x}\n`).join(''));
  return { ui, text: () => text };
}
// Fake parts that do what the menu handlers would do to the state.
function fakeParts(s, calls, overrides = {}) {
  const step = (name, change) => async () => { calls.push(name); change(); };
  return { bootstrap: step('bootstrap', () => { s.value = fresh(); }),
    seed: step('seed', () => { s.value.auth = { phase: 'ready', committed: { sessionId: 's2' }, reconnectReason: null }; s.value.installation.seedSession = 's2'; }),
    recover: step('recover', () => { s.value.revoked = false; s.value.reconnectRequested = false; }),
    check: step('check', () => { s.value.installation.checkedSession = s.value.auth.committed.sessionId; }),
    configure: step('configure', () => { s.value.installation.quota = { policy: {}, verified: false }; }),
    verify: step('verify', () => { s.value.installation.quota.verified = true; }),
    setup: step('setup', () => { s.value.installation.timer = { appId: 1, appSlug: 'timer', installationId: 2, probeAt: NOW + 600, confirmedAt: null }; }),
    probe: step('probe', () => { s.value.installation.timer.confirmedAt = NOW + 700; }), ...overrides };
}
const wizard = (ui, s, parts) => runWizard(ui, { status: async () => structuredClone(s.value), parts, now: () => NOW });

test('wizard step comes from the state alone', () => {
  const step = s => wizardStep(s, { now: NOW });
  assert.deepEqual(step(null), { step: 'install', part: 'bootstrap' });
  assert.deepEqual(step({ disabled: true }), { step: 'install', part: 'bootstrap' });
  assert.deepEqual(step(fresh()), { step: 'login', part: 'seed' });
  // A session not ready yet, or one the seed did not name, still needs a login.
  assert.deepEqual(step(with_(s => { s.auth.phase = 'pending'; })), { step: 'login', part: 'seed' });
  assert.deepEqual(step(with_(s => { s.installation.seedSession = 'old'; })), { step: 'login', part: 'seed' });
  // Revoke and reconnect forget seedSession: a new login, then recover.
  assert.deepEqual(step(with_(s => { s.revoked = true; s.installation.seedSession = null; })), { step: 'login', part: 'seed' });
  assert.deepEqual(step(with_(s => { s.revoked = true; })), { step: 'login', part: 'recover' });
  assert.deepEqual(step(with_(s => { s.reconnectRequested = true; })), { step: 'login', part: 'recover' });
  assert.deepEqual(step(with_(s => { s.installation.checkedSession = null; })), { step: 'login', part: 'check' });
  assert.deepEqual(step(with_(s => { s.installation.quota = null; })), { step: 'quota', part: 'configure' });
  assert.deepEqual(step(with_(s => { s.installation.quota.verified = false; })), { step: 'quota', part: 'verify' });
  assert.deepEqual(step(with_(s => { s.installation.timer = null; })), { step: 'timer', part: 'setup' });
  const probe = with_(s => { s.installation.timer.confirmedAt = null; s.installation.timer.probeAt = NOW - TIMER_GRACE_SECONDS; });
  assert.deepEqual(step(probe), { step: 'timer', part: 'probe' });
  probe.installation.timer.probeAt = NOW - TIMER_GRACE_SECONDS - 1; // Missed: c again.
  assert.deepEqual(step(probe), { step: 'timer', part: 'setup' });
  // A timer still on the timer token moves to the app, even when confirmed.
  assert.deepEqual(step(with_(s => { s.installation.timer = { probeAt: null, confirmedAt: NOW - 10, expiresAt: NOW + 86400 }; })), { step: 'timer', part: 'setup' });
  assert.equal(step(ready()), null);
  // Auto-start: nothing installed, or paused with a step left; never an enabled or finished one.
  assert.equal(wizardDue(null, NOW), true);
  assert.equal(wizardDue(fresh(), NOW), true);
  assert.equal(wizardDue(ready(), NOW), false);
  assert.equal(wizardDue(with_(s => { s.disabled = false; s.reconnectRequested = true; }), NOW), false);
});

for (const tty of [false, true]) for (const language of ['ru', 'en']) test(`${language} wizard${tty ? ' on a TTY' : ''}: every step in order, then the summary without enable`, async () => {
  const w = wizardMessages[language], s = { value: null }, calls = [];
  const t = terminal(language, Array(8).fill(''), { tty });
  assert.equal(await wizard(t.ui, s, fakeParts(s, calls)), 'done'); t.ui.close();
  assert.deepEqual(calls, ['bootstrap', 'seed', 'check', 'configure', 'verify', 'setup', 'probe']);
  const text = t.text();
  // One overview with the current step, then a stage per part, its explanation and the prompt.
  assert.equal(text.split(w.title).length - 1, 1);
  for (const step of WIZARD_STEPS) assert.ok(text.includes(w.steps[step]), step);
  for (const part of calls) assert.ok(text.includes(w.parts[part]), part);
  assert.ok(text.includes(`[3/6] ${w.steps.install}`) && text.includes(`[6/6] ${w.steps.timer}`));
  assert.ok(text.includes(w.go) && text.endsWith(`${w.done}\n`));
  if (tty) assert.ok(text.includes('┌') && text.includes('\x1b[1;36m[3/6]'));
  else assert.ok(text.includes('1 | Repo | ✓') && text.includes(`3 | ${w.steps.install} | →`));
  assert.equal(s.value.disabled, true); // Enable stays the user's decision.
  for (const key of Object.keys(wizardMessages.ru)) assert.ok(key in w, key);
  for (const part of Object.keys(wizardMessages.ru.parts)) assert.ok(part in w.parts, part);
  assert.match(messages[language].menu, /i (Мастер настройки|Setup wizard)/);
});

test('wizard resumes from the first unfinished step; 0, a refusal and a failure go back to the menu', async () => {
  // Interrupted after the login: the next run starts at the quota.
  let s = { value: with_(v => { v.installation.quota = null; v.installation.timer = null; }) }, calls = [];
  let t = terminal('ru', ['0']);
  assert.equal(await wizard(t.ui, s, fakeParts(s, calls)), 'menu'); t.ui.close();
  assert.deepEqual(calls, []);
  assert.ok(t.text().includes('1 | Repo | ✓') && t.text().includes(`5 | ${wizardMessages.ru.steps.quota} | →`));
  assert.ok(t.text().includes(wizardMessages.ru.parts.configure));

  // Declined inside the step (e.g. the budget not confirmed): back to the menu, nothing moved.
  t = terminal('ru', ['']);
  assert.equal(await wizard(t.ui, s, fakeParts(s, calls, { configure: async () => { calls.push('configure'); return false; } })), 'menu'); t.ui.close();
  assert.deepEqual(calls, ['configure']);

  // A failed step shows its reason; the next run repeats it and goes on.
  calls = []; t = terminal('en', ['', '']);
  const failing = fakeParts(s, calls, { verify: async () => { calls.push('verify'); throw new StateFailure('quota_check_failed'); } });
  assert.equal(await wizard(t.ui, s, failing), 'failed'); t.ui.close();
  assert.deepEqual(calls, ['configure', 'verify']);
  assert.ok(t.text().includes(`${wizardMessages.en.stopped}: quota_check_failed`));
  calls = []; t = terminal('en', ['', '', '']);
  assert.equal(await wizard(t.ui, s, fakeParts(s, calls)), 'done'); t.ui.close();
  assert.deepEqual(calls, ['verify', 'setup', 'probe']);

  // A probe wait still inside its grace is resumed by the next run.
  s = { value: with_(v => { v.installation.timer.confirmedAt = null; v.installation.timer.probeAt = NOW - 60; }) }; calls = [];
  t = terminal('ru', ['']);
  assert.equal(await wizard(t.ui, s, fakeParts(s, calls)), 'done'); t.ui.close();
  assert.deepEqual(calls, ['probe']);
});

test('wizard stops on a step that made no progress and on an enabled installation', async () => {
  // A command accepted with a problem leaves the state as it was: one try, then back to the menu.
  const s = { value: with_(v => { v.installation.checkedSession = null; }) }, calls = [];
  let t = terminal('ru', ['', '']);
  assert.equal(await wizard(t.ui, s, fakeParts(s, calls, { check: async () => { calls.push('check'); } })), 'stalled'); t.ui.close();
  assert.deepEqual(calls, ['check']);
  assert.ok(t.text().includes(wizardMessages.ru.stalled));

  // Enabled with a step left (reconnect requested in a run): the wizard points to pause first.
  s.value = with_(v => { v.disabled = false; v.reconnectRequested = true; });
  t = terminal('en', []);
  assert.equal(await wizard(t.ui, s, fakeParts(s, calls)), 'enabled'); t.ui.close();
  assert.deepEqual(calls, ['check']);
  assert.ok(t.text().includes(wizardMessages.en.active.replace('{step}', wizardMessages.en.steps.login)));
  // Enabled and complete: only the summary.
  s.value = with_(v => { v.disabled = false; });
  t = terminal('en', []);
  assert.equal(await wizard(t.ui, s, fakeParts(s, calls)), 'done'); t.ui.close();
});

test('installer CLI: the wizard starts by itself, on i, with the menu handlers and without enable', async () => {
  const source = await readFile(new URL('../src/install-cli.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('const wizard = '), loop = source.indexOf('while (true) {\n    const live');
  assert.ok(start > 0 && loop > start);
  const setup = source.slice(start, loop);
  assert.match(setup, /wizardDue\(first/);
  assert.match(setup, /installer\.journal\.pending\) \{\n\s+try \{ await awaitReceipt\(await installer\.resume\(\)\)/);
  assert.match(source, /action === 'i'\) \{ await wizard\(\)/);
  for (const part of Object.keys(wizardMessages.ru.parts)) assert.match(setup, new RegExp(`\\b${part}: `), part);
  assert.ok(!/enable|weekly-auto|'select'/.test(setup), 'the wizard never enables or sets rules');
  // The menu items run the same handlers the wizard does.
  for (const [action, handler] of [['1', 'install'], ['2', 'login'], ['q', 'quotaSetup'], ['b', 'quotaCheck'], ['c', 'timerSetup']]) {
    assert.match(source, new RegExp(`action === '${action}'\\) \\{ ui\\.stage\\('[0-9]/6', w\\.[a-zA-Z]+\\); await ${handler}\\(\\)|action === '${action}'\\) \\{ await ${handler}\\(\\)`), action);
  }
});
