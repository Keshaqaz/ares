import { AuthFailure } from './auth-bundle.mjs';
import { StateFailure } from './state-store.mjs';
import { TIMER_GRACE_SECONDS } from './schedule-planner.mjs';

// First-run wizard (ticket 44): repo and installation token are asked on every start; then the
// wizard walks Install → ChatGPT login → quota → timer from the first step the state shows as
// not done. Progress is read from the state alone, so an interrupted wizard resumes by itself.
// Rules (m, w, 5) and enable (6) stay the user's own decision outside the wizard.
export const wizardMessages = {
  ru: { title: 'Мастер настройки', head: ['#', 'Шаг', ''],
    steps: { repo: 'Repo', token: 'Токен установки', install: 'Установка в repo', login: 'Вход ChatGPT', quota: 'Квота Actions', timer: 'Внешний таймер' },
    parts: {
      bootstrap: 'Загружаю программу и workflow в repo и создаю state установки (выключенной).',
      seed: 'Вход в отдельную CI-сессию ChatGPT через официальный Codex 0.160.1: нужен абсолютный путь к нему, затем вход в браузере.',
      recover: 'Новый вход сохранён; подтверждаю его, чтобы снять отметку отзыва/reconnect.',
      check: 'Проверяю подключение: чтение аккаунта и metadata сбросов, без применения.',
      configure: 'Политика бюджета Actions: подтвердите бюджет $0 и укажите план GitHub.',
      verify: 'Проверяю источник квоты в новой Actions job.',
      setup: 'Приложение таймера в GitHub и Worker в Cloudflare (несколько кликов в браузере).',
      probe: 'Жду пробный dispatch таймера (до 25 минут); выход безопасен — следующий запуск продолжит ожидание.' },
    go: 'Enter — выполнить, 0 — в меню',
    stalled: 'Шаг не завершён (причина выше). Повторите его: i в меню или следующий запуск.',
    done: 'Настройка завершена. Правила — m, w и 5; включение — 6, это ваше отдельное решение.',
    active: 'Установка включена, а шаг «{step}» не выполнен: мастер работает на паузе (7 Пауза → i).',
    stopped: 'Операция остановлена' },
  en: { title: 'Setup wizard', head: ['#', 'Step', ''],
    steps: { repo: 'Repo', token: 'Installation token', install: 'Install into the repo', login: 'ChatGPT login', quota: 'Actions quota', timer: 'External timer' },
    parts: {
      bootstrap: 'Uploading the program and workflow to the repo and creating the (disabled) installation state.',
      seed: 'Login to a separate ChatGPT CI session with the official Codex 0.160.1: its absolute path is needed, then the browser login.',
      recover: 'The new login is saved; confirming it clears the revoked/reconnect mark.',
      check: 'Checking the connection: reads the account and reset metadata, applies nothing.',
      configure: 'Actions budget policy: confirm the $0 budget and enter your GitHub plan.',
      verify: 'Checking the quota source in a new Actions job.',
      setup: 'The timer app in GitHub and the Worker in Cloudflare (a few clicks in the browser).',
      probe: 'Waiting for the timer probe dispatch (up to 25 minutes); exiting is safe, the next run keeps waiting.' },
    go: 'Enter to run, 0 for the menu',
    stalled: 'The step did not finish (reason above). Repeat it: i in the menu or the next run.',
    done: 'Setup is complete. Rules: m, w and 5; enabling is 6, your own separate decision.',
    active: 'The installation is enabled while step "{step}" is not done: the wizard runs paused (7 Pause → i).',
    stopped: 'Operation stopped' },
};
export const WIZARD_STEPS = ['repo', 'token', 'install', 'login', 'quota', 'timer'];

// The first unfinished step and its part, or null when all are done. s is the installation
// status (null before Install).
export function wizardStep(s, { now }) {
  if (!s?.installation) return { step: 'install', part: 'bootstrap' };
  const i = s.installation, session = s.auth?.phase === 'ready' ? s.auth.committed?.sessionId : undefined;
  // A revoke or reconnect forgets seedSession, so a new login comes before recover.
  if (!session || i.seedSession !== session) return { step: 'login', part: 'seed' };
  if (s.revoked || s.reconnectRequested) return { step: 'login', part: 'recover' };
  if (i.checkedSession !== session) return { step: 'login', part: 'check' };
  if (!i.quota) return { step: 'quota', part: 'configure' };
  if (!i.quota.verified) return { step: 'quota', part: 'verify' };
  const t = i.timer;
  if (t?.confirmedAt && !Number.isSafeInteger(t.expiresAt)) return null;
  // A probe still inside its grace is awaited; a missed one, a timer token or none sets up c again.
  if (t && !Number.isSafeInteger(t.expiresAt) && Number.isSafeInteger(t.probeAt) && now <= t.probeAt + TIMER_GRACE_SECONDS) return { step: 'timer', part: 'probe' };
  return { step: 'timer', part: 'setup' };
}
// Auto-start: something is left and the steps may run (paused, or nothing installed yet).
export const wizardDue = (s, now) => (!s || s.disabled) && wizardStep(s, { now }) !== null;

// Runs parts until all are done, the user picks 0, a part fails or makes no progress. parts maps
// a part to the menu's own handler; it returns false when the user declined inside it.
export async function runWizard(ui, { status, parts, now = () => Math.floor(Date.now() / 1000) }) {
  const w = wizardMessages[ui.language];
  let last = null;
  while (true) {
    const s = await status(), next = wizardStep(s, { now: now() });
    if (!next) { ui.text(w.done); return 'done'; }
    if (s && !s.disabled) { ui.text(w.active.replace('{step}', w.steps[next.step])); return 'enabled'; }
    if (last && last.step === next.step && last.part === next.part) { ui.text(w.stalled); return 'stalled'; }
    const at = WIZARD_STEPS.indexOf(next.step);
    if (!last) {
      ui.text(w.title);
      ui.table([w.head, ...WIZARD_STEPS.map((step, n) => [String(n + 1), w.steps[step], n < at ? '✓' : n === at ? '→' : ''])]);
    }
    ui.stage(`${at + 1}/${WIZARD_STEPS.length}`, w.steps[next.step]);
    ui.text(w.parts[next.part]);
    if (await ui.ask(w.go) === '0') return 'menu';
    try { if (await parts[next.part]() === false) return 'menu'; }
    catch (error) {
      ui.text(`${w.stopped}: ${error instanceof AuthFailure || error instanceof StateFailure ? error.kind : 'installer_failed'}`);
      return 'failed';
    }
    last = next;
  }
}
