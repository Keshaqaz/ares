import { emitKeypressEvents } from 'node:readline';
import { FILES } from '../worker/layout.ts';
import { readRules, BrokenState, RULES_FORMAT_VERSION } from '../worker/state-file.ts';
import { CommandFailed, resetName, unfinished, connectGitHub, installedWorker, runnableWorkflow, readSummary, explain, command } from './common.mjs';
import { applyReset } from './apply-now.mjs';
import { saveRules } from './rules.mjs';
import { readOverview, renderOverview, overviewItems, paint, S, WIDTH } from './overview.mjs';
import { t, language, setLanguage } from './language.mjs';

// `aures` without a command: the overview of `status` with a cursor. Enter on a
// reset applies it now after a «y», Enter on a rule switches it; both do what `apply-now` and
// `rules` do. l switches the language between English and Russian and keeps the choice.
// Takes the whole terminal on its alternate screen; q gives the terminal back as it was.
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const hint = () => t('↑↓ select · Enter apply / switch · l language · r refresh · q quit',
  '↑↓ выбор · Enter применить / переключить · l язык · r обновить · q выход');
const TONES = { ok: S.green, warn: S.yellow };
const MARGIN = '  ';
// The same keys on the Russian layout.
const RUSSIAN = { н: 'y', й: 'q', к: 'r', о: 'j', л: 'k', д: 'l' };

// The screen without the terminal: keys in, frames out.
export class Screen {
  constructor({ api, repo, mac, fetch, now, sleep, timeZone }) {
    Object.assign(this, { api, repo, mac, fetch, now, sleep, timeZone });
    this.model = null;
    this.cursor = 0;
    this.confirm = null; // the reset waiting for «y»
    this.busy = null; // what is being done
    this.notes = []; // what the last action said
    this.tick = 0;
    this.changed = () => {};
  }

  // Reads the overview again. The cursor stays on its item; when its reset is gone, on the
  // nearest reset, so that the next Enter never switches a rule by mistake.
  async load() {
    const was = this.model && overviewItems(this.model)[this.cursor];
    this.model = await readOverview(this);
    const items = overviewItems(this.model), resets = items.filter(item => item.kind === 'reset').length;
    const same = items.findIndex(item => item.kind === was?.kind && item.creditId === was.creditId && item.rule === was.rule);
    this.cursor = same >= 0 ? same : was?.kind === 'reset' && resets ? Math.min(this.cursor, resets - 1) :
      Math.min(this.cursor, Math.max(0, items.length - 1));
  }

  // Lines of the frame, painted when color.
  frame(width = WIDTH, color = false) {
    const lines = renderOverview(this.model, { now: this.now, timeZone: this.timeZone, width, cursor: this.cursor, toggle: true });
    lines.push([]);
    for (const note of this.notes) lines.push([[note.text, TONES[note.tone] ?? '']]);
    if (this.notes.length) lines.push([]);
    if (this.busy) lines.push([[`${SPINNER[this.tick % SPINNER.length]} `, S.cyan], [this.busy, '']]);
    else if (this.confirm) {
      lines.push([[t(`Apply ${resetName(this.confirm)} now? A reset is single-use. `, `Применить ${resetName(this.confirm)} сейчас? Сброс одноразовый. `), S.bold],
        [t('y — yes, any other key — cancel', 'y — да, другая клавиша — отмена'), S.dim]]);
    } else lines.push([[hint(), S.dim]]);
    return lines.map(line => paint(line, color));
  }

  // One key; resolves when what it started is done, to 'exit' when the screen closes.
  async press(key) {
    const name = RUSSIAN[key.sequence?.toLowerCase()] ?? key.name;
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
    const items = overviewItems(this.model), item = items[this.cursor];
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
  async act(label, action) {
    this.busy = label;
    this.changed();
    const note = (text, tone) => {
      this.notes.push(...text.split('\n').map(line => ({ text: line, tone })));
      this.changed();
    };
    const tell = error => {
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

  async apply(creditId, note) {
    const { api, repo, now, sleep } = this;
    await runnableWorkflow(api, repo);
    const before = await readSummary(api, repo);
    // The spinner line says what the run waits for; the reset stays named in it.
    const wait = text => { if (text) { this.busy = `${resetName(creditId)}: ${text}`; this.changed(); } };
    const { code, message } = await applyReset({ api, repo, creditId, before, now, sleep, wait });
    note(message, code === 0 ? 'ok' : 'warn');
  }

  // Switches one rule in the rules file as it is now, not as the screen last read it.
  async switchRule(rule, note) {
    const { api, repo, mac, fetch, now, sleep } = this;
    const file = await api.file(repo.full_name, FILES.rules);
    if (!file) throw new CommandFailed(unfinished());
    let current;
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
  async switchLanguage() {
    setLanguage(language() === 'en' ? 'ru' : 'en');
    this.changed();
    await this.mac.files.writeLanguage(language()).catch(() => {});
  }
}

// The screen of an installed worker, read once.
export async function openScreen({ fetch, keychain, io, mac, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeZone }) {
  const { api, login } = await connectGitHub({ fetch, keychain, io, now, sleep });
  const repo = await installedWorker({ api, login });
  const screen = new Screen({ api, repo, mac, fetch, now, sleep, timeZone });
  await screen.load();
  return screen;
}

// Rows of the terminal a painted line takes: a line longer than the terminal wraps.
const rowsOf = (line, columns) => Math.max(1, Math.ceil([...line.replace(/\x1b\[[0-9;]*m/g, '')].length / columns));

// Shows the screen in the terminal until q, on the alternate screen with a margin around it.
// A frame redraws only the lines that changed, each at its own row, and never takes more rows
// than the terminal has: a taller one would scroll it on every turn of the spinner, and the
// user's selection with it. Resolves to the exit code: 130 when Ctrl-C left an action
// unfinished; what it was doing is then printed after the screen.
export function runScreen(screen, { input, output }) {
  let done = false, shown = [], bottom = 1; // the lines on the terminal with their rows, the row under them
  const draw = (full = false) => {
    if (done) return;
    const columns = output.columns || 80, width = Math.min(WIDTH, columns - 1 - MARGIN.length);
    const lines = ['', ...screen.frame(width, true).map(line => MARGIN + line)];
    // The top gives way: the action, its codes and the keys are at the bottom.
    let height = lines.reduce((rows, line) => rows + rowsOf(line, columns), 0);
    while (height > (output.rows || 24) && lines.length > 1) height -= rowsOf(lines.shift(), columns);
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
    const finish = error => {
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
    const onKey = (sequence, key = {}) => {
      screen.press({ ...key, sequence, name: key.name ?? sequence }).then(result => { if (result === 'exit') finish(); }, finish);
    };
    input.on('keypress', onKey);
  });
}

// `aures`: the interactive screen. terminal is { input, output } of a TTY.
export async function screen({ terminal, io, ...options }) {
  return command('', io, async () => runScreen(await openScreen({ io, ...options }), terminal));
}
