// The last line of a command's output that says what it waits for. In a terminal a spinner
// turns and the time of the wait counts up, so a long wait never looks hung; printed lines go
// above it. Elsewhere each new text is printed once.
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const FRAME_MS = 100;
const CYAN = '\x1b[36m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const elapsed = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

// The terminal the line is drawn in, or another stream.
export interface LiveOutput { isTTY?: boolean; columns?: number; write(text: string): unknown }
export interface LiveLine { print(line: string): void; wait(next: string | null): void }

// { print(line), wait(text) } over output, a stream. wait(null) ends the wait.
export function liveLine(output: LiveOutput, { color = false, now = Date.now }: { color?: boolean; now?: () => number } = {}): LiveLine {
  const live = Boolean(output.isTTY);
  let text: string | null = null, since = 0, tick = 0, timer: NodeJS.Timeout | undefined;
  const paint = (code: string, part: string) => color ? `${code}${part}${RESET}` : part;
  const draw = () => {
    const time = elapsed(now() - since);
    // A wrapped line would not be redrawn in place, so the text gives way to the width.
    const room = Math.max(1, (output.columns || 80) - time.length - 4), chars = [...text ?? ''];
    const shown = chars.length > room ? `${chars.slice(0, room - 1).join('')}…` : text;
    output.write(`\r\x1b[2K${paint(CYAN, SPINNER.charAt(tick++ % SPINNER.length))} ${shown} ${paint(DIM, time)}`);
  };
  const clear = () => output.write('\r\x1b[2K');
  return {
    print(line) {
      if (live && text) clear();
      output.write(`${line}\n`);
      if (live && text) draw();
    },
    wait(next) {
      if (next === text) return;
      if (!live) {
        if (next) output.write(`${next}\n`);
        text = next;
        return;
      }
      if (next && !text) {
        since = now();
        // An unfinished wait must not keep the process alive.
        timer = setInterval(draw, FRAME_MS).unref();
      }
      if (!next) {
        clearInterval(timer);
        clear();
      }
      text = next;
      if (text) draw();
    },
  };
}
