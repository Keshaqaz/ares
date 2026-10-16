import { CycleEngine } from './reset-cycles.mjs';
import { renderCycleReport } from './cycle-report.mjs';
import { tokenReminder } from './installer-token.mjs';
const escape = value => String(value ?? '—').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('|', '&#124;').replaceAll('`', '&#96;').replace(/[\x00-\x1f\x7f]/g, ' ');
export async function renderInstallerReport(storage, command, result, now) {
  if (result.revokeValidation) return '## Bounded revoke validation\n\n```json\n' + JSON.stringify(result.revokeValidation, null, 2) + '\n```\n';
  if (result.observer) return '## Check-only observer\n\n```json\n' + JSON.stringify(result.observer, null, 2) + '\n```\n';
  const state = await storage.read(), ru = state.settings.language === 'ru';
  const report = await new CycleEngine(storage, {}, { now }).status();
  const lines = [renderCycleReport(report), `## ${ru ? 'Команда установщика' : 'Installer command'}`, '',
    `| ${ru ? 'Действие' : 'Action'} | ID | ${ru ? 'Этап' : 'Phase'} |`, '| --- | --- | --- |',
    `| ${escape(command.action)} | ${escape(command.commandId)} | ${escape(result.phase ?? state.installation.operation?.phase)} |`, ''];
  if (result.problem) lines.push(`${ru ? 'Операция остановлена' : 'Operation stopped'}: ${escape(result.problem)}`, '');
  if (state.installation?.quota) {
    const q = state.installation.quota;
    lines.push(`### ${ru ? 'Источник квоты' : 'Quota source'}`, '',
      `${ru ? 'План' : 'Plan'}: ${escape(q.policy.plan)}`, '',
      q.verified ? (ru ? 'Сохранённые настройки проверены в отдельной job. При включении расход читается заново.' :
        'Saved settings checked in a separate job. Enable reads usage again.') :
        (ru ? 'Нужна проверка квоты (b) в новой job до включения.' : 'Check quota (b) in a new job before enabling.'), '',
      ru ? 'Бюджет $0 / Stop usage подтверждён пользователем, API его не проверяет.' :
        'The $0 / Stop usage budget was confirmed by the user; the API does not check it.', '');
  }
  const reminder = tokenReminder(state.installation?.grant?.expiresAt, state.settings.language, now());
  if (reminder) lines.push(reminder, '');
  if (command.action === 'timer' && state.installation?.timer?.probeAt) {
    const iso = at => new Date(at * 1000).toISOString();
    lines.push(`### ${ru ? 'Внешний таймер' : 'External timer'}`, '',
      `${ru ? 'Пробный слот' : 'Probe slot'}: ${escape(iso(state.installation.timer.probeAt))}`, '',
      ru ? 'Worker должен отправить пустой dispatch в этот слот; включение доступно после его подтверждения.' :
        'The Worker must send an empty dispatch in this slot; enable is available after it is confirmed.', '');
  }
  if (result.metadata) {
    lines.push(`### ${ru ? 'Выданные сбросы' : 'Issued resets'}`, '',
      `${ru ? 'Состояние списка' : 'List status'}: ${escape(result.metadata.kind)}`, '',
      `| ID | ${ru ? 'Состояние' : 'Status'} | ${ru ? 'Тип' : 'Type'} | ${ru ? 'Срок активации' : 'Activation expiry'} |`, '| --- | --- | --- | --- |');
    for (const c of result.metadata.credits) lines.push(`| ${escape(c.id)} | ${escape(c.status)} | ${escape(c.resetType)} | ${escape(c.expiry.kind === 'at' ? new Date(c.expiry.unixSeconds * 1000).toISOString() : c.expiry.kind)} |`);
    lines.push('');
  }
  if (result.cleanup) lines.push(ru ?
    'Расписание и Secrets удалены. Удалите Worker таймера и приложение таймера в GitHub (Settings → Developer settings → GitHub Apps → Advanced → Delete GitHub App), отзовите токен установки и отдельную CI-сессию ChatGPT. Отправленный RPC мог завершиться; история сохранена.' :
    'Schedule and Secrets removed. Delete the timer Worker and the timer app in GitHub (Settings → Developer settings → GitHub Apps → Advanced → Delete GitHub App); revoke the installation token and separate ChatGPT CI session. A sent RPC may have completed; history is retained.');
  return lines.join('\n') + '\n';
}
