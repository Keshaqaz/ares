const time = value => value === null ? '—' : new Date(value * 1000).toISOString();
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('|', '&#124;').replaceAll('`', '&#96;').replace(/[\r\n]/g, ' ');
const strings = {
  ru: {
    title: 'Применение выданных сбросов', version: 'Версия', disabled: 'Новые попытки отключены', revoked: 'Установка отозвана',
    reconnect: 'Требуется переподключение', unknown: 'Исход не подтверждён: новые consume остановлены',
    metadata: 'Проблема проверки metadata', id: 'ID', expiry: 'Срок активации', target: 'Целевой момент', deadline: 'Граница',
    last: 'Последняя попытка', next: 'Следующая попытка', result: 'Последний результат', state: 'Состояние',
    commands: 'Принятые команды (принятие не означает применение)', retry: 'Можно повторить часовой цикл', trigger: 'Источник',
    triggers: { select: 'явный выбор', expiry: 'правило: за 30 минут до истечения', weekly: 'правило: недельная квота', manual: 'применить сейчас' },
    none: 'Без срока', missing: 'Неизвестен', statuses: { notScheduled: 'Автоматизация не выбрана', scheduled: 'Запланировано', waiting: 'Ожидает подходящего окна',
      unconfirmed: 'Исход не подтверждён', applied: 'Применение подтверждено', ended: 'Цикл завершён',
      metadataBlocked: 'Требуется проверка metadata', reconnectRequired: 'Требуется переподключение',
      groupConflict: 'Конфликт минутной группы', superseded: 'Расписание заменено' },
  },
  en: {
    title: 'Granted reset application', version: 'Version', disabled: 'New attempts disabled', revoked: 'Installation revoked',
    reconnect: 'Reconnect required', unknown: 'Outcome unconfirmed: new consume requests stopped', metadata: 'Metadata verification problem',
    id: 'ID', expiry: 'Activation expiry', target: 'Target start', deadline: 'Deadline', last: 'Last attempt', next: 'Next attempt',
    result: 'Last result', state: 'Status', commands: 'Accepted commands (acceptance does not confirm application)',
    retry: 'Hourly cycle can be retried', trigger: 'Source',
    triggers: { select: 'explicit selection', expiry: 'rule: 30 minutes before expiry', weekly: 'rule: weekly quota', manual: 'apply now' }, none: 'No expiry', missing: 'Unknown',
    statuses: { notScheduled: 'No automation selected', scheduled: 'Scheduled', waiting: 'Waiting for an eligible window', unconfirmed: 'Outcome unconfirmed',
      applied: 'Application confirmed', ended: 'Cycle ended', metadataBlocked: 'Metadata verification required',
      reconnectRequired: 'Reconnect required', groupConflict: 'Minute group conflict', superseded: 'Schedule replaced' },
  },
};
export function renderCycleReport(report) {
  const words = strings[report.language] ?? strings.en;
  const lines = [`# ${words.title}`, '', `${words.version}: ${report.version}`, ''];
  const ru = report.language === 'ru';
  const on = value => value ? (ru ? 'включено' : 'enabled') : (ru ? 'выключено' : 'disabled');
  lines.push(`${ru ? 'Автоприменение при исчерпании недельной квоты' : 'Auto reset on weekly exhaustion'}: ${on(report.weeklyAutoReset)}`, '',
    `${ru ? 'Автоприменение за 30 минут до истечения' : 'Auto reset 30 minutes before expiry'}: ${on(report.beforeExpiry)}`, '',
    ru ? 'Недельное правило и явный выбор требуют свежего подтверждения недельного исчерпания до обновления; пятичасовой отказ недостаточен. Правило срока и «применить сейчас» его не требуют.' :
      'The weekly rule and an explicit selection require fresh evidence of weekly exhaustion before renewal; five-hour exhaustion is insufficient. The expiry rule and apply-now do not.', '');
  for (const [flag, label] of [['disabled', 'disabled'], ['revoked', 'revoked'],
    ['reconnectRequested', 'reconnect'], ['outcomeUnconfirmed', 'unknown']]) {
    if (report[flag]) lines.push(words[label], '');
  }
  if (report.metadataProblem) lines.push(`${words.metadata}: ${escape(report.metadataProblem)}`, '');
  if (report.scheduler) {
    const p = report.scheduler, ru = report.language === 'ru';
    lines.push(ru ? '## Расписание и квота' : '## Schedule and quota', '',
      `${ru ? 'Допуск' : 'Admission'}: ${escape(p.mode)}${p.reason ? ` (${escape(p.reason)})` : ''}`, '',
      `${ru ? 'Публикация расписания' : 'Schedule publication'}: ${escape(p.publication)}${p.problem ? ` (${escape(p.problem)})` : ''}`, '');
    for (const f of p.desired?.forecast ?? []) lines.push(
      `${time(f.start)} — ${time(f.end)}: ${f.runnerJobs} jobs + ${f.pendingJobs} pending; ${f.minutesWithReserve} / 1000 min (${ru ? 'включая резерв 100' : 'including reserve 100'})`, '');
    if (p.publication !== 'confirmed' && p.observed) for (const f of p.observed.forecast) lines.push(
      `${ru ? 'Последнее прочитанное расписание без подтверждённой очистки' : 'Last observed schedule without confirmed cleanup'}: ${f.runnerJobs} jobs + ${f.pendingJobs} pending; ${f.minutesWithReserve} / 1000 min`, '');
    for (const warning of p.desired?.warnings ?? []) lines.push(`- ${escape(warning)}`);
    if (p.mode !== 'active') lines.push('', ru ?
      'Новые consume остановлены. Сверьте квоту и защиту платного расхода, затем явно выполните resume с новым допуском и reconcile; исходные границы сохраняются.' :
      'New consume requests stopped. Verify quota and paid usage protection, then explicitly resume with fresh admission and reconcile; original deadlines are retained.');
    if (p.publication !== 'confirmed') lines.push('', ru ? 'Остановка/установка расписания не подтверждена; старые и queued jobs могут расходовать минуты.' :
      'Schedule removal/installation unconfirmed; old and queued jobs may still spend runner minutes.');
    lines.push('');
  }
  for (const c of report.cycles) {
    lines.push(`## ${words.id}: ${escape(c.creditId)}`, '', `| ${words.state} | ${escape(words.statuses[c.status])} |`, '| --- | --- |');
    for (const [label, value] of [
      ['expiry', c.expiry.kind === 'at' ? time(c.expiry.unixSeconds) : c.expiry.kind === 'none' ? words.none : words.missing],
      ['target', time(c.scheduledAt)], ['deadline', time(c.deadline)], ['last', time(c.lastAttemptAt)],
      ['next', time(c.nextAttemptAt)], ['result', c.lastResult ?? '—'], ['metadata', c.metadataProblem ?? '—'],
      ['trigger', words.triggers[c.trigger] ?? c.trigger ?? '—'],
    ]) lines.push(`| ${words[label]} | ${escape(value)} |`);
    if (c.executionProblem) lines.push('', `${report.language === 'ru' ? 'Проблема исполнения' : 'Execution problem'}: ${escape(c.executionProblem)}`);
    if (c.retryAvailable) lines.push('', words.retry);
    lines.push('');
  }
  if (report.commands.length) {
    lines.push(`## ${words.commands}`, '');
    for (const c of report.commands) lines.push(`- ${escape(c.commandId)}: ${escape(c.action)} — ${escape(c.state)}`);
    lines.push('');
  }
  return lines.join('\n');
}
