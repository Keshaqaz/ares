// What the worker publishes openly for `status`: never the session, the account id or
// the pending redeem_request_id. Every field is copied explicitly, nothing is spread.
export const SUMMARY_FORMAT_VERSION = 1;
const iso = ms => ms == null ? null : new Date(ms).toISOString();

// summary.json. It has no tick time, so a tick that changes nothing commits nothing;
// the time of every tick is in its run and its Actions Summary.
export function openSummary({ state, rules }) {
  const applied = state.applied?.at(-1);
  const attempt = state.lastAttempt;
  // The tick reads the list before it applies a reset, so the list still has the one applied.
  const spent = new Set((state.applied ?? []).map(a => a.creditId));
  return {
    formatVersion: SUMMARY_FORMAT_VERSION,
    resets: (state.observed?.resets ?? []).filter(reset => !spent.has(reset.id))
      .map(reset => ({ creditId: reset.id, expiresAt: iso(reset.expiresAt) })),
    rules: { beforeExpiry: rules.beforeExpiry, weeklyAutoApply: rules.weeklyAutoApply },
    lastApplied: applied ? { creditId: applied.creditId, reason: applied.reason, at: iso(applied.at) } : null,
    lastAttempt: attempt ? { creditId: attempt.creditId, reason: attempt.reason, result: attempt.result, at: iso(attempt.at) } : null,
    // The verdict on the latest `login`, which the CLI matches by id.
    login: state.login ? { id: state.login.id, result: state.login.result, at: iso(state.login.at) } : null,
  };
}

const VERDICTS = {
  idle: 'Проверка прошла, применять нечего.',
  applied: 'Сброс применён.',
  pending: 'Результат применения неизвестен, следующий тик сверит его со списком сбросов.',
  transient_error: 'Временная ошибка, следующий тик повторит проверку.',
  reauth_required: 'Сессия воркера потеряна. Войдите заново: `codex-auto-resets login`.',
  broken_state: 'Файлы воркера не читаются. Переустановите воркер: `codex-auto-resets setup`.',
  commit_failed: 'State не удалось сохранить в репозитории. Если следующий запуск сообщит о потере сессии, войдите заново: `codex-auto-resets login`.',
};

// Markdown for $GITHUB_STEP_SUMMARY.
export function stepSummary({ outcome, reason = null, summary = null, now }) {
  const lines = ['### codex-auto-resets', '', `Тик: ${iso(now)}`, '', VERDICTS[outcome] ?? outcome];
  if (reason) lines.push('', `Причина: \`${reason}\``);
  if (summary) {
    const { beforeExpiry, weeklyAutoApply } = summary.rules;
    lines.push('', `Правила: перед истечением — ${beforeExpiry ? 'включено' : 'выключено'}, ` +
      `при исчерпании недельной квоты — ${weeklyAutoApply ? 'включено' : 'выключено'}.`);
    lines.push('', `Сбросов: ${summary.resets.length}`);
    for (const reset of summary.resets) lines.push(`- \`${reset.creditId}\`: ${reset.expiresAt ?? 'без срока'}`);
    if (summary.lastApplied) lines.push('', `Последнее применение: \`${summary.lastApplied.creditId}\` ${summary.lastApplied.at}`);
    if (summary.login?.at === iso(now)) {
      lines.push('', summary.login.result === 'accepted' ? 'Новый вход принят: воркер работает с новой сессией.' :
        'Новый вход отклонён: он в другой аккаунт ChatGPT.');
    }
  }
  return `${lines.join('\n')}\n`;
}
