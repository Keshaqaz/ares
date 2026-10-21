import type { State, Rules, ApplyReason, AttemptResult, LoginVerdict } from './state-file.ts';
import type { RunOutcome, RunResult } from './run.ts';
import type { WouldApply } from './tick.ts';

// What the worker publishes openly for `status`: never the session, the account id or
// the pending redeem_request_id. Every field is copied explicitly, nothing is spread. pending
// names the reset whose application has no known outcome yet, so that a switch of platform
// refuses while it is there (ADR-0007); a summary without the field is from an older worker.
export const SUMMARY_FORMAT_VERSION = 1;
function iso(ms: number): string;
function iso(ms: number | null): string | null;
function iso(ms: number | null): string | null { return ms == null ? null : new Date(ms).toISOString(); }

// Times are ISO strings; expiresAt is null for a reset without a deadline.
export interface Summary {
  formatVersion: number;
  resets: { creditId: string; expiresAt: string | null }[];
  rules: { beforeExpiry: boolean; weeklyAutoApply: boolean };
  lastApplied: { creditId: string; reason: ApplyReason; at: string } | null;
  lastAttempt: { creditId: string; reason: ApplyReason; result: AttemptResult; at: string } | null;
  login: { id: string; result: LoginVerdict['result']; at: string } | null;
  pending?: { creditId: string; reason: ApplyReason; at: string } | null;
}

// summary.json. It has no tick time, so a tick that changes nothing commits nothing;
// the time of every tick is in its run and its Actions Summary.
export function openSummary({ state, rules }: { state: State; rules: Rules }): Summary {
  const applied = state.applied?.at(-1);
  const attempt = state.lastAttempt;
  const pending = state.pending;
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
    pending: pending ? { creditId: pending.creditId, reason: pending.reason, at: iso(pending.at) } : null,
  };
}

const VERDICTS: Record<RunOutcome, string> = {
  idle: 'Nothing to apply.',
  applied: 'Reset applied.',
  pending: 'The result of the application is not known yet; the next run will settle it.',
  would_apply: 'Trial run: the rules would apply a reset.',
  transient_error: 'Temporary error; the next run will check again.',
  reauth_required: 'The worker lost its ChatGPT sign-in. Sign in again: `aures login`.',
  broken_state: 'The worker files do not read. What to do: `aures status`.',
  revoked: 'The worker\'s ChatGPT sign-in is revoked.',
  revoke_failed: 'ChatGPT did not confirm the revocation of the sign-in.',
  commit_failed: 'Could not save the data in the repository. If the next run reports a lost sign-in, sign in again: `aures login`.',
};
const onOff = (value: boolean): string => value ? 'on' : 'off';
const REASONS: Record<ApplyReason, string> = { before_expiry: 'before expiry', weekly: 'the weekly limit ran out', apply_now: 'manually' };
// A trial run says what the rules would do; its other outcomes read as on a regular run.
const verdict = (outcome: RunOutcome, trial: boolean, wouldApply: WouldApply | null): string =>
  wouldApply ? `Trial run: the rules would apply \`${wouldApply.creditId}\` (${REASONS[wouldApply.reason] ?? wouldApply.reason}).` :
    trial && outcome === 'idle' ? 'Trial run: nothing to apply.' : VERDICTS[outcome] ?? outcome;

// Markdown for $GITHUB_STEP_SUMMARY.
export interface StepSummaryFields {
  outcome: RunOutcome; reason?: RunResult['reason'] | null; summary?: Summary | null; now: number;
  trial?: boolean; wouldApply?: WouldApply | null;
}
export function stepSummary({ outcome, reason = null, summary = null, now, trial = false, wouldApply = null }: StepSummaryFields): string {
  const lines = ['### aures', '', `Run: ${iso(now)}`, '', verdict(outcome, trial, wouldApply)];
  if (reason) lines.push('', `Reason: \`${reason}\``);
  if (summary) {
    const { beforeExpiry, weeklyAutoApply } = summary.rules;
    lines.push('', `Rules: before expiry — ${onOff(beforeExpiry)}, when the weekly limit runs out — ${onOff(weeklyAutoApply)}.`);
    lines.push('', `Resets: ${summary.resets.length}`);
    for (const reset of summary.resets) lines.push(`- \`${reset.creditId}\`: ${reset.expiresAt ?? 'no expiry'}`);
    if (summary.lastApplied) lines.push('', `Last applied: \`${summary.lastApplied.creditId}\` ${summary.lastApplied.at}`);
    if (summary.login?.at === iso(now)) {
      lines.push('', summary.login.result === 'accepted' ? 'New sign-in accepted.' : 'New sign-in rejected: this is another ChatGPT account.');
    }
  }
  return `${lines.join('\n')}\n`;
}
