import { createInterface } from 'node:readline/promises';
import { StateFailure } from '../core/state-store.mjs';
import { appInstallUrl, appSettingsUrl } from './installer-timer.mjs';
import { Writable } from 'node:stream';
import { tokenFormUrl, shortToken } from './installer-token.mjs';

const iso = at => new Date(at * 1000).toISOString();

export const messages = {
  ru: { title: 'Автоматическое применение выданных сбросов', repository: 'Отдельный private repo (owner/repo)',
    pat: 'В открывшейся форме выберите repo и нажмите Generate',
    patToken: 'Токен установки (пусто — открыть форму выпуска; ввод скрыт)',
    tokenPlan: 'У токена установки нет Plan: read — квота не читается. Выпустите новый по ссылке и замените его (k → 1), затем b.',
    tokenShort: 'Токен установки действует до {date} — меньше года. Можно продолжать; для годового срока перевыпустите его по ссылке с Expiration 366 days и замените (k → 1).',
    tokenBroad: 'Токен установки видит ещё {count} private repo. Продолжаю; безопаснее перевыпустить его с Only select repositories → только этот repo.',
    tokenRejected: 'GitHub отклонил токен установки (истёк, отозван или лишился прав). Выпустите новый; если прежний уже не действует — docs/support.md, «Токен установки истёк».',
    keychainSaved: 'Токен установки сохранён в Keychain (auto-reset, {repository}); повторный запуск его не спросит.',
    keychainUnavailable: 'Keychain недоступен: токен установки вводится вручную и не сохраняется.',
    keychainStale: 'GitHub отклонил токен установки из Keychain (истёк или отозван). Введите новый — он заменит сохранённый.',
    keychainUpdated: 'Новый токен установки сохранён в Keychain и используется дальше. Отзовите прежний в GitHub.',
    keychainNotUpdated: 'Замена подтверждена, но Keychain не обновлён: при следующем запуске введите новый токен установки. Затем отзовите прежний в GitHub.',
    keychainRemoved: 'Запись Keychain (auto-reset, {repository}) удалена.',
    keychainNotRemoved: 'Запись Keychain не удалена. Вручную: security delete-generic-password -s auto-reset -a {repository}',
    upgraded: 'Billing теперь читается токеном установки: первая команда новой версии удалит Secret AUTO_RESET_BILLING_TOKEN и сбросит проверку квоты. Выполните b (токену нужен Plan: read, иначе сначала t) и отзовите прежний billing-токен в GitHub.',
    menu: 'm Монитор: сбросы, общие правила, применить сейчас  i Мастер настройки\n1 Установка  2 Вход/reconnect  3 Подтвердить новый вход  4 Проверить подключение\n5 Выбрать сброс  c Внешний таймер  6 Включить/возобновить  7 Пауза  8 Обновить  9 Удалить  k Токены  w Недельное автоприменение  q Настроить квоту  b Проверить квоту  r Resume  s Состояние  0 Выход',
    weekly: 'Применять сброс только при исчерпании недельной квоты до её обновления: YES — включить, NO — выключить. Расписание включается отдельно',
    pending: 'Доставка не подтверждена; проверяю durable журнал', accepted: 'Команда сохранена; проверьте результат в Actions / Summary',
    binary: 'Абсолютный путь к официальному Codex 0.160.1', credit: 'ID сброса (пусто — ближайший при полном списке)',
    delta: 'Интервал до истечения, минуты (по умолчанию 60)', start: 'Для неизвестного/бессрочного срока: начало UTC Unix seconds',
    billingPlan: 'План владельца GitHub: free / pro',
    billingBudget: 'В GitHub Settings → Billing подтвердите account-wide Actions budget $0 и Stop usage: Yes. После изменения бюджета/плана повторите настройку. API не проверяет бюджет; локальный лимит не гарантирует billing ceiling. Введите YES',
    billingSetup: 'Настройка выполняется при паузе. Сохраняется политика бюджета; billing читается токеном установки (Plan: read). Затем b проверяет её в новой Actions job. Планируйте расход setup jobs в общей квоте.',
    billingReady: 'Источник квоты проверен в новой job; расписание остаётся выключенным.',
    evidence: 'Клиентский путь, persistence и правила расходов проверены? Введите YES',
    remove: 'Удаление: disable → исход отправленного RPC → план таймера → Secrets → отключение workflow. История сохраняется. Введите DELETE',
    revoke: 'Отзовите в GitHub токен установки и прежние billing-токен и токен таймера, если они были, и отдельную CI-сессию ChatGPT. Удаление repo и административные настройки выполняйте вручную.',
    stopped: 'Операция остановлена', waiting: 'Результат ещё не подтверждён. Resume использует тот же ID. Actions:',
    policy: 'Расписание: discovery каждые 4 часа; попытки раз в 5 минут по внешнему таймеру Cloudflare, возможны задержки/пропуски; резервный запуск GitHub раз в сутки. Лимит 1000 минут, резерв 100; горизонт 365 дней.',
    partial: 'Неполные/пустые metadata: автоматический выбор недоступен. Видимый eligible ID можно выбрать явно.',
    risk: 'Интервал менее 5 минут может не иметь слота. Нет гарантии применения до expiry. Введите YES для принятия риска.',
    timerTitle: 'Внешний таймер',
    timerWhy: 'GitHub не обещает доставку расписания (schedule), поэтому окна попыток будит бесплатный Cloudflare Worker: раз в 5 минут он читает план окон и только в его минуты отправляет пустой workflow_dispatch. Worker не хранит сессию ChatGPT, не решает о применении сброса и не передаёт команд. Cloudflare — сторонний сервис: он хранит ключ приложения таймера как Worker secret.',
    timerSteps: ['1. Создайте бесплатный аккаунт Cloudflare (dash.cloudflare.com, план Workers Free).',
      '2. Установщик откроет GitHub: нажмите Create GitHub App — это приложение таймера в вашем аккаунте с правами Actions: write и Contents: read, без webhook. Затем на странице установки выберите Only select repositories → этот repo и нажмите Install. Копировать токены не нужно.',
      '3. Установка должна быть на паузе. Установщик найдёт установку приложения, проверит доступ, развернёт Worker через Wrangler 4.139.0 (вход в Cloudflare в браузере) и передаст ключ приложения в secret TIMER_APP_KEY. На диск и в журнал ключ не попадает.'],
    timerReady: 'Аккаунт Cloudflare готов? Введите YES',
    timerCreate: 'Открываю страницу создания приложения таймера (если браузер не открылся — откройте адрес ниже). Нажмите Create GitHub App и вернитесь сюда.',
    timerInstall: 'На странице установки выберите Only select repositories → {repository} и нажмите Install.',
    timerInstalled: 'Приложение установлено? Введите YES',
    timerNotInstalled: 'GitHub пока не видит установку приложения на этот repo. Установите его по ссылке выше.',
    timerBroad: 'Приложение таймера установлено на все repo. Продолжаю: Worker сужает каждый токен до этого repo, но утечка ключа открыла бы все repo. Безопаснее: GitHub → Settings → Applications → Configure → Only select repositories.',
    timerRetry: 'Wrangler завершился с ошибкой. Повторить (ключ ещё в памяти)? Введите YES',
    timerAppLeft: 'Шаг таймера не завершён, приложение таймера осталось в GitHub. Повтор c создаст новое; это удалите: {url} → Delete GitHub App.',
    timerProbe: 'Пробный слот (UTC) — Worker отправит пустой dispatch, запуск появится в Actions. Ожидание 15–25 минут; выход безопасен, результат — в s',
    timerConfirmed: 'Внешний таймер подтверждён: пустой dispatch от Worker выполнен в Actions. Включение доступно.',
    timerMissed: 'Пробный dispatch не подтверждён. Проверьте лог Worker (npx wrangler@4.139.0 tail --config src/worker/wrangler.toml), secret TIMER_APP_KEY и установку приложения таймера, затем повторите c.',
    timerLegacy: 'Внешний таймер работает на прежнем токене таймера (истекает {date}). Перейдите на приложение таймера: 7 Пауза → c → 6; затем отзовите токен таймера в GitHub.',
    timerTokenRemoved: 'Secret TIMER_TOKEN удалён из Worker. После подтверждения пробы отзовите прежний токен таймера в GitHub.',
    timerTokenLeft: 'Secret TIMER_TOKEN не удалён (Worker его больше не читает). Вручную: npx --yes wrangler@4.139.0 secret delete TIMER_TOKEN --config src/worker/wrangler.toml; затем отзовите токен таймера в GitHub.',
    timerAppDelete: 'Удалите приложение таймера в GitHub: {url} → Delete GitHub App.',
    timerDelete: 'Удалить Worker таймера через Wrangler сейчас? Введите YES' },
  en: { title: 'Automatic issued reset activation', repository: 'Dedicated private repo (owner/repo)',
    pat: 'In the form that opens, select the repo and click Generate',
    patToken: 'Installation token (blank opens the issue form; hidden input)',
    tokenPlan: 'The installation token lacks Plan: read, so quota cannot be read. Issue a new one from the link and replace it (k → 1), then b.',
    tokenShort: 'The installation token is valid until {date}, less than a year. You can continue; for a one-year token reissue it from the link with Expiration 366 days and replace it (k → 1).',
    tokenBroad: 'The installation token reaches {count} more private repos. Continuing; it is safer to reissue it with Only select repositories → this repo only.',
    tokenRejected: 'GitHub rejected the installation token (expired, revoked or lost permissions). Issue a new one; if the previous one no longer works, see docs/support.md, "Installation token expired".',
    keychainSaved: 'The installation token is saved in the Keychain (auto-reset, {repository}); the next run will not ask for it.',
    keychainUnavailable: 'The Keychain is unavailable: the installation token is entered by hand and not saved.',
    keychainStale: 'GitHub rejected the installation token from the Keychain (expired or revoked). Enter a new one; it replaces the saved one.',
    keychainUpdated: 'The new installation token is saved in the Keychain and used from now on. Revoke the previous one in GitHub.',
    keychainNotUpdated: 'The replacement is confirmed, but the Keychain was not updated: enter the new installation token on the next run. Then revoke the previous one in GitHub.',
    keychainRemoved: 'The Keychain entry (auto-reset, {repository}) is removed.',
    keychainNotRemoved: 'The Keychain entry was not removed. By hand: security delete-generic-password -s auto-reset -a {repository}',
    upgraded: 'Billing is now read with the installation token: the first command of the new version removes the AUTO_RESET_BILLING_TOKEN Secret and resets the quota check. Run b (the token needs Plan: read, otherwise t first) and revoke the old billing token in GitHub.',
    menu: 'm Monitor: resets, global rules, apply now  i Setup wizard\n1 Install  2 Login/reconnect  3 Confirm new login  4 Check connection\n5 Select reset  c External timer  6 Enable/resume  7 Pause  8 Upgrade  9 Uninstall  k Tokens  w Weekly auto reset  q Set up quota  b Check quota  r Resume  s Status  0 Exit',
    weekly: 'Apply a reset only when the weekly quota is exhausted before renewal: YES to enable, NO to disable. Enable the schedule separately',
    pending: 'Delivery unconfirmed; checking durable journal', accepted: 'Command saved; check its result in Actions / Summary',
    binary: 'Absolute path to official Codex 0.160.1', credit: 'Reset ID (blank = earliest with complete list)',
    delta: 'Interval before expiry, minutes (default 60)', start: 'Unknown/no expiry: chosen start in UTC Unix seconds',
    billingPlan: 'GitHub owner plan: free / pro',
    billingBudget: 'In GitHub Settings → Billing confirm an account-wide Actions budget of $0 and Stop usage: Yes. Repeat setup after a budget/plan change. The API does not check the budget; the local limit does not guarantee a billing ceiling. Type YES',
    billingSetup: 'Pause before setup. The budget policy is saved; billing is read with the installation token (Plan: read). b then checks it in a new Actions job. Include setup jobs in your total quota budget.',
    billingReady: 'Quota source checked in a new job; the schedule remains disabled.',
    evidence: 'Client path, persistence and cost policy verified? Type YES',
    remove: 'Uninstall: disable → sent RPC outcome → timer plan → Secrets → workflow disabled. History is retained. Type DELETE',
    revoke: 'Revoke in GitHub the installation token, the old billing and timer tokens if there were any, and the separate ChatGPT CI session. Delete the repo and change administrative settings yourself.',
    stopped: 'Operation stopped', waiting: 'Result remains unconfirmed. Resume keeps the same ID. Actions:',
    policy: 'Schedule: discovery every 4 hours; attempts every 5 minutes via the Cloudflare external timer, delays/skips possible; daily GitHub fallback run. Limit 1000 minutes, reserve 100; horizon 365 days.',
    partial: 'Incomplete/empty metadata: auto-selection unavailable. An eligible visible ID can be selected explicitly.',
    risk: 'An interval below 5 minutes may have no slot. Activation before expiry is not guaranteed. Type YES to accept the risk.',
    timerTitle: 'External timer',
    timerWhy: 'GitHub does not promise schedule delivery, so a free Cloudflare Worker wakes the attempt windows: every 5 minutes it reads the window plan and sends an empty workflow_dispatch only in its minutes. The Worker holds no ChatGPT session, never decides to apply a reset and sends no commands. Cloudflare is a third-party service: it stores the timer app key as a Worker secret.',
    timerSteps: ['1. Create a free Cloudflare account (dash.cloudflare.com, Workers Free plan).',
      '2. The installer opens GitHub: click Create GitHub App — the timer app in your account with Actions: write and Contents: read, no webhook. Then on the install page choose Only select repositories → this repo and click Install. No token to copy.',
      '3. The installation must be paused. The installer finds the app installation, checks access, deploys the Worker with Wrangler 4.139.0 (Cloudflare login in the browser) and passes the app key to the TIMER_APP_KEY secret. The key never reaches disk or the journal.'],
    timerReady: 'Cloudflare account ready? Type YES',
    timerCreate: 'Opening the page that creates the timer app (if the browser did not open, open the address below). Click Create GitHub App and come back here.',
    timerInstall: 'On the install page choose Only select repositories → {repository} and click Install.',
    timerInstalled: 'App installed? Type YES',
    timerNotInstalled: 'GitHub does not see the app installed on this repo yet. Install it from the link above.',
    timerBroad: 'The timer app is installed on all repos. Continuing: the Worker narrows every token to this repo, but a leaked key would reach all repos. Safer: GitHub → Settings → Applications → Configure → Only select repositories.',
    timerRetry: 'Wrangler failed. Retry (the key is still in memory)? Type YES',
    timerAppLeft: 'The timer step did not finish and the timer app remains in GitHub. Repeating c creates a new one; delete this one: {url} → Delete GitHub App.',
    timerProbe: 'Probe slot (UTC) — the Worker sends an empty dispatch and a run appears in Actions. Wait 15–25 minutes; exiting is safe, see s for the result',
    timerConfirmed: 'External timer confirmed: the empty dispatch from the Worker ran in Actions. Enable is available.',
    timerMissed: 'Probe dispatch unconfirmed. Check the Worker log (npx wrangler@4.139.0 tail --config src/worker/wrangler.toml), the TIMER_APP_KEY secret and the timer app installation, then repeat c.',
    timerLegacy: 'The external timer still runs on the old timer token (expires {date}). Move to the timer app: 7 Pause → c → 6; then revoke the timer token in GitHub.',
    timerTokenRemoved: 'The TIMER_TOKEN secret is removed from the Worker. Once the probe is confirmed, revoke the old timer token in GitHub.',
    timerTokenLeft: 'The TIMER_TOKEN secret was not removed (the Worker no longer reads it). By hand: npx --yes wrangler@4.139.0 secret delete TIMER_TOKEN --config src/worker/wrangler.toml; then revoke the timer token in GitHub.',
    timerAppDelete: 'Delete the timer app in GitHub: {url} → Delete GitHub App.',
    timerDelete: 'Delete the timer Worker with Wrangler now? Type YES' },
};
export class TerminalUI {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.input = input; this.output = output; this.tty = !!(input.isTTY && output.isTTY); this.language = 'ru'; this.muted = false;
    this.sink = new Writable({ write: (chunk, encoding, done) => { if (!this.muted) output.write(chunk); done(); } });
    this.open();
  }
  open() {
    this.rl = createInterface({ input: this.input, output: this.sink, terminal: this.tty, historySize: 0 });
    if (!this.tty) this.lines = this.rl[Symbol.asyncIterator]();
  }
  // Raw keys for the inline monitor: readline releases the TTY input and is reopened after.
  async takeover(fn) {
    if (!this.tty) throw new StateFailure('interactive_terminal_required');
    this.rl.close();
    try { return await fn({ input: this.input, output: this.output }); } finally { this.open(); }
  }
  text(value) { this.output.write(`${String(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')}\n`); }
  stage(step, label) { this.output.write(this.tty ? `\x1b[1;36m[${step}] ${label}\x1b[0m\n` : `[${step}] ${label}\n`); }
  async ask(label, { secret = false, defaultValue = '' } = {}) {
    this.text(`${label}${defaultValue ? ` [${defaultValue}]` : ''}:`);
    if (!this.tty) { const next = await this.lines.next(); if (next.done) throw new Error('input_closed'); return next.value.trim() || defaultValue; }
    this.muted = secret;
    try { return (await this.rl.question('> ')).trim() || defaultValue; }
    finally { this.muted = false; if (secret) this.text(''); }
  }
  table(rows) {
    const cells = rows.map(row => row.map(x => String(x ?? '').replace(/[\x00-\x1f\x7f]/g, ' ')));
    if (!this.tty || !cells.length) { for (const row of cells) this.text(row.join(' | ')); return; }
    const columns = Math.max(...cells.map(row => row.length));
    const widths = Array.from({ length: columns }, (_, i) => Math.max(...cells.map(row => (row[i] ?? '').length)));
    this.text('┌' + widths.map(w => '─'.repeat(w + 2)).join('┬') + '┐');
    for (const row of cells) this.text('│ ' + widths.map((w, i) => (row[i] ?? '').padEnd(w)).join(' │ ') + ' │');
    this.text('└' + widths.map(w => '─'.repeat(w + 2)).join('┴') + '┘');
  }
  close() { this.rl.close(); }
}

export async function promptQuotaSetup(ui, repository, now = () => Math.floor(Date.now() / 1000)) {
  const w = messages[ui.language];
  ui.text(w.billingSetup);
  if (await ui.ask(w.billingBudget) !== 'YES') return null;
  const plan = await ui.ask(w.billingPlan);
  if (!['free', 'pro'].includes(plan)) throw new StateFailure('billing_plan_unsupported');
  return { policy: { schema: 1, repository, budget: 0, stopUsage: true, verifiedAt: now(), plan } };
}

// Installation token step (ticket 40): blank input opens the prefilled form, then the issued
// token is checked. A short expiry and access beyond the repo are shown, not refused (ADR-0003).
export async function promptInstallationToken(ui, { repository, verify, open }) {
  const w = messages[ui.language];
  let token = await ui.ask(w.patToken, { secret: true });
  if (!token) {
    const url = tokenFormUrl(repository);
    open(url); ui.text(url); ui.text(w.pat);
    token = await ui.ask(w.patToken, { secret: true });
  }
  let checked;
  try { checked = await verify(token); }
  catch (error) { if (['installation_token_unauthorized', 'installation_token_expired'].includes(error.kind)) ui.text(w.tokenRejected); throw error; }
  if (checked.otherRepositories) ui.text(w.tokenBroad.replace('{count}', checked.otherRepositories));
  return { token, ...checked };
}
// Keychain step (ticket 41): a stored token is checked like a typed one. A rejected one (401,
// expired) asks for a new token; an unreadable Keychain falls back to hidden input without saving.
export async function loadInstallationToken(ui, { keychain, verify, prompt }) {
  const w = messages[ui.language];
  let stored;
  try { stored = await keychain.read(); } catch { ui.text(w.keychainUnavailable); return { ...(await prompt()), keychain: null, stored: false }; }
  if (stored) {
    try { return { token: stored, ...(await verify(stored)), keychain, stored: true }; }
    catch (error) { if (!['installation_token_unauthorized', 'installation_token_expired'].includes(error.kind)) throw error; ui.text(w.keychainStale); }
  }
  return { ...(await prompt()), keychain, stored: false };
}
// Saved only once accepted; a failed write leaves hidden input for the next run. Returns the
// Keychain the installer keeps following, or null.
export async function keepInstallationToken(ui, { keychain, token, repository }) {
  const w = messages[ui.language];
  if (!keychain) return null;
  try { await keychain.write(token); ui.text(w.keychainSaved.replace('{repository}', repository)); return keychain; }
  catch { ui.text(w.keychainUnavailable); return null; }
}
// A new token (install, k → 1) must read billing and is told its expiry; an installed one that
// predates ticket 40 may lack Plan: read until it is replaced with t.
export function acceptInstallationToken(ui, checked, { fresh, now = Math.floor(Date.now() / 1000) }) {
  const w = messages[ui.language];
  if (!checked.plan) { if (fresh) throw new StateFailure('installation_token_plan_required'); ui.text(w.tokenPlan); }
  if (fresh && shortToken(checked.expiresAt, now)) ui.text(w.tokenShort.replace('{date}', iso(checked.expiresAt)));
}

// Timer step (ticket 42): two clicks in GitHub — Create the timer app, Install it on the repo.
// The key stays inside register, verify and deploy; only the App ID, slug and installation ID
// come back. An App left behind by a failed step is shown with its deletion link.
export async function promptTimerSetup(ui, { repository, register, locate, verify, deploy, open }) {
  const w = messages[ui.language];
  ui.text(w.timerWhy); for (const line of w.timerSteps) ui.text(line);
  if (await ui.ask(w.timerReady) !== 'YES') return null;
  ui.text(w.timerCreate);
  let app;
  try { app = await register(); }
  catch (error) { if (error.app) ui.text(w.timerAppLeft.replace('{url}', appSettingsUrl(error.app.slug))); throw error; }
  try {
    const url = appInstallUrl(app.slug);
    open(url); ui.text(url); ui.text(w.timerInstall.replace('{repository}', repository));
    let found = null;
    while (!found) {
      if (await ui.ask(w.timerInstalled) !== 'YES') throw new StateFailure('timer_app_not_installed');
      try { found = await locate(app); }
      catch (error) { if (error.kind !== 'timer_app_not_installed') throw error; ui.text(w.timerNotInstalled); }
    }
    if (found.selection !== 'selected') ui.text(w.timerBroad); // Warn and continue (ADR-0003, 16 October).
    const timer = { ...app, installationId: found.installationId };
    await verify(timer);
    while (true) {
      try { await deploy(timer); break; }
      catch (error) { if (error.kind !== 'timer_wrangler_failed' || await ui.ask(w.timerRetry) !== 'YES') throw error; }
    }
    return { appId: app.appId, appSlug: app.slug, installationId: found.installationId };
  } catch (error) { ui.text(w.timerAppLeft.replace('{url}', appSettingsUrl(app.slug))); throw error; }
}
// A timer set up before ticket 42 still runs on the timer token: until c moves it to the app.
export function timerNotice(timer, language) {
  if (!Number.isSafeInteger(timer?.expiresAt)) return null;
  return messages[language].timerLegacy.replace('{date}', iso(timer.expiresAt));
}
export function tokenRows(s, expiresAt = null) {
  const at = expiresAt ?? s.installation?.grant?.expiresAt; // The token just checked is the current one.
  return [['installationTokenExpires', Number.isSafeInteger(at) ? iso(at) : '—']];
}
export function timerRows(s) {
  const t = s.installation?.timer, wake = s.scheduler?.wokenAt;
  return [['timer', t?.confirmedAt ? `confirmed ${iso(t.confirmedAt)}` : t?.probeAt ? `probe ${iso(t.probeAt)}` : 'setup required (c)'],
    ['lastExternalWake', Number.isSafeInteger(wake) ? iso(wake) : '—'],
    ['timerApp', t?.appSlug ? `${t.appSlug} (installation ${t.installationId})` :
      Number.isSafeInteger(t?.expiresAt) ? `timer token until ${iso(t.expiresAt)} (c)` : '—']];
}
