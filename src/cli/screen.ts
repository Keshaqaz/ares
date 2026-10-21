import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import type { Fetch } from '../chatgpt/http.ts';
import { RULES_FORMAT_VERSION } from '../worker/state-file.ts';
import { revokeGoogle } from '../google/api.ts';
import { CommandFailed, resetName, explain, command, connectGitHub } from './common.ts';
import { applyReset, readyToApply } from './apply-now.ts';
import { saveRules, storedRules } from './rules.ts';
import { openWorker } from './active-worker.ts';
import type { Worker, OpenWorkerOptions } from './active-worker.ts';
import type { Io, Rule, Sleep } from './common.ts';
import { readOverview, renderOverview, overviewItems, sameItem, headerLine, paint, S, WIDTH } from './overview.ts';
import type { Overview, Tone as OverviewTone } from './overview.ts';
import { readWorkerPage, renderWorker, itemLabel, POLL_MS, WORKER_ITEMS, FIRST_ACTION } from './worker-screen.ts';
import type { WorkerPage, WorkerItem, Step } from './worker-screen.ts';
import { trialRun } from './setup.ts';
import { trialLine } from './setup-google.ts';
import type { Trial } from './setup-google.ts';
import { repairWorker } from './repair.ts';
import { setWorkerPause } from './pause.ts';
import { signInAgain, renewed } from './login.ts';
import { connectGoogle, readSecret } from './google.ts';
import type { Keychain } from './keychain.ts';
import type { OpenUrl } from './browser.ts';
import type { Mac } from './mac-check.ts';
import { t, language, setLanguage } from './language.ts';

// `aures` without a command: the overview of `status` with a cursor. Enter on a
// reset applies it now after a «y», Enter on a rule switches it; both do what `apply-now` and
// `rules` do. Tab opens the screen «Воркер» and goes back: there Enter signs an account in
// again, checks the worker with a trial run, repairs it, pauses it or takes it off pause, and
// the journal under it is polled while it is shown. l switches the language between English
// and Russian and keeps the choice. Takes the whole terminal on its alternate screen; q gives
// the terminal back as it was.
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const hint = (): string => t('↑↓ select · Enter apply · Tab worker · l language · r refresh · q quit',
  '↑↓ выбор · Enter применить · Tab воркер · l язык · r обновить · q выход');
const workerHint = (): string => t('↑↓ select · Enter run · Tab resets · l language · r refresh · q quit',
  '↑↓ выбор · Enter выполнить · Tab сбросы · l язык · r обновить · q выход');
type Tone = Exclude<OverviewTone, 'bad'>;
const TONES: Record<Tone, string> = { ok: S.green, warn: S.yellow };
const MARGIN = '  ';
// The same keys on the Russian layout.
const RUSSIAN: Record<string, string> = { н: 'y', й: 'q', к: 'r', о: 'j', л: 'k', д: 'l' };

// What an action says: a line of a note, or of its message, in its tone.
export type Note = (text: string, tone?: Tone) => void;
// What the screen «Воркер» needs on top: the sign-ins it renews, the bundles «Починить» deploys
// (null without a build) and reopen, which opens the worker again after a deploy on Google.
export interface ScreenOptions {
  worker: Worker;
  mac: Mac;
  fetch: Fetch;
  now: () => number;
  sleep: Sleep;
  timeZone: string | undefined;
  keychain: Keychain;
  googleKeychain: Keychain;
  secretKeychain: Keychain;
  open: OpenUrl;
  workerSource: string | null;
  appsScriptSource: string | null;
  reopen: () => Promise<Worker>;
}
export type View = 'resets' | 'worker';

// The screen without the terminal: keys in, frames out.
export class Screen {
  worker: Worker;
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
  options: ScreenOptions;
  view: View = 'resets';
  page: WorkerPage | null = null; // the screen «Воркер» as last read
  workerCursor = FIRST_ACTION;
  steps: Step[] = []; // what the CLI did on the screen «Воркер», for its journal
  polling: Promise<void> | null = null; // the poll under way
  poller: ReturnType<typeof setInterval> | null = null;
  constructor(options: ScreenOptions) {
    const { worker, mac, fetch, now, sleep, timeZone } = options;
    this.options = options;
    this.worker = worker;
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

  // Reads the screen «Воркер» again. A poll that gets no answer keeps what the last one read and says why.
  async loadWorker(): Promise<void> {
    try { this.page = await readWorkerPage(this); } catch (error) {
      if (!this.page) throw error;
      this.page = { ...this.page, polledAt: this.now(), failed: explain(error) ?? t('unexpected error', 'неожиданная ошибка') };
    }
  }

  // The worker is polled only while its screen is shown: Tab back to the resets and closing the screen stop it.
  startPolling(): void {
    this.stopPolling();
    this.poller = setInterval(() => {
      if (this.busy || this.polling || this.view !== 'worker') return;
      this.polling = this.loadWorker().catch(error => {
        if (this.page) this.page = { ...this.page, polledAt: this.now(), failed: explain(error) ?? String(error) };
      }).finally(() => {
        this.polling = null;
        this.changed();
      });
    }, POLL_MS[this.worker.platform]);
    this.poller.unref?.();
  }
  stopPolling(): void {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }
  // The screen closes: nothing goes on after it.
  close(): 'exit' {
    this.stopPolling();
    return 'exit';
  }

  // Lines of the frame, painted when color.
  frame(width = WIDTH, color = false): string[] {
    const options = { now: this.now, timeZone: this.timeZone, width, toggle: true };
    let lines;
    if (this.view === 'worker') {
      lines = this.page ? renderWorker(this.page, { ...options, cursor: this.workerCursor, steps: this.steps, header: headerLine(options) }) :
        [headerLine(options)];
    } else if (this.model) lines = renderOverview(this.model, { ...options, cursor: this.cursor });
    else return [];
    lines.push([]);
    for (const note of this.notes) lines.push([[note.text, note.tone ? TONES[note.tone] : '']]);
    if (this.notes.length) lines.push([]);
    if (this.busy) lines.push([[`${SPINNER.charAt(this.tick % SPINNER.length)} `, S.cyan], [this.busy, '']]);
    else if (this.confirm) {
      lines.push([[t(`Apply ${resetName(this.confirm)} now? A reset is single-use. `, `Применить ${resetName(this.confirm)} сейчас? Сброс одноразовый. `), S.bold],
        [t('y — yes, any other key — cancel', 'y — да, другая клавиша — отмена'), S.dim]]);
    } else lines.push([[this.view === 'worker' ? workerHint() : hint(), S.dim]]);
    return lines.map(line => paint(line, color));
  }

  // One key; resolves when what it started is done, to 'exit' when the screen closes.
  async press(key: Key): Promise<'exit' | undefined> {
    const sequence = key.sequence?.toLowerCase();
    const name = (sequence === undefined ? undefined : RUSSIAN[sequence]) ?? key.name;
    if (key.ctrl && name === 'c') return this.close();
    if (this.busy) return;
    if (this.confirm) {
      const creditId = this.confirm;
      this.confirm = null;
      if (name === 'y') {
        const name = resetName(creditId);
        return this.act(this.worker.platform === 'google' ? t(`Applying ${name}…`, `Применяем ${name}…`) :
          t(`Applying ${name}… The worker starts on GitHub, this takes a couple of minutes.`,
            `Применяем ${name}… Воркер запускается на GitHub, это займёт пару минут.`), note => this.apply(creditId, note));
      }
      this.changed();
      return;
    }
    this.notes = [];
    if (name === 'q' || name === 'escape') return this.close();
    if (name === 'r') return this.act(t('Refreshing…', 'Обновляем…'), async () => {});
    if (name === 'l') return this.switchLanguage();
    if (name === 'tab') return this.switchView();
    if (this.view === 'worker') return this.pressOnWorker(name);
    const items = this.model ? overviewItems(this.model) : [], item = items[this.cursor];
    if ((name === 'up' || name === 'k') && items.length) this.cursor = (this.cursor + items.length - 1) % items.length;
    else if ((name === 'down' || name === 'j') && items.length) this.cursor = (this.cursor + 1) % items.length;
    else if ((name === 'return' || name === 'space') && item?.kind === 'reset') this.confirm = item.creditId;
    else if ((name === 'return' || name === 'space') && item?.kind === 'rule') {
      return this.act(t('Saving the rules…', 'Сохраняем правила…'), note => this.switchRule(item.rule, note));
    }
    this.changed();
  }

  // Tab: the screen «Воркер», read anew and polled from now on, or back to the resets, read anew.
  async switchView(): Promise<undefined> {
    if (this.view === 'worker') {
      this.stopPolling();
      this.view = 'resets';
      return this.act(t('Refreshing…', 'Обновляем…'), async () => {});
    }
    this.view = 'worker';
    await this.act(t('Reading the worker journal…', 'Читаем журнал воркера…'), async () => {});
    if (this.view === 'worker') this.startPolling();
  }

  async pressOnWorker(name: string | undefined): Promise<undefined> {
    const count = WORKER_ITEMS.length, item = WORKER_ITEMS[this.workerCursor];
    if (name === 'up' || name === 'k') this.workerCursor = (this.workerCursor + count - 1) % count;
    else if (name === 'down' || name === 'j') this.workerCursor = (this.workerCursor + 1) % count;
    else if ((name === 'return' || name === 'space') && item && this.page) return this.runItem(item);
    this.changed();
  }

  // An action of the screen «Воркер»: its result goes into the journal as a step of the CLI.
  async runItem(item: WorkerItem): Promise<undefined> {
    const paused = this.page?.paused === true;
    const label = itemLabel(item, this.worker.platform, paused);
    const busy = ({
      platformAccount: this.worker.platform === 'github' ? t('Signing in to GitHub…', 'Входим в GitHub…') : t('Signing in to Google…', 'Входим в Google…'),
      chatgpt: t('Signing the worker in to ChatGPT…', 'Входим в ChatGPT для воркера…'),
      trial: this.worker.platform === 'github' ? t('Checking the worker: a trial run on GitHub, about a minute…',
        'Проверяем воркер: пробный запуск на GitHub, около минуты…') : t('Checking the worker…', 'Проверяем воркер…'),
      repair: t('Repairing the worker…', 'Чиним воркер…'),
      pause: paused ? t('Taking the worker off pause…', 'Снимаем воркер с паузы…') : t('Pausing the worker…', 'Ставим воркер на паузу…'),
    } satisfies Record<WorkerItem, string>)[item];
    const action = ({ platformAccount: io => this.signInPlatform(io), chatgpt: io => this.signInChatGPT(io), trial: io => this.trial(io),
      repair: io => this.repair(io), pause: () => this.setPause(!paused) } satisfies Record<WorkerItem, (io: Io) => Promise<string>>)[item];
    return this.act(busy, async note => {
      // The lines of the commands are notes while it runs: device codes, what it waits for.
      const io: Io = { print: line => note(line), prompt: async () => { throw new Error('the screen asks no questions'); },
        wait: text => { this.busy = text ?? busy; this.changed(); } };
      let text: string, tone: Step['tone'] = 'ok';
      try { text = await action(io); } catch (error) {
        const message = explain(error);
        if (message === null) throw error;
        text = message.split('\n').join(' ');
        tone = 'warn';
      }
      this.notes = [];
      this.steps.push({ at: this.now(), text: `${label}: ${text}`, tone });
    });
  }

  // «Проверить сейчас»: the trial run, which reads the resets and applies nothing.
  async trial(io: Io): Promise<string> {
    const { worker, now, sleep, timeZone } = this;
    if (worker.platform === 'google') return trialLine(await worker.ask('trial') as unknown as Trial, timeZone);
    const paused = (await this.mac.files.readInstall())?.paused === true;
    return trialRun({ api: worker.api, repo: worker.repo, io, now, sleep, timeZone, paused });
  }

  // «Починить»; on Google the screen goes on with the worker that answers to the new secret.
  async repair(io: Io): Promise<string> {
    const { fetch, googleKeychain, secretKeychain, open, workerSource, appsScriptSource, reopen } = this.options;
    const { worker, message } = await repairWorker({ worker: this.worker, fetch, googleKeychain, secretKeychain, io, open, mac: this.mac,
      workerSource, appsScriptSource, reopen, now: this.now, sleep: this.sleep });
    this.worker = worker;
    return message;
  }

  // «Пауза» / «Снять с паузы»: the schedule of the open worker goes off or comes back; the
  // sign-in and the data stay, so unpausing needs no new ChatGPT sign-in.
  async setPause(paused: boolean): Promise<string> {
    const { worker, mac } = this;
    return setWorkerPause({ worker, mac, paused });
  }

  // «Войти заново» for ChatGPT: a new worker session, as `aures login`.
  async signInChatGPT(io: Io): Promise<string> {
    const { fetch, now, sleep, timeZone, mac: { files } } = this;
    await signInAgain(this.worker, { fetch, io, files, now, sleep, timeZone });
    return renewed();
  }

  // «Войти заново» for GitHub or Google: a new sign-in of the CLI. On GitHub it must be the
  // account of the worker repository; otherwise the sign-in before it is put back.
  async signInPlatform(io: Io): Promise<string> {
    const { fetch, now, sleep, worker, options: { keychain, googleKeychain, open } } = this;
    if (worker.platform === 'github') {
      const before = await readSecret(keychain);
      const { api, login } = await connectGitHub({ fetch, keychain, io, now, sleep, fresh: true });
      if (login !== worker.repo.owner.login) {
        if (before) await keychain.write(before);
        throw new CommandFailed(t(`This is the GitHub account ${login}, the worker is in ${worker.repo.owner.login}. Sign in to that one.`,
          `Это аккаунт GitHub ${login}, а воркер в ${worker.repo.owner.login}. Войдите в него.`));
      }
      this.worker = { ...worker, api };
      return t(`Signed in to GitHub as ${login}.`, `Вы вошли в GitHub как ${login}.`);
    }
    const before = await readSecret(googleKeychain);
    await connectGoogle({ fetch, keychain: googleKeychain, io, open, now, files: this.mac.files, fresh: true });
    // The grant before it is no longer used: it is ended, as uninstall ends the last one.
    if (before) await revokeGoogle(fetch, before).catch(() => {});
    const email = (await this.mac.files.readInstall())?.accounts?.google;
    return email ? t(`Signed in to Google as ${email}.`, `Вы вошли в Google как ${email}.`) : t('Signed in to Google.', 'Вы вошли в Google.');
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
      try { await (this.view === 'worker' ? this.loadWorker() : this.load()); } catch (error) { tell(error); }
    } finally {
      this.busy = null;
      this.changed();
    }
  }

  async apply(creditId: string, note: Note): Promise<void> {
    const { worker, now, sleep } = this;
    const paused = this.model?.paused === true;
    const before = await readyToApply(worker, paused);
    // The spinner line says what the run waits for; the reset stays named in it.
    const wait = (text: string | null) => { if (text) { this.busy = `${resetName(creditId)}: ${text}`; this.changed(); } };
    const { code, message } = await applyReset({ worker, creditId, before, now, sleep, wait, paused });
    note(message, code === 0 ? 'ok' : 'warn');
  }

  // Switches one rule in the rules as they are now, not as the screen last read them.
  async switchRule(rule: Rule, note: Note): Promise<void> {
    const { worker, mac, fetch, now, sleep } = this;
    const stored = await storedRules(worker), { current, broken } = stored;
    if (!current) {
      throw new CommandFailed(broken ? t(`The rules do not read (${broken}). Choose them again: \`aures rules\`.`,
        `Правила не читаются (${broken}). Выберите их заново: \`aures rules\`.`) :
        t('The rules are not set. Choose them: `aures rules`.', 'Правила не заданы. Выберите их: `aures rules`.'));
    }
    const chosen = { formatVersion: RULES_FORMAT_VERSION, beforeExpiry: current.beforeExpiry, weeklyAutoApply: current.weeklyAutoApply,
      [rule]: !current[rule] };
    await saveRules({ worker, stored, chosen, mac, fetch, io: { print: line => note(line) }, now, sleep });
  }

  // The other language at once; it is kept for the next start, if this Mac lets it be written.
  async switchLanguage(): Promise<undefined> {
    setLanguage(language() === 'en' ? 'ru' : 'en');
    this.changed();
    await this.mac.files.writeLanguage(language()).catch(() => {});
  }
}

// The screen of an installed worker, read once. Before the screen opens the user may be asked
// where the worker runs.
// The bundles are those setup and upgrade deploy, for «Починить»; null or left out without a build.
export type ScreenCommandOptions = OpenWorkerOptions & { workerSource?: string | null; appsScriptSource?: string | null };
export async function openScreen(options: ScreenCommandOptions): Promise<Screen> {
  const { fetch, mac, keychain, googleKeychain, secretKeychain, open, workerSource = null, appsScriptSource = null, now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeZone } = options;
  // Its doPost failures are told on the screen, where the user repeats the action.
  const reopen = () => openWorker(options, null);
  const worker = await reopen();
  const screen = new Screen({ worker, mac, fetch, now, sleep, timeZone, keychain, googleKeychain, secretKeychain, open, workerSource,
    appsScriptSource, reopen });
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
      screen.close();
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
