import { emitKeypressEvents } from 'node:readline';
import { BEFORE_EXPIRY_SECONDS } from '../core/reset-cycles.mjs';
import { POLICY } from '../schedule/schedule-planner.mjs';

// Monitor of the installer (`m`): issued resets, global rules, apply now, status and journal.
// Inline in the ordinary terminal flow, redrawn in place; no alternate screen. Visual language
// of the .scratch/terminal-ui concept; boot-log tags and the bounce spinner are adapted from
// https://ascii.rest (MIT, © @Shubham / bas3line), see docs/NOTICES.md.
export const monitorMessages = {
  ru: { resets: 'ВЫДАННЫЕ СБРОСЫ', rules: 'ОБЩИЕ ПРАВИЛА', connection: 'ПОДКЛЮЧЕНИЕ', quota: 'КВОТА', journal: 'ЖУРНАЛ',
    beforeExpiry: `за ${BEFORE_EXPIRY_SECONDS / 60} минут до истечения`, weekly: 'автоматически при исчерпании недельной квоты',
    available: '● доступен', window: 'окно с', running: 'попытки идут', unconfirmed: 'исход не подтверждён', blocked: 'ожидает проверки',
    expires: 'истекает', noExpiry: 'бессрочный', unknownExpiry: 'срок неизвестен',
    empty: 'Доступных сбросов нет — применённые скрыты.', emptyHint: 'Новые выданные сбросы появятся после следующего чтения (discovery раз в 4 часа).',
    partial: 'Список неполный: показаны видимые сбросы.', watch: 'наблюдение за квотой до',
    paused: 'Установка на паузе: правила сохраняются, применение начнётся после включения (6).',
    applyTitle: 'Применить сейчас', reset: 'сброс', yes: 'да: начать цикл попыток сейчас, без условий правил', no: 'n / Esc — отмена',
    noGuarantee: 'Принятие команды ≠ применение; попытки раз в 5 минут, без SLA.',
    hintList: '↑↓ выбор · Enter — применить сейчас / общие правила · r обновить', hintRules: '↑↓ опция · Enter/Space — отметить/снять · правило для всех сбросов · Esc — выйти',
    hintStatus: 'r обновить · Esc назад', bar: '1 монитор · 2 статус   │   q выход',
    sending: 'Отправка команды', updated: 'Обновлено', accepted: 'Команда сохранена', pendingCmd: 'Доставка не подтверждена; r — проверить снова', stopped: 'Операция остановлена',
    repo: 'репозиторий', installation: 'установка', active: 'активна', pausedShort: 'на паузе', revoked: 'отозвана', reconnect: 'нужен повторный вход (2)',
    outcome: 'неподтверждённый исход — новые применения остановлены', timer: 'таймер', timerOk: 'подтверждён', timerProbe: 'проба', timerNone: 'не настроен (c)',
    schedule: 'расписание', publication: 'публикация', forecast: 'прогноз', minutes: 'мин', reserve: 'резерв', verified: 'источник проверен', unverified: 'нужна настройка (q, b)',
    noJournal: 'Событий пока нет.', attempt: 'попытка', command: 'команда',
    states: { applied: 'применение подтверждено', nothingToReset: 'нечего сбрасывать — повтор через 5 минут', noCredit: 'сброс не найден',
      notSent: 'не отправлено', unconfirmed: 'исход не подтверждён', accepted: 'принята' } },
  en: { resets: 'ISSUED RESETS', rules: 'GLOBAL RULES', connection: 'CONNECTION', quota: 'QUOTA', journal: 'JOURNAL',
    beforeExpiry: `${BEFORE_EXPIRY_SECONDS / 60} minutes before expiry`, weekly: 'automatically when the weekly quota is exhausted',
    available: '● available', window: 'window from', running: 'attempting', unconfirmed: 'outcome unconfirmed', blocked: 'awaiting check',
    expires: 'expires', noExpiry: 'no expiry', unknownExpiry: 'expiry unknown',
    empty: 'No available resets — applied ones are hidden.', emptyHint: 'New issued resets appear after the next read (discovery every 4 hours).',
    partial: 'Incomplete list: visible resets are shown.', watch: 'watching until',
    paused: 'Installation paused: rules are saved, applying starts after enable (6).',
    applyTitle: 'Apply now', reset: 'reset', yes: 'yes: start an attempt cycle now, without rule conditions', no: 'n / Esc — cancel',
    noGuarantee: 'Accepted command ≠ applied; attempts every 5 minutes, no SLA.',
    hintList: '↑↓ select · Enter — apply now / global rules · r refresh', hintRules: '↑↓ option · Enter/Space — check/uncheck · one rule for all resets · Esc — leave',
    hintStatus: 'r refresh · Esc back', bar: '1 monitor · 2 status   │   q exit',
    sending: 'Sending command', updated: 'Refreshed', accepted: 'Command saved', pendingCmd: 'Delivery unconfirmed; r to check again', stopped: 'Operation stopped',
    repo: 'repository', installation: 'installation', active: 'active', pausedShort: 'paused', revoked: 'revoked', reconnect: 'login required (2)',
    outcome: 'unconfirmed outcome — new applications stopped', timer: 'timer', timerOk: 'confirmed', timerProbe: 'probe', timerNone: 'not set up (c)',
    schedule: 'schedule', publication: 'publication', forecast: 'forecast', minutes: 'min', reserve: 'reserve', verified: 'source checked', unverified: 'setup required (q, b)',
    noJournal: 'No events yet.', attempt: 'attempt', command: 'command',
    states: { applied: 'application confirmed', nothingToReset: 'nothing to reset — retry in 5 minutes', noCredit: 'reset not found',
      notSent: 'not sent', unconfirmed: 'outcome unconfirmed', accepted: 'accepted' } },
};

const S = { dim: '2', boldWhite: '1;97', boldCyan: '1;36', cyan: '36', dimCyan: '2;36', green: '32', boldGreen: '1;32',
  yellow: '33', boldYellow: '1;33', red: '31', brand: '1;35', inverse: '7' };
const MONTHS = { ru: ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] };
const p2 = n => String(n).padStart(2, '0');
const date = (at, language) => { const d = new Date(at * 1000); return `${p2(d.getUTCDate())} ${MONTHS[language][d.getUTCMonth()]}`; };
export const fmtHM = (at, language) => `${date(at, language)} ${p2(new Date(at * 1000).getUTCHours())}:${p2(new Date(at * 1000).getUTCMinutes())} UTC`;
const clock = (at, language) => `${date(at, language)} ${new Date(at * 1000).toISOString().slice(11, 19)}`;
const terminal = c => ['applied', 'ended', 'superseded'].includes(c.status);
// Server values never carry control characters into the terminal.
const clean = v => String(v ?? '').replace(/[\x00-\x1f\x7f]/g, ' ');
const len = text => [...text].length;
const clip = (text, n) => [...text].slice(0, Math.max(0, n)).join('');

// bounce spinner and "a start job is running" stars of the boot log, at 8 steps per second.
const ping = (n, i) => i % (2 * n - 2) < n ? i % (2 * n - 2) : 2 * n - 2 - i % (2 * n - 2);
const bounce = t => { const p = ping(6, Math.floor(t * 12)); return `[${' '.repeat(p)}o${' '.repeat(5 - p)}]`; };
const stars = t => { const k = Math.floor(t * 8) % 6, p = k < 4 ? k : 6 - k; return `[${(' '.repeat(p) + '***').padEnd(6)}]`; };

// One reset row: the latest stored list joined with the current cycle of the same ID.
export function monitorResets(state, now) {
  const credits = state.installation?.metadata?.credits ?? [];
  return credits.filter(c => c.status === 'available' && c.resetType === 'codexRateLimits' &&
      !state.cycles.some(x => x.creditId === c.id && x.status === 'applied') &&
      !(c.expiry.kind === 'at' && c.expiry.unixSeconds <= now))
    .sort((a, b) => (a.expiry.unixSeconds ?? Infinity) - (b.expiry.unixSeconds ?? Infinity) || a.id.localeCompare(b.id))
    .map(c => {
      const cycle = state.cycles.find(x => x.current && x.creditId === c.id && !terminal(x) && x.hasSchedule && now < x.deadline);
      const phase = !cycle ? 'available' : cycle.status === 'unconfirmed' ? 'unconfirmed' :
        cycle.metadataProblem ? 'blocked' : now < cycle.scheduledAt ? 'window' : 'running';
      return { id: c.id, expiry: c.expiry, phase, scheduledAt: cycle?.scheduledAt ?? null };
    });
}

function journal(state) {
  const rows = [
    ...state.requests.map(r => ({ at: r.finishedAt ?? r.attemptAt, kind: 'attempt', id: r.creditId,
      level: r.state === 'applied' ? 'ok' : r.state === 'unconfirmed' ? 'warn' : 'info', state: r.state, reason: r.reason })),
    ...state.commands.map(c => ({ at: c.acceptedAt, kind: 'command', id: c.result.action, level: 'ok', state: c.result.state, reason: null })),
  ];
  return rows.sort((a, b) => b.at - a.at);
}

// Pure render: view state → array of lines (each a list of [text, style] segments).
export function renderMonitor(state, view, { now, t = now, width = 96, language = 'ru', repository = '' }) {
  const w = monitorMessages[language], lines = [], push = (...segs) => lines.push(segs);
  const right = (left, rightSegs) => {
    const used = left.reduce((n, [s]) => n + len(s), 0), r = rightSegs.reduce((n, [s]) => n + len(s), 0);
    return [...left, [' '.repeat(Math.max(1, width - used - r)), ''], ...rightSegs];
  };
  lines.push(right([['ARES', S.brand]], [[clock(now, language), S.dim]]));
  push();
  if (view.screen === 'status') statusScreen(state, view, { now, t, width, w, language, repository, push });
  else {
    const list = monitorResets(state, now);
    push([`${w.resets}${list.length ? ` · ${list.length}` : ''}`, S.boldWhite]);
    push(['─'.repeat(width), S.dim]);
    if (state.installation?.metadata?.kind === 'partial') push([`  ${w.partial}`, S.yellow]);
    if (!list.length) { push([`  ${w.empty}`, S.dim]); push([`  ${w.emptyHint}`, S.dim]); }
    list.forEach((r, i) => {
      const sel = view.focus === 'list' && view.selected === i;
      const status = { available: [w.available, S.green], window: [`${w.window} ${fmtHM(r.scheduledAt, language)}`, S.cyan],
        running: [`${w.running} ${bounce(t)}`, S.boldYellow], unconfirmed: [w.unconfirmed, S.boldYellow], blocked: [w.blocked, S.yellow] }[r.phase];
      const expiry = r.expiry.kind === 'at' ? `${w.expires} ${fmtHM(r.expiry.unixSeconds, language)}` : r.expiry.kind === 'none' ? w.noExpiry : w.unknownExpiry;
      lines.push(right([[sel ? '▸ ' : '  ', sel ? S.boldCyan : S.dim], [clip(clean(r.id), 24).padEnd(26), sel ? S.boldCyan : S.boldWhite], status],
        [[expiry, sel ? S.boldCyan : S.dim]]));
    });
    push();
    push([w.rules, S.boldWhite]);
    const boxed = view.focus === 'rules' || view.selected === list.length && view.focus === 'list';
    const frame = boxed ? S.boldCyan : S.dim;
    push(['╭' + '─'.repeat(width - 2) + '╮', frame]);
    [['beforeExpiry', w.beforeExpiry], ['weeklyAutoReset', w.weekly]].forEach(([key, label], i) => {
      const on = state.settings[key], cursor = view.focus === 'rules' && view.cursor === i, busy = view.busyRule === key;
      const mark = `${cursor ? '▸' : ' '} ${on ? '☑' : '☐'} `;
      const extra = busy ? ` ${bounce(t)}` : key === 'weeklyAutoReset' && on && state.weeklyWatchUntil > now ? ` · ${w.watch} ${fmtHM(state.weeklyWatchUntil, language).slice(-9)}` : '';
      const body = clip(label + extra, width - 7);
      push(['│ ', frame], [mark, cursor ? S.boldCyan : on ? S.green : S.dim], [body.padEnd(width - 7), on ? S.boldWhite : S.dim], ['│', frame]);
    });
    push(['╰' + '─'.repeat(width - 2) + '╯', frame]);
    if (state.disabled) push([clip(w.paused, width), S.yellow]);
    if (view.confirm) {
      const r = list.find(x => x.id === view.confirm);
      const rows = [[`${w.reset} `, S.dim, clean(view.confirm), S.boldWhite],
        [r?.expiry.kind === 'at' ? `${w.expires} ${fmtHM(r.expiry.unixSeconds, language)}` : w.unknownExpiry, S.dim, '', ''],
        [w.noGuarantee, S.dim, '', ''], ['y ', S.boldGreen, w.yes, S.dim], [w.no, S.dim, '', '']];
      const inner = Math.min(width - 4, Math.max(...rows.map(([a, , b]) => len(a) + len(b))) + 2);
      push();
      push(['╭─ ', S.dim], [w.applyTitle, S.boldWhite], [` ${'─'.repeat(Math.max(0, inner - len(w.applyTitle) - 2))}╮`, S.dim]);
      for (const [a, sa, b, sb] of rows) push(['│ ', S.dim], [a, sa], [clip(b, inner - len(a)), sb],
        [' '.repeat(Math.max(0, inner - len(a) - len(clip(b, inner - len(a))))), ''], ['│', S.dim]);
      push(['╰' + '─'.repeat(inner + 1) + '╯', S.dim]);
    }
  }
  push();
  if (view.message) push([clip(view.message.text, width), view.message.level === 'warn' ? S.yellow : view.message.level === 'busy' ? S.cyan : S.green],
    ...(view.message.level === 'busy' ? [[` ${bounce(t)}`, S.cyan]] : []));
  push([clip(view.screen === 'status' ? w.hintStatus : view.focus === 'rules' ? w.hintRules : w.hintList, width), S.dim]);
  push([clip(` ${w.bar}`.padEnd(width), width), S.inverse]);
  return lines.map(segs => fit(segs, width));
}

// A wrapped line would break the in-place redraw: every line is cut to the width.
function fit(segs, width) {
  let room = width;
  return segs.map(([text = '', style = '']) => { const part = clip(text, room); room -= len(part); return [part, style]; });
}

function statusScreen(state, view, { now, t, width, w, language, repository, push }) {
  const row = (label, value, style = S.dim) => push([`  ${label.padEnd(14)}`, S.dim], [clip(clean(value), width - 16), style]);
  const timer = state.installation?.timer, sch = state.scheduler, quota = state.installation?.quota;
  push([w.connection, S.boldWhite]);
  row(w.repo, repository);
  row(w.installation, state.revoked ? w.revoked : state.disabled ? w.pausedShort : w.active, state.revoked ? S.red : state.disabled ? S.yellow : S.green);
  if (state.reconnectRequested) row('', w.reconnect, S.yellow);
  if (state.requests.some(r => r.state === 'unconfirmed')) row('', w.outcome, S.boldYellow);
  row(w.timer, timer?.confirmedAt ? `${w.timerOk} ${fmtHM(timer.confirmedAt, language)}` : timer?.probeAt ? `${w.timerProbe} ${fmtHM(timer.probeAt, language)}` : w.timerNone,
    timer?.confirmedAt ? S.green : S.yellow);
  row(w.schedule, `${sch?.mode ?? '—'}${sch?.reason ? ` · ${sch.reason}` : ''} · ${w.publication} ${sch?.publication ?? '—'}`, sch?.mode === 'active' ? S.green : S.yellow);
  push();
  push([w.quota, S.boldWhite]);
  const period = sch?.desired?.forecast?.[0];
  if (period) {
    const used = Math.min(POLICY.limitMinutes, period.minutesWithReserve), cells = 40, fill = Math.round(used / POLICY.limitMinutes * cells);
    const reserve = Math.round(POLICY.reserveMinutes / POLICY.limitMinutes * cells);
    row(w.forecast, `${period.minutesWithReserve} / ${POLICY.limitMinutes} ${w.minutes} · ${w.reserve} ${POLICY.reserveMinutes}`);
    push(['  '.padEnd(16), ''], ['█'.repeat(fill) + '·'.repeat(Math.max(0, cells - fill - reserve)) + '░'.repeat(Math.min(reserve, cells - fill)), S.cyan]);
  }
  row('', quota?.verified ? `${w.verified} · ${quota.policy.plan} · $0 · Stop usage` : w.unverified, quota?.verified ? S.dim : S.yellow);
  push();
  push([w.journal, S.boldWhite]);
  push(['─'.repeat(width), S.dim]);
  const events = journal(state).slice(0, view.journalRows ?? 10);
  if (!events.length) push([`  ${w.noJournal}`, S.dim]);
  for (const e of events) {
    const tag = e.level === 'warn' && e.kind === 'attempt' ? [stars(t), S.cyan] : { ok: ['[  OK  ]', S.green], warn: ['[ WARN ]', S.yellow], info: ['[ INFO ]', S.dimCyan] }[e.level];
    push([new Date(e.at * 1000).toISOString().slice(11, 19) + ' ', S.dimCyan], tag,
      [` ${w[e.kind]} ${clean(e.id)} · ${w.states[e.state] ?? clean(e.state)}${e.reason ? ` · ${clean(e.reason)}` : ''}`, S.dim]);
  }
}

export const paint = (segments, color) => segments.map(([text = '', style = '']) =>
  color && style && text ? `\x1b[${style}m${text}\x1b[0m` : text).join('');

// Key → next view and an optional action; no I/O, so navigation is tested without a terminal.
export function monitorKey(view, key, state, now) {
  const list = monitorResets(state, now), v = { ...view, message: view.message?.level === 'busy' ? view.message : null };
  if (view.busy) return { view: v };
  if (view.confirm) {
    if (key.name === 'y') return { view: { ...v, confirm: null }, action: { action: 'apply-now', creditId: view.confirm } };
    if (['n', 'escape'].includes(key.name)) return { view: { ...v, confirm: null } };
    return { view: v };
  }
  if (key.name === 'q' || key.ctrl && key.name === 'c') return { view: v, exit: true };
  if (key.name === '1' || key.sequence === '1') return { view: { ...v, screen: 'monitor', focus: 'list' } };
  if (key.name === '2' || key.sequence === '2') return { view: { ...v, screen: 'status' } };
  if (key.name === 'r') return { view: v, reload: true };
  if (view.screen === 'status') return key.name === 'escape' ? { view: { ...v, screen: 'monitor' } } : { view: v };
  if (view.focus === 'rules') {
    if (['up', 'down'].includes(key.name)) return { view: { ...v, cursor: 1 - view.cursor } };
    if (key.name === 'escape') return { view: { ...v, focus: 'list' } };
    if (['return', 'space'].includes(key.name)) {
      const setting = view.cursor === 0 ? 'beforeExpiry' : 'weeklyAutoReset';
      return { view: { ...v, busyRule: setting }, action: { action: view.cursor === 0 ? 'before-expiry' : 'weekly-auto', enabled: !state.settings[setting] } };
    }
    return { view: v };
  }
  const n = list.length + 1, selected = Math.min(view.selected, n - 1); // the rules block is the last item
  if (key.name === 'up') return { view: { ...v, selected: (selected + n - 1) % n } };
  if (key.name === 'down') return { view: { ...v, selected: (selected + 1) % n } };
  if (key.name === 'return') {
    if (selected === n - 1) return { view: { ...v, selected, focus: 'rules', cursor: 0 } };
    return { view: { ...v, selected, confirm: list[selected].id } };
  }
  if (key.name === 'escape') return { view: v, exit: true };
  return { view: v };
}

// Interactive loop. send(control) dispatches a sealed control and resolves its receipt; refresh()
// re-checks a pending command (idle when none); load() returns the current state. Failures become messages.
export async function runMonitor({ input, output, language = 'ru', repository = '', load, send, refresh, now = () => Math.floor(Date.now() / 1000), wake = 1000 }) {
  const w = monitorMessages[language];
  let state = await load(), view = { screen: 'monitor', focus: 'list', selected: 0, cursor: 0, confirm: null, message: null, busy: false, busyRule: null };
  let drawn = 0, closed = false, timer;
  const draw = () => {
    if (closed) return;
    const width = Math.max(60, Math.min(100, (output.columns || 80) - 1)), ms = Date.now();
    view.journalRows = Math.max(4, (output.rows || 34) - 24);
    const lines = renderMonitor(state, view, { now: now(), t: ms / 1000, width, language, repository }).map(l => paint(l, true));
    output.write(`\x1b[?2026h${drawn ? `\r\x1b[${drawn}A` : ''}\x1b[0J${lines.join('\n')}\n\x1b[?2026l`);
    drawn = lines.length;
  };
  const schedule = () => { clearTimeout(timer); if (!closed) timer = setTimeout(() => { draw(); schedule(); }, view.busy ? 125 : wake); };
  const act = async (fn, okText) => {
    view = { ...view, busy: true, message: { level: 'busy', text: w.sending } }; draw(); schedule();
    try {
      const receipt = await fn();
      view.message = receipt?.state === 'idle' ? { level: 'ok', text: okText ?? w.updated } : receipt?.state === 'accepted' ? receipt.problem ? { level: 'warn', text: `${w.stopped}: ${receipt.problem}` } : { level: 'ok', text: okText ?? w.accepted }
        : { level: 'warn', text: w.pendingCmd };
    } catch (error) { view.message = { level: 'warn', text: `${w.stopped}: ${error?.kind ?? 'installer_failed'}` }; }
    try { state = await load(); } catch (error) { view.message ??= { level: 'warn', text: `${w.stopped}: ${error?.kind ?? 'installer_failed'}` }; }
    view = { ...view, busy: false, busyRule: null }; draw(); schedule();
  };
  emitKeypressEvents(input);
  const raw = input.isRaw;
  input.setRawMode?.(true); input.resume();
  output.write('\x1b[?25l');
  try {
    await new Promise(resolve => {
      const onKey = (sequence, key = {}) => {
        const next = monitorKey(view, { ...key, sequence, name: key.name ?? sequence }, state, now());
        view = next.view;
        if (next.exit) { input.off('keypress', onKey); resolve(); return; }
        if (next.action) act(() => send(next.action));
        else if (next.reload) act(refresh);
        else draw();
      };
      input.on('keypress', onKey);
      draw(); schedule();
    });
  } finally {
    closed = true; clearTimeout(timer);
    input.setRawMode?.(raw ?? false); input.pause();
    output.write('\x1b[?25h');
  }
}
