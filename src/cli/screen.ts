import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import type { GitHubApi, Repository } from '../github/api.ts';
import type { Fetch } from '../chatgpt/http.ts';
import type { Rules } from '../worker/state-file.ts';
import { FILES } from '../worker/layout.ts';
import { readRules, BrokenState, RULES_FORMAT_VERSION } from '../worker/state-file.ts';
import { CommandFailed, resetName, unfinished, connectGitHub, installedWorker, runnableWorkflow, readSummary, explain, command } from './common.ts';
import { applyReset } from './apply-now.ts';
import { saveRules } from './rules.ts';
import type { CommandOptions, Printer, Rule, Sleep } from './common.ts';
import { readOverview, renderOverview, overviewItems, sameItem, paint, S, WIDTH } from './overview.ts';
import type { Overview, Tone as OverviewTone } from './overview.ts';
import type { Mac } from './mac-check.ts';
import { t, language, setLanguage } from './language.ts';

// `aures` without a command: the overview of `status` with a cursor. Enter on a
// reset applies it now after a «y», Enter on a rule switches it; both do what `apply-now` and
// `rules` do. l switches the language between English and Russian and keeps the choice.
// Takes the whole terminal on its alternate screen; q gives the terminal back as it was.
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const hint = (): string => t('↑↓ select · Enter apply / switch · l language · r refresh · q quit',
  '↑↓ выбор · Enter применить / переключить · l язык · r обновить · q выход');
type Tone = Exclude<OverviewTone, 'bad'>;
const TONES: Record<Tone, string> = { ok: S.green, warn: S.yellow };
const MARGIN = '  ';
// The same keys on the Russian layout.
const RUSSIAN: Record<string, string> = { н: 'y', й: 'q', к: 'r', о: 'j', л: 'k', д: 'l' };

// What an action says: a line of a note, or of its message, in its tone.
export type Note = (text: string, tone?: Tone) => void;
export interface ScreenOptions {
  api: GitHubApi;
  repo: Repository;
  mac: Mac;
  fetch: Fetch;
  now: () => number;
  sleep: Sleep;
  timeZone: string | undefined;
}

// The screen without the terminal: keys in, frames out.
export class Screen {
  api: GitHubApi;
  repo: Repository;
  mac: Mac;
  fetch: Fetch;
  now: () => number;
  sleep: Sleep;
  timeZone: string | undefined;
  model: Overview | null = null;
  cursor = 0;
  confirm: string | null = null; // the reset waiting for «y»
  busy: string | null = null; // what is being done
  notes: { text: string; tone: Tone | undefined }[] = []; // what the last action said
  tick = 0;
  changed: () => void = () => {};
  constructor({ api, repo, mac, fetch, now, sleep, timeZone }: ScreenOptions) {
    this.api = api;
    this.repo = repo;
    this.mac = mac;
    this.fetch = fetch;
    this.now = now;
    this.sleep = sleep;
    this.timeZone = timeZone;
  }

  // Reads the overview again. The cursor stays on its item; when its reset is gone, on the
  // nearest reset, so that the next Enter never switches a rule by mistake.
  async load(): Promise<void> {
    const was = this.model ? overviewItems(this.model)[this.cursor] : undefined;
    this.model = await readOverview(this);
    const items = overviewItems(this.model), resets = items.filter(item => item.kind === 'reset').length;
    const same = items.findIndex(item => sameItem(item, was));
    this.cursor = same >= 0 ? same : was?.kind === 'reset' && resets ? Math.min(this.cursor, resets - 1) :
      Math.min(this.cursor, Math.max(0, items.length - 1));
  }

  // Lines of the frame, painted when color.
  frame(width = WIDTH, color = false): string[] {
    if (!this.model) return [];
    const lines = renderOverview(this.model, { now: this.now, timeZone: this.timeZone, width, cursor: this.cursor, toggle: true });
    lines.push([]);
    for (const note of this.notes) lines.push([[note.text, note.tone ? TONES[note.tone] : '']]);
    if (this.notes.length) lines.push([]);
    if (this.busy) lines.push([[`${SPINNER.charAt(this.tick % SPINNER.length)} `, S.cyan], [this.busy, '']]);
    else if (this.confirm) {
      lines.push([[t(`Apply ${resetName(this.confirm)} now? A reset is single-use. `, `Применить ${resetName(this.confirm)} сейчас? Сброс одноразовый. `), S.bold],
        [t('y — yes, any other key — cancel', 'y — да, другая клавиша — отмена'), S.dim]]);
    } else lines.push([[hint(), S.dim]]);
    return lines.map(line => paint(line, color));
  }

  // One key; resolves when what it started is done, to 'exit' when the screen closes.
  async press(key: Key): Promise<'exit' | undefined> {
    const sequence = key.sequence?.toLowerCase();
    const name = (sequence === undefined ? undefined : RUSSIAN[sequence]) ?? key.name;
    if (key.ctrl && name === 'c') return 'exit';
    if (this.busy) return;
    if (this.confirm) {
      const creditId = this.confirm;
      this.confirm = null;
      if (name === 'y') {
        return this.act(t(`Applying ${resetName(creditId)}… The worker starts on GitHub, this takes a couple of minutes.`,
          `Применяем ${resetName(creditId)}… Воркер запускается на GitHub, это займёт пару минут.`), note => this.apply(creditId, note));
      }
      this.changed();
      return;
    }
    this.notes = [];
    const items = this.model ? overviewItems(this.model) : [], item = items[this.cursor];
    if (name === 'q' || name === 'escape') return 'exit';
    if (name === 'r') return this.act(t('Refreshing…', 'Обновляем…'), async () => {});
    if (name === 'l') return this.switchLanguage();
    if ((name === 'up' || name === 'k') && items.length) this.cursor = (this.cursor + items.length - 1) % items.length;
    else if ((name === 'down' || name === 'j') && items.length) this.cursor = (this.cursor + 1) % items.length;
    else if ((name === 'return' || name === 'space') && item?.kind === 'reset') this.confirm = item.creditId;
    else if ((name === 'return' || name === 'space') && item?.kind === 'rule') {
      return this.act(t('Saving the rules…', 'Сохраняем правила…'), note => this.switchRule(item.rule, note));
    }
    this.changed();
  }

  // Runs an action, shows what it says and reads the overview again.
  async act(label: string, action: (note: Note) => Promise<void>): Promise<undefined> {
    this.busy = label;
    this.changed();
    const note: Note = (text, tone) => {
      this.notes.push(...text.split('\n').map(line => ({ text: line, tone })));
      this.changed();
    };
    const tell = (error: unknown) => {
      const message = explain(error);
      if (message === null) throw error;
      note(message, 'warn');
    };
    try {
      try { await action(note); } catch (error) { tell(error); }
      try { await this.load(); } catch (error) { tell(error); }
    } finally {
      this.busy = null;
      this.changed();
    }
  }

  async apply(creditId: string, note: Note): Promise<void> {
    const { api, repo, now, sleep } = this;
    await runnableWorkflow(api, repo);
    const before = await readSummary(api, repo);
    // The spinner line says what the run waits for; the reset stays named in it.
    const wait = (text: string | null) => { if (text) { this.busy = `${resetName(creditId)}: ${text}`; this.changed(); } };
    const { code, message } = await applyReset({ api, repo, creditId, before, now, sleep, wait });
    note(message, code === 0 ? 'ok' : 'warn');
  }

  // Switches one rule in the rules file as it is now, not as the screen last read it.
  async switchRule(rule: Rule, note: Note): Promise<void> {
    const { api, repo, mac, fetch, now, sleep } = this;
    const file = await api.file(repo.full_name, FILES.rules);
    if (!file) throw new CommandFailed(unfinished());
    let current: Rules;
    try { current = readRules(file.text); } catch (error) {
      if (!(error instanceof BrokenState)) throw error;
      throw new CommandFailed(t(`The rules do not read (${error.reason}). Choose them again: \`aures rules\`.`,
        `Правила не читаются (${error.reason}). Выберите их заново: \`aures rules\`.`));
    }
    const chosen = { formatVersion: RULES_FORMAT_VERSION, beforeExpiry: current.beforeExpiry, weeklyAutoApply: current.weeklyAutoApply,
      [rule]: !current[rule] };
    await saveRules({ api, repo, sha: file.sha, current, chosen, mac, fetch, io: { print: line => note(line) }, now, sleep });
  }

  // The other language at once; it is kept for the next start, if this Mac lets it be written.
  async switchLanguage(): Promise<undefined> {
    setLanguage(language() === 'en' ? 'ru' : 'en');
    this.changed();
    await this.mac.files.writeLanguage(language()).catch(() => {});
  }
}

// The screen of an installed worker, read once.
export type ScreenCommandOptions = Omit<CommandOptions, 'io'> & { io: Printer };
export async function openScreen({ fetch, keychain, io, mac, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeZone }: ScreenCommandOptions): Promise<Screen> {
  const { api, login } = await connectGitHub({ fetch, keychain, io, now, sleep });
  const repo = await installedWorker({ api, login });
  const screen = new Screen({ api, repo, mac, fetch, now, sleep, timeZone });
  await screen.load();
  return screen;
}

// Rows of the terminal a painted line takes: a line longer than the terminal wraps.
const rowsOf = (line: string, columns: number): number => Math.max(1, Math.ceil([...line.replace(/\x1b\[[0-9;]*m/g, '')].length / columns));

// Shows the screen in the terminal until q, on the alternate screen with a margin around it.
// A frame redraws only the lines that changed, each at its own row, and never takes more rows
// than the terminal has: a taller one would scroll it on every turn of the spinner, and the
// user's selection with it. Resolves to the exit code: 130 when Ctrl-C left an action
// unfinished; what it was doing is then printed after the screen.
export interface Terminal {
  input: NodeJS.ReadableStream & { isRaw?: boolean; setRawMode?(mode: boolean): unknown };
  output: { columns?: number; rows?: number; write(text: string): unknown;
    on?(event: 'resize', listener: () => void): unknown; off?(event: 'resize', listener: () => void): unknown };
}
type Shown = { line: string; row: number; rows: number };
export function runScreen(screen: Screen, { input, output }: Terminal): Promise<number> {
  let done = false, shown: Shown[] = [], bottom = 1; // the lines on the terminal with their rows, the row under them
  const draw = (full = false) => {
    if (done) return;
    const columns = output.columns || 80, width = Math.min(WIDTH, columns - 1 - MARGIN.length);
    const lines = ['', ...screen.frame(width, true).map(line => MARGIN + line)];
    // The top gives way: the action, its codes and the keys are at the bottom.
    let height = lines.reduce((rows, line) => rows + rowsOf(line, columns), 0);
    while (height > (output.rows || 24) && lines.length > 1) height -= rowsOf(lines.shift() ?? '', columns);
    let row = 1, text = full ? '\x1b[2J' : '';
    const next = lines.map(line => {
      const at = { line, row, rows: rowsOf(line, columns) };
      row += at.rows;
      return at;
    });
    next.forEach((at, i) => {
      if (!full && shown[i]?.line === at.line && shown[i].row === at.row) return;
      for (let r = at.row; r < at.row + at.rows; r++) text += `\x1b[${r};1H\x1b[2K`;
      text += `\x1b[${at.row};1H${at.line}`;
    });
    if (!full && row < bottom) text += `\x1b[${row};1H\x1b[J`;
    shown = next;
    bottom = row;
    if (text) output.write(`\x1b[?2026h${text}\x1b[?2026l`);
  };
  const redraw = () => draw(true);
  // The spinner turns while an action runs; the clock and the time left move every half minute.
  let ticks = 0;
  const spin = setInterval(() => {
    ticks++;
    if (screen.busy) screen.tick++;
    if (screen.busy || ticks % 300 === 0) draw();
  }, 100);
  emitKeypressEvents(input);
  const raw = input.isRaw;
  input.setRawMode?.(true);
  input.resume();
  output.write('\x1b[?1049h\x1b[?25l');
  output.on?.('resize', redraw);
  screen.changed = () => draw();
  draw();
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      if (done) return;
      const unfinished = screen.busy;
      done = true;
      clearInterval(spin);
      input.off('keypress', onKey);
      output.off?.('resize', redraw);
      input.setRawMode?.(raw ?? false);
      input.pause();
      output.write('\x1b[?25h\x1b[?1049l');
      if (unfinished) output.write(`${t('Interrupted', 'Прервано')}: ${unfinished}\n`);
      if (error) reject(error);
      else resolve(unfinished ? 130 : 0);
    };
    const onKey = (sequence: string | undefined, key: Key = {}) => {
      screen.press({ ...key, sequence, name: key.name ?? sequence }).then(result => { if (result === 'exit') finish(); }, finish);
    };
    input.on('keypress', onKey);
  });
}

// `aures`: the interactive screen. terminal is { input, output } of a TTY.
export async function screen({ terminal, io, ...options }: ScreenCommandOptions & { terminal: Terminal }): Promise<number> {
  return command('', io, async () => runScreen(await openScreen({ io, ...options }), terminal));
}
