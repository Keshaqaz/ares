import { FILES } from '../worker/layout.mjs';
import { readRules, BrokenState } from '../worker/state-file.mjs';
import { BEFORE_EXPIRY_MS } from '../worker/tick.mjs';
import { WORKFLOW_FILE, unfinished, ruleLabel, reasonText, attemptResult, enableUrl, byDeadline, readSummary, loggedOutcome,
  failedRunAdvice } from './common.mjs';
import { macCheckStatus, checkAdvice } from './mac-check.mjs';
import { t, language, LANGUAGES } from './language.mjs';

// What `status` prints and the screen shows: the resets on top, the general rules under them,
// one line about the worker and the warnings that need the user. The overview keeps what it
// read and is worded when drawn, so the screen can change the language on the spot.

// The cron runs hourly and GitHub may delay it by an hour or two; the before-expiry rule
// leaves 8 hours, so a longer silence is worth the user's attention.
export const STALE_MS = 4 * 3600_000;
export const WIDTH = 72;
export const RULES = ['beforeExpiry', 'weeklyAutoApply'];

// SGR codes of the segments.
export const S = { bold: '1', dim: '2', green: '32', yellow: '33', red: '31', cyan: '1;36' };
const TONES = { ok: S.green, warn: S.yellow, bad: S.red };
const MONTHS = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  ru: ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
};

// «22 Oct 15:00» in the user's time zone.
export function shortTime(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'numeric', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23', timeZone }).formatToParts(ms).map(part => [part.type, part.value]));
  return `${parts.day} ${MONTHS[language()][parts.month - 1]} ${parts.hour}:${parts.minute}`;
}

// «in 2d 3h» until a moment.
function timeLeft(ms) {
  const minutes = Math.floor(ms / 60_000), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  if (minutes < 60) return t(`in ${Math.max(1, minutes)}m`, `через ${Math.max(1, minutes)} мин`);
  if (hours < 24) return t(`in ${hours}h`, `через ${hours} ч`);
  const rest = hours % 24;
  return t(`in ${days}d${rest ? ` ${rest}h` : ''}`, `через ${days} д${rest ? ` ${rest} ч` : ''}`);
}

const runAt = run => Date.parse(run.run_started_at ?? run.created_at);

// Everything the overview shows, read from the worker repository (what the worker publishes
// openly: it cannot read the sealed state) and from this Mac.
export async function readOverview({ api, repo, mac, now }) {
  const name = repo.full_name;
  const [summary, rulesFile, workflowState, lastRun] = await Promise.all([readSummary(api, repo), api.file(name, FILES.rules),
    api.workflowState(name, WORKFLOW_FILE), api.latestRun(name, WORKFLOW_FILE)]);
  let rules = null;
  try { rules = rulesFile && readRules(rulesFile.text); } catch (error) { if (!(error instanceof BrokenState)) throw error; }
  const check = await macCheckStatus({ weekly: rules?.weeklyAutoApply ?? null, mac });
  const failed = lastRun?.status === 'completed' && lastRun.conclusion !== 'success';
  const logged = failed ? loggedOutcome(await api.runLog(name, lastRun.id).catch(() => null)) : null;
  return { repo, readAt: now(), resets: summary ? byDeadline(summary.resets) : null, rules, rulesBroken: Boolean(rulesFile && !rules),
    check, workflowState, lastRun, logged, lastApplied: summary?.lastApplied ?? null, lastAttempt: summary?.lastAttempt ?? null };
}

// The worker in one line, and what the user should do about it.
function workerState({ repo, workflowState, lastRun, readAt }, timeZone) {
  if (!workflowState) return { tone: 'warn', text: t('setup is not finished', 'установка не завершена'), warning: unfinished() };
  if (workflowState !== 'active') {
    return { tone: 'bad', text: t('worker is disabled in GitHub', 'воркер выключен в GitHub'),
      warning: t(`Resets are not applied. Turn the worker on with the Enable workflow button: ${enableUrl(repo)}`,
        `Сбросы не применяются. Включите воркер кнопкой Enable workflow: ${enableUrl(repo)}`) };
  }
  if (!lastRun) return { tone: 'warn', text: t('worker has not run yet', 'воркер ещё не запускался') };
  if (lastRun.status !== 'completed') return { tone: 'ok', text: t('worker works · running now', 'воркер работает · запуск идёт сейчас') };
  const at = shortTime(runAt(lastRun), timeZone);
  if (lastRun.conclusion !== 'success') return { tone: 'bad', text: t(`last run failed · ${at}`, `последний запуск с ошибкой · ${at}`) };
  const hours = Math.floor((readAt - runAt(lastRun)) / 3600_000);
  if (readAt - runAt(lastRun) > STALE_MS) {
    return { tone: 'warn', text: t(`worker silent for ${hours}h · last run ${at}`, `воркер молчит ${hours} ч · запуск ${at}`),
      warning: t(`The worker has not run for ${hours}h. Check: ${repo.html_url}/actions`,
        `Воркер не запускался уже ${hours} ч. Проверьте: ${repo.html_url}/actions`) };
  }
  return { tone: 'ok', text: t(`worker works · last run ${at}`, `воркер работает · запуск ${at}`) };
}

// The latest application, or a later attempt that did not apply.
function lastEvent({ lastApplied: applied, lastAttempt: attempt }, timeZone) {
  if (attempt && attempt.result !== 'reset' && (!applied || attempt.at > applied.at)) {
    const at = shortTime(Date.parse(attempt.at), timeZone);
    return t(`attempt ${attempt.creditId} ${at} — ${attemptResult(attempt.result)}`, `попытка ${attempt.creditId} ${at} — ${attemptResult(attempt.result)}`);
  }
  if (!applied) return null;
  const at = shortTime(Date.parse(applied.at), timeZone);
  return t(`applied ${applied.creditId} ${at} — ${reasonText(applied.reason)}`, `применён ${applied.creditId} ${at} — ${reasonText(applied.reason)}`);
}

// What the cursor can stand on: the resets, then the rules.
export const overviewItems = model => [...(model.resets ?? []).map(reset => ({ kind: 'reset', creditId: reset.creditId })),
  ...(model.rules ? RULES.map(rule => ({ kind: 'rule', rule })) : [])];

const len = text => [...text].length;
// A line with segments on the left and on the right edge.
const spread = (left, right, width) => {
  const used = [...left, ...right].reduce((n, [text]) => n + len(text), 0);
  return [...left, [' '.repeat(Math.max(2, width - used)), ''], ...right];
};

// Lines of [text, style] segments. cursor is the index in overviewItems, or null without one;
// toggle shows the languages in the header, for the screen.
export function renderOverview(model, { now, timeZone, width = WIDTH, cursor = null, toggle = false }) {
  const lines = [], items = overviewItems(model);
  const at = item => cursor !== null && items[cursor]?.kind === item.kind &&
    (item.kind === 'reset' ? items[cursor].creditId === item.creditId : items[cursor].rule === item.rule);
  const heading = text => lines.push([[text, S.bold]], [['─'.repeat(width), S.dim]]);

  const languages = toggle ? LANGUAGES.flatMap((code, i) => [[i ? ' · ' : '   ', S.dim],
    [code.toUpperCase(), code === language() ? S.cyan : S.dim]]) : [];
  lines.push(spread([['codex-auto-resets', S.bold]], [[shortTime(now(), timeZone), S.dim], ...languages], width), []);
  const resetsTitle = t('RESETS', 'СБРОСЫ');
  heading(model.resets?.length ? `${resetsTitle} · ${model.resets.length}` : resetsTitle);
  if (!model.resets) lines.push([[t('  not read yet — the worker reads them on its next run', '  ещё не прочитаны — воркер прочитает их при следующем запуске'), S.dim]]);
  else if (!model.resets.length) lines.push([[t('  no resets', '  сбросов нет'), S.dim]]);
  const idWidth = Math.max(0, ...(model.resets ?? []).map(reset => len(reset.creditId)));
  for (const reset of model.resets ?? []) {
    const selected = at({ kind: 'reset', creditId: reset.creditId });
    const expiresAt = reset.expiresAt ? Date.parse(reset.expiresAt) : null;
    const status = expiresAt === null ? ['', ''] : expiresAt <= now() ? [t('expired', 'срок вышел'), S.dim] :
      model.rules?.beforeExpiry && expiresAt - now() <= BEFORE_EXPIRY_MS ? [t('applies soon', 'скоро применится'), S.yellow] :
        [timeLeft(expiresAt - now()), S.dim];
    lines.push(spread([[selected ? '▸ ' : '  ', S.cyan], [reset.creditId.padEnd(idWidth + 3), selected ? S.cyan : ''], status],
      [[expiresAt === null ? t('no expiry', 'без срока') : shortTime(expiresAt, timeZone), selected ? S.cyan : S.dim]], width));
  }

  lines.push([]);
  heading(t('RULES', 'ПРАВИЛА'));
  if (model.rulesBroken) lines.push([[t('  do not read', '  не читаются'), S.yellow]]);
  else if (!model.rules) lines.push([[t('  not set', '  не заданы'), S.dim]]);
  for (const rule of model.rules ? RULES : []) {
    const on = model.rules[rule], selected = at({ kind: 'rule', rule });
    const check = rule !== 'weeklyAutoApply' || !on || model.check.state === 'off' ? ['', ''] : model.check.state === 'working' ?
      [t(' · Mac check works', ' · проверка с Mac работает'), S.dim] : [t(' · Mac check is not working', ' · проверка с Mac не работает'), S.yellow];
    lines.push([[selected ? '▸ ' : '  ', S.cyan], [on ? '☑ ' : '☐ ', on ? S.green : S.dim],
      [ruleLabel(rule), selected ? S.cyan : on ? '' : S.dim], check]);
  }

  const worker = workerState(model, timeZone), last = lastEvent(model, timeZone);
  lines.push([], [['● ', TONES[worker.tone]], [worker.text, '']]);
  if (last) lines.push([[`  ${last}`, S.dim]]);
  lines.push([[`  ${model.repo.html_url}`, S.dim]]);
  const warnings = [worker.warning];
  if (model.rulesBroken) warnings.push(t('The rules do not read. Choose them again: `codex-auto-resets rules`.',
    'Правила не читаются. Выберите их заново: `codex-auto-resets rules`.'));
  if (model.lastRun?.status === 'completed' && model.lastRun.conclusion !== 'success') {
    warnings.push(`${failedRunAdvice(model.logged ?? {})} ${t('Details', 'Подробности')}: ${model.lastRun.html_url}`);
  }
  if (model.check.problem) warnings.push(checkAdvice(model.check.problem));
  for (const warning of warnings.filter(Boolean)) lines.push([['! ', S.yellow], [warning, S.yellow]]);
  return lines;
}

export const paint = (segments, color) => segments.map(([text = '', style = '']) =>
  color && style && text ? `\x1b[${style}m${text}\x1b[0m` : text).join('');
