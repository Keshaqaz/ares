import { StateFailure, integer } from '../core/state-failure.mjs';

// Restricted UTC cron dialect and the timer plan. No Node imports: the planner, the GitHub
// writer and the Cloudflare timer (src/worker/index.mjs) parse one plan the same way.
export const MAX_SECONDS = 400 * 86400; // 365 days plus the end of the last supplied billing period.
// The plan lives on the default branch outside .github/workflows: the planner writes it with
// Contents: write, the timer reads it with Contents: read, and no plan edit re-registers a cron.
export const TIMER_PLAN_PATH = '.auto-reset-timer-plan.json';
const START = '  # auto-reset:schedule:start';
const END = '  # auto-reset:schedule:end';
const fail = kind => { throw new StateFailure(kind); };

function cronFields(expression) {
  if (typeof expression !== 'string') fail('invalid_managed_cron');
  const parts = expression.split(' ');
  if (parts.length !== 5 || parts[4] !== '*') fail('invalid_managed_cron');
  return parts.slice(0, 4).map((part, i) => {
    if (part === '*' && i >= 2) return null;
    if (!/^[0-9]+(?:,[0-9]+)*$/.test(part)) fail('invalid_managed_cron');
    const values = part.split(',').map(Number);
    const min = i < 2 ? 0 : 1, max = [59, 23, 31, 12][i];
    if (values.some(v => v < min || v > max) || new Set(values).size !== values.length) fail('invalid_managed_cron');
    return values;
  });
}

// Expand actual yearless expressions, including stale annual matches. Duplicate expressions
// triggering at the same time are separate paid jobs; the desired compiler emits no overlaps.
export function expandCron(expressions, start, end) {
  if (!integer(start) || !integer(end) || end < start || end - start > MAX_SECONDS || expressions.length > 4096) fail('planner_range_exceeded');
  const fields = expressions.map(cronFields), jobs = [];
  for (let day = Math.floor(start / 86400) * 86400; day < end; day += 86400) {
    const d = new Date(day * 1000), month = d.getUTCMonth() + 1, date = d.getUTCDate();
    for (const [minutes, hours, dates, months] of fields) {
      if (dates && !dates.includes(date) || months && !months.includes(month)) continue;
      for (const hour of hours) for (const minute of minutes) {
        const at = day + hour * 3600 + minute * 60;
        if (at >= start && at < end) jobs.push(at);
      }
    }
  }
  return jobs.sort((a, b) => a - b);
}

// One canonical JSON line. Any other serialization of the same expressions is rejected,
// so the timer never interprets a plan the planner could not have written.
export function renderTimerPlan(expressions) {
  expandCron(expressions, 0, 0);
  if (new Set(expressions).size !== expressions.length) fail('invalid_timer_plan');
  return `${JSON.stringify({ schema: 1, expressions })}\n`;
}
export function readTimerPlan(content) {
  try {
    const { expressions } = JSON.parse(content);
    if (renderTimerPlan(expressions) === content) return expressions;
  } catch { /* Fixed kind below. */ }
  fail('invalid_timer_plan');
}

// Workflow region of pins before ticket 37. The template keeps the static fallback cron inside
// it, so an older pin performing the Upgrade can still read back the new workflow.
function region(content) {
  const lines = content.split('\n');
  const starts = lines.flatMap((line, i) => line === START ? [i] : []);
  const ends = lines.flatMap((line, i) => line === END ? [i] : []);
  if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0] ||
    lines.slice(0, starts[0]).filter(line => /^[A-Za-z][^ ]*:/.test(line)).at(-1) !== 'on:' ||
    lines.slice(starts[0] + 1, ends[0]).some(line => /^[A-Za-z][^ ]*:/.test(line)) ||
    lines.some((line, i) => /^  (?:schedule|['"]schedule['"])\s*:/.test(line) &&
      (i < starts[0] || i > ends[0]))) fail('managed_schedule_region_missing');
  return { lines, start: starts[0], end: ends[0] };
}
export function readManagedSchedule(content) {
  const { lines, start, end } = region(content);
  const block = lines.slice(start + 1, end);
  if (!block.length) return [];
  if (block.shift() !== '  schedule:') fail('invalid_managed_schedule');
  const expressions = block.map(line => {
    const match = /^    - cron: '([0-9,* ]+)'$/.exec(line);
    if (!match) fail('invalid_managed_schedule');
    return match[1];
  });
  if (!expressions.length || new Set(expressions).size !== expressions.length) fail('invalid_managed_schedule');
  expandCron(expressions, 0, 0); // Validate our restricted UTC dialect without interpreting arbitrary YAML.
  return expressions;
}
