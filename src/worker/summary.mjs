// What the worker publishes openly for `status`: never the session, the account id or
// the pending redeem_request_id. Every field is copied explicitly, nothing is spread.
export const SUMMARY_FORMAT_VERSION = 1;
const iso = ms => ms == null ? null : new Date(ms).toISOString();

// summary.json. It has no tick time, so a tick that changes nothing commits nothing;
// the time of every tick is in its run and its Actions Summary.
export function openSummary({ state, rules }) {
  const applied = state.applied?.at(-1);
  const attempt = state.lastAttempt;
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
  };
}

const VERDICTS = {
  idle: 'Nothing to apply.',
  applied: 'Reset applied.',
  pending: 'The result of the application is not known yet; the next run will settle it.',
  transient_error: 'Temporary error; the next run will check again.',
  reauth_required: 'The worker lost its ChatGPT sign-in. Sign in again: `codex-auto-resets login`.',
  broken_state: 'The worker files do not read. What to do: `codex-auto-resets status`.',
  revoked: 'The worker\'s ChatGPT sign-in is revoked.',
  revoke_failed: 'ChatGPT did not confirm the revocation of the sign-in.',
  commit_failed: 'Could not save the data in the repository. If the next run reports a lost sign-in, sign in again: `codex-auto-resets login`.',
};
const onOff = value => value ? 'on' : 'off';

// Markdown for $GITHUB_STEP_SUMMARY.
export function stepSummary({ outcome, reason = null, summary = null, now }) {
  const lines = ['### codex-auto-resets', '', `Run: ${iso(now)}`, '', VERDICTS[outcome] ?? outcome];
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
