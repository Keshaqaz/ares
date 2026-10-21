// The screen «Воркер» (CONTEXT.md; Tab from the overview of the resets): the platform and its
// state, the accounts with «войти заново», the actions and the live journal. The page keeps what
// it read and is worded when drawn, as the overview, so the language changes on the spot.
import type { Platform, Accounts } from './watch-files.ts';
import { readJournal } from './journal.ts';
import type { Journal, JournalEntry, JournalKind } from './journal.ts';
import { projectUrl } from './active-worker.ts';
import type { Worker } from './active-worker.ts';
import type { Mac } from './mac-check.ts';
import { resetName, reasonText } from './common.ts';
import { shortTime, S, WIDTH } from './overview.ts';
import type { Segment, Tone } from './overview.ts';
import { t } from './language.ts';

// While the screen is open the worker is polled this often: Google answers in a second, GitHub
// counts every listing against its API limit.
export const POLL_MS: Record<Platform, number> = { google: 30_000, github: 60_000 };
// The journal shows this many lines under its live line.
const JOURNAL_LINES = 12;
const TONES: Record<Tone, string> = { ok: S.green, warn: S.yellow, bad: S.red };

// A step of the CLI on this screen, which the journal shows among the runs.
export interface Step { at: number; text: string; tone: Tone }
// What the screen read: the record of this Mac and the journal of the worker, or why the last
// poll did not get it.
export interface WorkerPage {
  platform: Platform;
  link: string;
  paused: boolean;
  // The GitHub login; on Google, the email of the Google account if a sign-in gave it.
  account: string | null;
  accounts: Accounts;
  journal: Journal | null;
  polledAt: number;
  failed: string | null;
}

export async function readWorkerPage({ worker, mac, now }: { worker: Worker; mac: Mac; now: () => number }): Promise<WorkerPage> {
  const install = await mac.files.readInstall();
  const accounts = install?.accounts ?? {};
  const page = { platform: worker.platform, paused: install?.paused === true, accounts,
    link: worker.platform === 'github' ? worker.repo.html_url : projectUrl(worker.scriptId),
    account: worker.platform === 'github' ? worker.repo.owner.login : accounts.google ?? null };
  return { ...page, journal: await readJournal(worker, { now }), polledAt: now(), failed: null };
}

// The cursor stands on the accounts, then on the actions; it opens on «Проверить сейчас».
export type WorkerItem = 'platformAccount' | 'chatgpt' | 'trial' | 'repair' | 'pause';
export const WORKER_ITEMS: WorkerItem[] = ['platformAccount', 'chatgpt', 'trial', 'repair', 'pause'];
export const FIRST_ACTION = WORKER_ITEMS.indexOf('trial');

export const platformName = (platform: Platform): string => platform === 'github' ? 'GitHub Actions' : 'Google Apps Script';
export const itemLabel = (item: WorkerItem, platform: Platform, paused: boolean): string => ({
  platformAccount: platform === 'github' ? 'GitHub' : 'Google',
  chatgpt: 'ChatGPT',
  trial: t('Check now', 'Проверить сейчас'),
  repair: t('Repair', 'Починить'),
  // The one of the two pause actions that applies to the state the page read.
  pause: paused ? t('Unpause', 'Снять с паузы') : t('Pause', 'Пауза'),
})[item];
export const repairCaption = (): string => t('Deploy the current version of the worker again and bring its schedule back on this platform. ' +
  'The resets, the rules, the ChatGPT sign-in and the journal are not touched. Helps when the worker stopped running or its files were ' +
  'changed by hand',
'Заново залить текущую версию воркера и вернуть расписание на этой площадке. Сбросы, правила, вход в ChatGPT и журнал не трогаются. ' +
  'Поможет, если воркер перестал запускаться или его файлы меняли вручную');

const KINDS = (): Record<JournalKind, string> => ({
  scheduled: t('scheduled', 'по расписанию'), mac: t('from the Mac', 'с Mac'), trial: t('trial', 'пробный'),
  apply_now: t('apply now', 'применить сейчас'), login: t('sign-in', 'вход'),
});
function outcomeText({ outcome, reason, wouldApply }: JournalEntry): string {
  if (outcome === 'would_apply') {
    return wouldApply ? t(`would apply ${resetName(wouldApply.creditId)} (${reasonText(wouldApply.reason)})`,
      `применили бы ${resetName(wouldApply.creditId)} (${reasonText(wouldApply.reason)})`) : t('would apply a reset', 'применили бы сброс');
  }
  return ({
    idle: t('nothing to apply', 'применять нечего'),
    applied: t('reset applied', 'сброс применён'),
    pending: t('the outcome of the application is not known yet', 'исход применения ещё неизвестен'),
    transient_error: t('temporary error', 'временная ошибка'),
    reauth_required: t('lost the ChatGPT sign-in', 'потерян вход в ChatGPT'),
    broken_state: t(`the data does not read (${reason})`, `данные не читаются (${reason})`),
    commit_failed: t('could not save the data', 'не удалось сохранить данные'),
    revoked: t('sign-in revoked', 'вход отозван'),
    revoke_failed: t('the revocation is not confirmed', 'отзыв входа не подтверждён'),
  } as Record<string, string>)[outcome ?? ''] ?? (outcome === null ? t('running…', 'идёт…') : outcome);
}
const BAD: JournalEntry['outcome'][] = ['reauth_required', 'broken_state', 'commit_failed'];

// «2,1 с» / «2.1 s».
const seconds = (ms: number): string =>
  `${new Intl.NumberFormat(t('en-GB', 'ru-RU'), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(ms / 1000)} ${t('s', 'с')}`;
// «12:04:31» in the user's time zone.
const clock = (ms: number, timeZone?: string): string => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit',
  second: '2-digit', hourCycle: 'h23', timeZone }).format(ms);

// The worker session is lost when the latest run that got an answer from ChatGPT says so.
const sessionLost = (entries: JournalEntry[]): boolean =>
  entries.findLast(entry => entry.outcome !== null && entry.outcome !== 'transient_error')?.outcome === 'reauth_required';

// Words of a line up to width each, for the caption.
const wrap = (text: string, width: number): string[] => text.split(' ').reduce<string[]>((lines, word) => {
  const last = lines.at(-1);
  if (last !== undefined && [...`${last} ${word}`].length <= width) lines[lines.length - 1] = `${last} ${word}`;
  else lines.push(word);
  return lines;
}, []);
const len = (text: string): number => [...text].length;
const spread = (left: Segment[], right: Segment[], width: number): Segment[] => {
  const used = [...left, ...right].reduce((n, [text]) => n + len(text), 0);
  return [...left, [' '.repeat(Math.max(3, width - used)), ''], ...right];
};

// header is the top line, the same as on the overview.
export interface WorkerRenderOptions { timeZone?: string; width?: number; cursor: number; steps: Step[]; header: Segment[] }
export function renderWorker(page: WorkerPage, { timeZone, width = WIDTH, cursor, steps, header }: WorkerRenderOptions): Segment[][] {
  const lines: Segment[][] = [header, []];
  const heading = (text: string) => lines.push([[text, S.bold]], [['─'.repeat(width), S.dim]]);
  const selected = (item: WorkerItem) => WORKER_ITEMS[cursor] === item;
  const pointer = (item: WorkerItem): Segment => [selected(item) ? '▸ ' : '  ', S.cyan];

  heading(t('WORKER', 'ВОРКЕР'));
  lines.push([['● ', page.paused ? S.yellow : S.green], [`${platformName(page.platform)} · `, ''],
    [page.paused ? t('paused', 'на паузе') : t('active', 'активен'), page.paused ? S.yellow : '']]);
  lines.push([[`  ${page.link}`, S.dim]]);

  lines.push([]);
  heading(t('ACCOUNTS', 'АККАУНТЫ'));
  const entries = page.journal?.entries ?? [];
  const unknown = t('account unknown', 'аккаунт неизвестен');
  const lost = sessionLost(entries);
  const accounts: [WorkerItem, Segment[]][] = [
    ['platformAccount', [[page.account ?? unknown, page.account ? '' : S.dim]]],
    ['chatgpt', [[page.accounts.chatgpt ?? unknown, page.accounts.chatgpt ? '' : S.dim], [' · ', S.dim],
      lost ? [t('sign-in lost', 'вход потерян'), S.yellow] : [t('signed in', 'вход работает'), '']]],
  ];
  const labelWidth = Math.max(...accounts.map(([item]) => len(itemLabel(item, page.platform, page.paused)))) + 3;
  for (const [item, value] of accounts) {
    lines.push(spread([pointer(item), [itemLabel(item, page.platform, page.paused).padEnd(labelWidth), selected(item) ? S.cyan : ''], ...value],
      [[t('sign in again', 'войти заново'), selected(item) ? S.cyan : S.dim]], width));
  }

  lines.push([]);
  heading(t('ACTIONS', 'ДЕЙСТВИЯ'));
  for (const item of ['trial', 'repair', 'pause'] as const) {
    const mark: Segment[] = item === 'trial' && page.platform === 'github' ? [[t(' · ~1 min of Actions', ' · ~1 мин Actions'), S.dim]] : [];
    lines.push([pointer(item), [itemLabel(item, page.platform, page.paused), selected(item) ? S.cyan : ''], ...mark]);
    if (item === 'repair' && selected(item)) for (const line of wrap(repairCaption(), width - 4)) lines.push([[`    ${line}`, S.dim]]);
  }

  lines.push([]);
  heading(t('JOURNAL', 'ЖУРНАЛ'));
  const polled = clock(page.polledAt, timeZone);
  if (page.failed) lines.push([[`  ${t(`polled ${polled}, no answer: ${page.failed}`, `опрошен ${polled}, не ответил: ${page.failed}`)}`, S.yellow]]);
  else if (page.journal) {
    const answered = seconds(page.journal.responseMs);
    lines.push([[`  ${t(`polled ${polled}, answered in ${answered}`, `опрошен ${polled}, ответил за ${answered}`)}`, S.dim]]);
  }
  // Oldest first, a step after the run it follows at the same time; shown newest first.
  const kinds = KINDS();
  const rows = [
    ...entries.map(entry => ({ at: Date.parse(entry.at), line: [[`${kinds[entry.kind] ?? entry.kind} · ${outcomeText(entry)}`,
      BAD.includes(entry.outcome) ? TONES.bad : ''], [` · ${seconds(entry.durationMs)}`, S.dim]] as Segment[] })),
    ...steps.map(step => ({ at: step.at, line: [[`aures · ${step.text}`, step.tone === 'ok' ? '' : TONES[step.tone]]] as Segment[] })),
  ].map((row, i) => ({ ...row, i })).sort((a, b) => a.at - b.at || a.i - b.i).reverse().slice(0, JOURNAL_LINES);
  if (!rows.length && page.journal) lines.push([[t('  no runs yet', '  запусков ещё нет'), S.dim]]);
  for (const { at, line } of rows) lines.push([[`  ${Number.isNaN(at) ? '' : shortTime(at, timeZone)}  `, S.dim], ...line]);
  return lines;
}
