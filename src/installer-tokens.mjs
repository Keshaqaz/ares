import { readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { StateFailure } from './state-store.mjs';
import { tokenDue } from './installer-token.mjs';
import { pkcs8Key, runWrangler } from './installer-timer.mjs';
import { TIMER_GRACE_SECONDS } from './schedule-planner.mjs';

// Menu item `k` (ticket 43): every credential of the installation in one table and its action
// on Enter. The installation token rotates through rotate-grant (pause); the timer key is
// swapped in the Worker secret alone: same App and installation, so no pause, probe or enable.
export const tokensMessages = {
  ru: { title: 'Токены', head: ['#', 'Доступ', 'Хранится', 'Истекает', 'Состояние'],
    token: 'Токен установки', timer: 'Ключ таймера', timerToken: 'Токен таймера', session: 'Сессия ChatGPT',
    keychain: 'Keychain + Secret', secret: 'Secret', cloudflare: 'Cloudflare secret', bundle: 'Secret (bundle)', auto: 'авто',
    ok: '✓', confirmed: '✓ подтверждён', probe: 'проба', due: '! истекает через {days} дн.', noPlan: '! нет Plan: read',
    missed: '! проба не подтверждена (c)', legacy: '! перейдите на приложение (c)', none: 'не настроен (c)', noSession: 'нет входа (2)',
    reconnect: '! нужен вход (2)', revoked: '! отозвана (2)',
    pick: 'Строка (1–3) и Enter — действие; пусто — назад',
    tokenPause: 'Замена токена установки выполняется на паузе: 7 Пауза → k → 1 → 6. Сначала завершите незавершённую команду (r), если она есть.',
    timerSetup: 'Ключ таймера появится после шага c (приложение таймера).',
    keyOpen: 'Открываю страницу приложения таймера: Private keys → Generate a private key. GitHub скачает файл .pem; вернитесь сюда.',
    keyPath: 'Путь к скачанному .pem (можно перетащить файл в окно)',
    keyChecked: 'Ключ подходит к приложению {slug} и установке {installation}. Передаю его в secret TIMER_APP_KEY через Wrangler; пауза, проба и повторное включение не нужны.',
    keyReplaced: 'Ключ таймера заменён в Cloudflare. Новый ключ: {fingerprint}.',
    keyOld: 'Удалите прежний ключ на странице приложения: {url} → Private keys → Delete у всех ключей, кроме {fingerprint}.',
    keyRemoveFile: 'Удалить скачанный файл {path}? Введите YES',
    keyFileRemoved: 'Файл удалён.', keyFileLeft: 'Файл оставлен: удалите его сами — это закрытый ключ.',
    keyFileFailed: 'Файл не удалён: удалите его сами — это закрытый ключ.' },
  en: { title: 'Tokens', head: ['#', 'Access', 'Stored in', 'Expires', 'State'],
    token: 'Installation token', timer: 'Timer key', timerToken: 'Timer token', session: 'ChatGPT session',
    keychain: 'Keychain + Secret', secret: 'Secret', cloudflare: 'Cloudflare secret', bundle: 'Secret (bundle)', auto: 'auto',
    ok: '✓', confirmed: '✓ confirmed', probe: 'probe', due: '! expires in {days} d', noPlan: '! no Plan: read',
    missed: '! probe unconfirmed (c)', legacy: '! move to the app (c)', none: 'not set up (c)', noSession: 'no login (2)',
    reconnect: '! login required (2)', revoked: '! revoked (2)',
    pick: 'Row (1–3) and Enter for its action; blank to go back',
    tokenPause: 'The installation token is replaced while paused: 7 Pause → k → 1 → 6. Finish an unfinished command first (r), if any.',
    timerSetup: 'The timer key appears after step c (the timer app).',
    keyOpen: 'Opening the timer app page: Private keys → Generate a private key. GitHub downloads a .pem file; come back here.',
    keyPath: 'Path to the downloaded .pem (you can drop the file into the window)',
    keyChecked: 'The key belongs to app {slug} and installation {installation}. Passing it to the TIMER_APP_KEY secret with Wrangler; no pause, probe or re-enable is needed.',
    keyReplaced: 'The timer key is replaced in Cloudflare. New key: {fingerprint}.',
    keyOld: 'Delete the previous key on the app page: {url} → Private keys → Delete every key except {fingerprint}.',
    keyRemoveFile: 'Delete the downloaded file {path}? Type YES',
    keyFileRemoved: 'File deleted.', keyFileLeft: 'File kept: delete it yourself, it is a private key.',
    keyFileFailed: 'File not deleted: delete it yourself, it is a private key.' },
};
const day = at => new Date(at * 1000).toISOString().slice(0, 10);
const fill = (text, values) => Object.entries(values).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, v), text);
export const appKeysUrl = slug => `https://github.com/settings/apps/${slug}`; // General page: Private keys.

// Rows of the table: what each credential is, where it lives, when it expires and whether it
// needs attention (`!`). token is what the installer checked this run: expiry, Plan: read, Keychain.
export function credentialRows(s, { token = {}, now, language = 'ru' }) {
  const w = tokensMessages[language], t = s?.installation?.timer ?? null;
  const days = Number.isSafeInteger(token.expiresAt) ? Math.max(0, Math.ceil((token.expiresAt - now) / 86400)) : null;
  const tokenState = token.plan === false ? w.noPlan : tokenDue(token.expiresAt, now) ? fill(w.due, { days }) : w.ok;
  const legacy = Number.isSafeInteger(t?.expiresAt);
  const timerState = !t ? w.none : legacy ? w.legacy : t.confirmedAt ? w.confirmed :
    Number.isSafeInteger(t.probeAt) && now > t.probeAt + TIMER_GRACE_SECONDS ? w.missed : t.probeAt ? w.probe : w.none;
  const sessionState = s?.revoked ? w.revoked : s?.reconnectRequested || s?.auth?.reconnectReason ? w.reconnect : s?.auth?.committed ? w.ok : w.noSession;
  return [
    { id: 'token', problem: tokenState.startsWith('!'), cells: [w.token, token.keychain ? w.keychain : w.secret,
      Number.isSafeInteger(token.expiresAt) ? day(token.expiresAt) : '—', tokenState] },
    { id: 'timer', problem: timerState.startsWith('!'), cells: [legacy ? w.timerToken : w.timer, t ? w.cloudflare : '—',
      legacy ? day(t.expiresAt) : '—', timerState] },
    { id: 'session', problem: sessionState.startsWith('!'), cells: [w.session, w.bundle, w.auto, sessionState] },
  ];
}
export const credentialProblem = rows => rows.some(r => r.problem);
// The menu line names the item with `!` while any credential needs attention.
export const tokensMenu = (menu, problem) => problem ? menu.replace(/(k (Токены|Tokens))/, '$1 !') : menu;

// The table in TerminalUI style (boxed on a TTY, `|` lines otherwise) and the chosen row.
export async function promptTokens(ui, rows) {
  const w = tokensMessages[ui.language];
  ui.table([w.head, ...rows.map((r, i) => [String(i + 1), ...r.cells])]);
  const answer = await ui.ask(w.pick);
  return rows[Number(answer) - 1]?.id ?? null;
}

// Installation token: a paused installation without an unfinished command gets the prefilled
// form, the check and rotate-grant; the Keychain and the revoke reminder follow its receipt.
export async function rotateInstallationToken(ui, { status, pending, prompt, accept, rotate }) {
  const s = await status();
  if (pending || !s.disabled) { ui.text(tokensMessages[ui.language].tokenPause); return null; }
  const next = await prompt(); accept(next);
  return rotate(next.token, next.expiresAt);
}

// A dropped file arrives quoted or with escaped spaces; `~` is the home directory.
export function keyPath(value) {
  let path = value.trim();
  if (/^(['"]).*\1$/.test(path)) path = path.slice(1, -1);
  else path = path.replace(/\\(.)/g, '$1');
  return path.replace(/^~(?=\/|$)/, homedir());
}
// What GitHub shows next to each private key: SHA256 of the public key (SPKI DER).
export const keyFingerprint = key => `SHA256:${createHash('sha256').update(createPublicKey(createPrivateKey(
  { key: Buffer.from(key, 'base64'), format: 'der', type: 'pkcs8' })).export({ type: 'spki', format: 'der' })).digest('base64')}`;
export async function readTimerKey(path, { read = readFile } = {}) {
  let pem;
  try { pem = await read(path, 'utf8'); } catch { throw new StateFailure('timer_key_unreadable'); }
  if (pem.length > 16 * 1024) throw new StateFailure('timer_key_invalid');
  try { return pkcs8Key(pem); } catch { throw new StateFailure('timer_key_invalid'); }
}
// Only the secret changes: the deployed vars and the Worker code stay as step c left them.
export const putTimerKey = ({ key, root, spawnImpl }) => runWrangler(['secret', 'put', 'TIMER_APP_KEY'], { root, input: key, spawnImpl });

// Timer key hot swap: the new key must open the same App and installation that state names
// before it reaches Cloudflare. No admin command is sent; the Worker signs with the new key on
// its next token. The old key stays valid until the user deletes it in GitHub.
export async function replaceTimerKey(ui, { timer, open, locate, verify, put, read = readTimerKey, remove = unlink }) {
  const w = tokensMessages[ui.language];
  if (!timer?.appSlug) { ui.text(w.timerSetup); return null; }
  const url = appKeysUrl(timer.appSlug);
  ui.text(w.keyOpen); open(url); ui.text(url);
  const path = keyPath(await ui.ask(w.keyPath));
  if (!path) return null;
  const key = await read(path);
  const found = await locate({ appId: timer.appId, key });
  if (found.installationId !== timer.installationId) throw new StateFailure('timer_installation_mismatch');
  await verify({ appId: timer.appId, installationId: timer.installationId, key });
  ui.text(fill(w.keyChecked, { slug: timer.appSlug, installation: timer.installationId }));
  await put(key);
  const fingerprint = keyFingerprint(key);
  ui.text(fill(w.keyReplaced, { fingerprint })); ui.text(fill(w.keyOld, { url, fingerprint }));
  if (await ui.ask(fill(w.keyRemoveFile, { path })) === 'YES') {
    await remove(path).then(() => ui.text(w.keyFileRemoved), () => ui.text(w.keyFileFailed));
  } else ui.text(w.keyFileLeft);
  return { fingerprint };
}
