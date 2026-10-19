import test from 'node:test';
import assert from 'node:assert/strict';
import { liveLine } from '../src/cli/live-line.ts';

const stream = (isTTY: boolean, columns = 80) => {
  const writes: string[] = [];
  return { isTTY, columns, writes, write: (text: string) => { writes.push(text); } };
};

test('outside a terminal each new wait text is printed once, among the lines', () => {
  const output = stream(false);
  const { print, wait } = liveLine(output);
  wait('Ждём…');
  print('строка');
  wait('Ждём…');
  wait('Работает…');
  wait(null);
  assert.deepEqual(output.writes, ['Ждём…\n', 'строка\n', 'Работает…\n']);
});

test('in a terminal the wait line keeps its time, gives way to printed lines and goes away', () => {
  const output = stream(true);
  let clock = 0;
  const { print, wait } = liveLine(output, { now: () => clock });
  wait('Ждём…');
  assert.equal(output.writes.at(-1), '\r\x1b[2K⠋ Ждём… 0:00');
  clock = 65_000;
  wait('Работает…');
  assert.equal(output.writes.at(-1), '\r\x1b[2K⠙ Работает… 1:05', 'the time counts the whole wait');
  print('строка');
  assert.deepEqual(output.writes.slice(-3), ['\r\x1b[2K', 'строка\n', '\r\x1b[2K⠹ Работает… 1:05']);
  wait(null);
  assert.equal(output.writes.at(-1), '\r\x1b[2K');
  print('конец');
  assert.equal(output.writes.at(-1), 'конец\n');
});

test('a wait text wider than the terminal is cut to stay on one line', () => {
  const output = stream(true, 20);
  const { wait } = liveLine(output, { now: () => 0 });
  wait('GitHub поставил воркер в очередь');
  wait(null);
  const drawn = (output.writes[0] ?? '').replace('\r\x1b[2K', '');
  assert.equal(drawn, '⠋ GitHub пост… 0:00');
  assert.ok([...drawn].length < 20);
});
