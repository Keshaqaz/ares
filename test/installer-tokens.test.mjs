import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, createHash } from 'node:crypto';
import { TerminalUI, messages } from '../src/installer-ui.mjs';
import { Installer } from '../src/installer.mjs';
import { adminFingerprint, openAdmin } from '../src/installer-admin.mjs';
import { WRANGLER } from '../src/installer-timer.mjs';
import { TIMER_GRACE_SECONDS } from '../src/schedule-planner.mjs';
import { tokensMessages, credentialRows, credentialProblem, tokensMenu, promptTokens, rotateInstallationToken,
  replaceTimerKey, putTimerKey, readTimerKey, keyPath, keyFingerprint, appKeysUrl } from '../src/installer-tokens.mjs';
import { TIMER_APP, TIMER_APP_KEY } from '../testing/timer-fixture.mjs';

const NOW = 1_791_417_600, DAY = 86400, REPO = 'synthetic/private', NEW = 'github_pat_synthetic_new';
const TIMER = { appId: 4242, appSlug: 'auto-reset-timer-synthetic', installationId: 2424, probeAt: NOW - 3000, confirmedAt: NOW - 1760 };
const healthy = () => ({ disabled: false, revoked: false, reconnectRequested: false, auth: { committed: { sessionId: 's' }, reconnectReason: null },
  installation: { timer: { ...TIMER } } });
const TOKEN = { expiresAt: NOW + 360 * DAY, plan: true, keychain: true };
const PEM = TIMER_APP.privateKey.export({ type: 'pkcs1', format: 'pem' }); // What GitHub downloads.

// TerminalUI over streams; a TTY gets the boxed table and readline's own prompt.
function terminal(language, answers = [], { tty = false } = {}) {
  const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', b => { text += b; });
  if (tty) { input.isTTY = true; output.isTTY = true; output.columns = 100; }
  const ui = new TerminalUI({ input, output }); ui.language = language;
  // A terminal readline drops lines typed before its question: each answer follows a prompt.
  if (tty) output.on('data', b => { if (String(b).includes('> ') && answers.length) setImmediate(() => input.write(`${answers.shift()}\r`)); });
  else input.end(answers.map(x => `${x}\n`).join(''));
  return { ui, text: () => text };
}
// Fake `npx wrangler`: records argv, options and stdin; exits with the next code.
function fakeSpawn(codes = []) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter(), call = { file, args, options, input: '' }; calls.push(call);
    if (options.stdio[0] === 'pipe') {
      child.stdin = new PassThrough(); child.stdin.on('data', b => { call.input += b; });
      child.stdin.on('end', () => setImmediate(() => child.emit('close', codes.shift() ?? 0)));
    } else setImmediate(() => child.emit('close', codes.shift() ?? 0));
    return child;
  };
  return { spawnImpl, calls };
}

for (const language of ['ru', 'en']) test(`${language} tokens screen: one table, boxed on a TTY and plain without, row picked by number`, async () => {
  const w = tokensMessages[language], rows = credentialRows(healthy(), { token: TOKEN, now: NOW, language });
  assert.deepEqual(rows.map(r => r.cells), [
    [w.token, 'Keychain + Secret', new Date((NOW + 360 * DAY) * 1000).toISOString().slice(0, 10), '✓'],
    [w.timer, 'Cloudflare secret', '—', w.confirmed],
    [w.session, 'Secret (bundle)', w.auto, '✓']]);
  assert.equal(credentialProblem(rows), false);
  assert.equal(tokensMenu(messages[language].menu, false), messages[language].menu);

  const plain = terminal(language, ['2']);
  assert.equal(await promptTokens(plain.ui, rows), 'timer'); plain.ui.close();
  const lines = plain.text().split('\n');
  assert.equal(lines[0], w.head.join(' | '));
  assert.equal(lines[1], ['1', ...rows[0].cells].join(' | '));
  assert.ok(lines.includes(`${w.pick}:`));
  assert.ok(!plain.text().includes('┌'));

  const boxed = terminal(language, [''], { tty: true });
  assert.equal(await promptTokens(boxed.ui, rows), null); boxed.ui.close(); // Blank goes back.
  const box = boxed.text().split('\n');
  assert.match(box[0], /^┌─+┬/); assert.match(box[1], new RegExp(`^│ # +│ ${w.head[1]} `));
  assert.ok(box.some(l => l.startsWith('│ 3 ') && l.includes(w.session) && l.includes(w.auto)));
  assert.equal(new Set(box.filter(l => /^[┌│└]/.test(l)).map(l => [...l].length)).size, 1, 'every box line is one width');
  for (const answer of ['1', '3', '4', 'x']) {
    const t = terminal(language, [answer]);
    assert.equal(await promptTokens(t.ui, rows), { 1: 'token', 3: 'session' }[answer] ?? null); t.ui.close();
  }
});

test('tokens rows warn 14 days ahead and on every problem; the menu marks k with !', () => {
  const at = (token, s = healthy(), language = 'ru') => credentialRows(s, { token: { ...TOKEN, ...token }, now: NOW, language });
  const w = tokensMessages.ru;
  assert.equal(at({ expiresAt: NOW + 15 * DAY })[0].problem, false);
  const due = at({ expiresAt: NOW + 10 * DAY })[0];
  assert.deepEqual([due.cells[3], due.problem], ['! истекает через 10 дн.', true]);
  assert.equal(at({ expiresAt: NOW + 10 * DAY }, healthy(), 'en')[0].cells[3], '! expires in 10 d');
  assert.equal(at({ plan: false })[0].cells[3], w.noPlan);
  assert.deepEqual(at({ expiresAt: null, keychain: false })[0].cells.slice(1, 3), ['Secret', '—']);

  const timer = patch => { const s = healthy(); s.installation.timer = patch && { ...TIMER, ...patch }; return at({}, s)[1]; };
  assert.deepEqual([timer(null).cells, timer(null).problem], [[w.timer, '—', '—', w.none], false]);
  assert.equal(timer({ confirmedAt: null, probeAt: NOW - 60 }).cells[3], w.probe);
  assert.deepEqual([timer({ confirmedAt: null, probeAt: NOW - TIMER_GRACE_SECONDS - 1 }).cells[3], timer({ confirmedAt: null, probeAt: NOW - TIMER_GRACE_SECONDS - 1 }).problem], [w.missed, true]);
  const legacy = timer({ appId: undefined, appSlug: undefined, installationId: undefined, expiresAt: NOW + 90 * DAY });
  assert.deepEqual(legacy.cells, [w.timerToken, 'Cloudflare secret', new Date((NOW + 90 * DAY) * 1000).toISOString().slice(0, 10), w.legacy]);

  const session = patch => at({}, { ...healthy(), ...patch })[2].cells[3];
  assert.equal(session({ reconnectRequested: true }), w.reconnect);
  assert.equal(session({ auth: { committed: { sessionId: 's' }, reconnectReason: 'auth_failed' } }), w.reconnect);
  assert.equal(session({ revoked: true }), w.revoked);
  assert.equal(session({ auth: null }), w.noSession);
  assert.equal(credentialProblem(credentialRows(null, { token: TOKEN, now: NOW })), false); // Not installed yet.

  for (const language of ['ru', 'en']) {
    const marked = tokensMenu(messages[language].menu, true);
    assert.match(marked, language === 'ru' ? /k Токены ! / : /k Tokens ! /);
    assert.ok(!/\bt (Заменить|Replace)/.test(messages[language].menu)); // k replaces t.
  }
});

test('installation token rotation: paused only; form, check and rotate-grant; the Keychain follows the receipt', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'installer-tokens-')); t.after(() => rm(dir, { recursive: true, force: true }));
  // Refused before the form opens: running installation or an unfinished command.
  for (const [s, pending] of [[{ disabled: false }, false], [{ disabled: true }, true]]) {
    const { ui, text } = terminal('ru'); let prompted = 0;
    assert.equal(await rotateInstallationToken(ui, { status: async () => s, pending, prompt: async () => { prompted++; } }), null);
    assert.equal(prompted, 0); assert.ok(text().includes(tokensMessages.ru.tokenPause)); ui.close();
  }
  // A token without Plan: read is refused by accept: nothing is sent.
  let sent = 0;
  await assert.rejects(rotateInstallationToken(terminal('en').ui, { status: async () => ({ disabled: true }), pending: false,
    prompt: async () => ({ token: NEW, plan: false }), accept: () => { throw Object.assign(new Error('x'), { kind: 'installation_token_plan_required' }); },
    rotate: async () => { sent++; } }), /x/);
  assert.equal(sent, 0);

  // Real Installer against a fake GitHub that completes the command the job dispatched.
  const commands = [], operation = { commandId: null, phase: 'pending' }, stored = [];
  const github = token => ({ repository: REPO, token, status: async () => ({ version: 7, disabled: true, commands, installation: { operation } }),
    dispatch: async c => { commands.push({ commandId: c.commandId, fingerprint: adminFingerprint(c) }); Object.assign(operation, { commandId: c.commandId, phase: 'done' }); return { state: 'unconfirmed' }; } });
  const installer = new Installer({ platform: 'darwin', journalPath: join(dir, 'journal.json'), github: github('github_pat_synthetic_old'),
    keychain: { write: async value => { stored.push(value); } }, connect: github });
  const { ui } = terminal('ru'), expiresAt = NOW + 366 * DAY;
  const result = await rotateInstallationToken(ui, { status: () => installer.github.status(), pending: false,
    prompt: async () => ({ token: NEW, plan: true, expiresAt }), accept: () => {}, rotate: (value, at) => installer.rotateGrant(value, at) });
  assert.equal(result.state, 'unconfirmed');
  assert.deepEqual(openAdmin(REPO, 'github_pat_synthetic_old', installer.journal.pending), { newGrant: NEW, grantExpiresAt: expiresAt });
  const receipt = await installer.resume();
  assert.deepEqual([receipt.state, receipt.keychain, stored, installer.github.token, installer.grantExpiresAt], ['accepted', 'keychainUpdated', [NEW], NEW, expiresAt]);
  for (const language of ['ru', 'en']) assert.match(messages[language].keychainUpdated, /Отзовите прежний|Revoke the previous/);
  ui.close();
});

test('timer key file: dropped paths are unquoted, PKCS#1 becomes PKCS#8, the fingerprint is GitHub\'s', async t => {
  assert.equal(keyPath(" '/Users/me/Downloads/app key.pem' "), '/Users/me/Downloads/app key.pem');
  assert.equal(keyPath('/Users/me/Downloads/app\\ key.pem'), '/Users/me/Downloads/app key.pem');
  assert.equal(keyPath('~/Downloads/k.pem'), join(homedir(), 'Downloads/k.pem'));
  const dir = await mkdtemp(join(tmpdir(), 'installer-tokens-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'k.pem'), PEM); await writeFile(join(dir, 'bad.pem'), 'not a key');
  assert.equal(await readTimerKey(join(dir, 'k.pem')), TIMER_APP_KEY);
  await assert.rejects(readTimerKey(join(dir, 'bad.pem')), /timer_key_invalid/);
  await assert.rejects(readTimerKey(join(dir, 'none.pem')), /timer_key_unreadable/);
  // openssl rsa -pubout -outform DER | openssl sha256 -binary | base64, as GitHub documents.
  const spki = createPublicKey(TIMER_APP.privateKey).export({ type: 'spki', format: 'der' });
  assert.equal(keyFingerprint(TIMER_APP_KEY), `SHA256:${createHash('sha256').update(spki).digest('base64')}`);
});

// The swap with fakes for GitHub and Wrangler; nothing but the secret changes.
async function swap(language, answers, { timer = TIMER, locate = { installationId: 2424, selection: 'selected' }, codes = [], verify = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'installer-tokens-')), file = join(dir, 'auto-reset-timer.2026-10-17.private-key.pem');
  await writeFile(file, PEM);
  const { ui, text } = terminal(language, answers.map(a => a.replace('{file}', file)));
  const calls = [], w = fakeSpawn(codes);
  try {
    const result = await replaceTimerKey(ui, { timer, open: url => calls.push(['open', url]),
      locate: async app => { calls.push(['locate', app.appId, app.key === TIMER_APP_KEY]); return locate; },
      verify: async app => { calls.push(['verify', app.appId, app.installationId, app.key === TIMER_APP_KEY]); if (verify) throw verify; },
      put: key => putTimerKey({ key, root: '/program', spawnImpl: w.spawnImpl }) });
    return { result, text: text(), calls, wrangler: w.calls, file, kept: await access(file).then(() => true, () => false) };
  } catch (error) { return { error, text: text(), calls, wrangler: w.calls }; }
  finally { ui.close(); await rm(dir, { recursive: true, force: true }); }
}

for (const language of ['ru', 'en']) test(`${language} timer key hot swap: checked against the same App, only secret put, no pause or probe`, async () => {
  const w = tokensMessages[language], fingerprint = keyFingerprint(TIMER_APP_KEY);
  const { result, text, calls, wrangler, kept } = await swap(language, ['{file}', 'YES']);
  assert.deepEqual(result, { fingerprint });
  assert.deepEqual(calls, [['open', appKeysUrl(TIMER.appSlug)], ['locate', 4242, true], ['verify', 4242, 2424, true]]);
  assert.deepEqual(wrangler.map(c => [c.file, ...c.args]), [['npx', '--yes', WRANGLER, 'secret', 'put', 'TIMER_APP_KEY', '--config', 'worker/wrangler.toml']]);
  assert.equal(wrangler[0].input, TIMER_APP_KEY); assert.equal(wrangler[0].options.cwd, '/program');
  assert.ok(!JSON.stringify([wrangler[0].args, wrangler[0].options]).includes(TIMER_APP_KEY.slice(0, 40)));
  assert.ok(!text.includes(TIMER_APP_KEY.slice(0, 40)) && !text.includes('PRIVATE KEY'));
  assert.equal(kept, false);
  for (const fragment of [appKeysUrl(TIMER.appSlug), 'Generate a private key', fingerprint, w.keyFileRemoved,
    w.keyOld.replace('{url}', appKeysUrl(TIMER.appSlug)).replace(/\{fingerprint\}/g, fingerprint)]) assert.ok(text.includes(fragment), fragment);
  assert.ok(!/7 Пауза|7 Pause|deploy/.test(text.replace(w.keyChecked.replace('{slug}', TIMER.appSlug).replace('{installation}', 2424), '')));
});

test('timer key swap fails closed before Cloudflare: other installation, bad file, denied access; Wrangler failure is reported', async () => {
  const other = await swap('en', ['{file}'], { locate: { installationId: 9999, selection: 'selected' } });
  assert.equal(other.error.kind, 'timer_installation_mismatch'); assert.equal(other.wrangler.length, 0);
  assert.equal(other.calls.some(c => c[0] === 'verify'), false);
  const denied = await swap('en', ['{file}'], { verify: Object.assign(new Error('d'), { kind: 'timer_app_permissions_denied' }) });
  assert.equal(denied.error.kind, 'timer_app_permissions_denied'); assert.equal(denied.wrangler.length, 0);
  const missing = await swap('ru', ['/nonexistent/key.pem']);
  assert.equal(missing.error.kind, 'timer_key_unreadable'); assert.deepEqual(missing.calls.map(c => c[0]), ['open']);
  const failed = await swap('ru', ['{file}'], { codes: [1] });
  assert.equal(failed.error.kind, 'timer_wrangler_failed'); assert.ok(!failed.text.includes(tokensMessages.ru.keyOld.slice(0, 20)));
  const kept = await swap('ru', ['{file}', 'NO']);
  assert.equal(kept.kept, true); assert.ok(kept.text.includes(tokensMessages.ru.keyFileLeft));
  const blank = await swap('en', ['']);
  assert.equal(blank.result, null); assert.equal(blank.calls.length, 1);
  // No app yet, or still on the timer token: nothing opens, the user is pointed to c.
  for (const timer of [null, { probeAt: null, confirmedAt: null, expiresAt: NOW + DAY }]) {
    const none = await swap('ru', [], { timer });
    assert.equal(none.result, null); assert.deepEqual(none.calls, []); assert.ok(none.text.includes(tokensMessages.ru.timerSetup));
  }
});

test('installer CLI: k replaces t, opens the tokens table and swaps the key without admin command', async () => {
  const source = await readFile(new URL('../src/install-cli.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes("action === 't'"));
  assert.match(source, /action === 'k'/);
  assert.match(source, /tokensMenu\(w\.menu, credentialProblem/);
  const k = source.slice(source.indexOf("action === 'k'"), source.indexOf("action === '7'"));
  assert.ok(!/installer\.(send|timer|enable)\(/.test(k.slice(k.indexOf("'timer'"), k.indexOf("'session'"))), 'the key swap sends no command');
  for (const language of ['ru', 'en']) {
    for (const key of Object.keys(tokensMessages.ru)) assert.ok(key in tokensMessages[language], key);
    assert.ok(!/\(t\)/.test(Object.values(messages[language]).join(' ')));
  }
});
