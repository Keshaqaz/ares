import { FILES, STATE_KEY_SECRET, LOGIN_SECRET, REVOKE_INPUT, TRIAL_INPUT } from './layout.ts';

// The worker repository's only workflow. The cron is static (ADR-0004): setup picks the
// minute so that installations do not all start together, and upgrade keeps it.

export function workflowYaml({ minute }: { minute: number }): string {
  // Minute 0 is GitHub's busiest moment for schedules.
  if (!Number.isInteger(minute) || minute < 1 || minute > 59) throw new RangeError('minute must be 1..59');
  return `name: codex-auto-resets
on:
  schedule:
    - cron: '${minute} * * * *'
  workflow_dispatch:
    inputs:
      apply_now:
        description: 'Reset ID to apply now; leave empty for a regular check'
        required: false
        default: ''
        type: string
      ${REVOKE_INPUT}:
        description: 'Revoke the worker ChatGPT sign-in instead of a check (used by uninstall)'
        required: false
        default: false
        type: boolean
      ${TRIAL_INPUT}:
        description: 'Show what the rules would apply without applying it (used by setup)'
        required: false
        default: false
        type: boolean
# The worker commits its encrypted state and nothing else.
permissions:
  contents: write
# One run at a time: two runs could refresh the session twice. queue: max keeps every pending
# run (the default replaces it), so a scheduled run never drops a queued apply-now run.
concurrency:
  group: codex-auto-resets
  cancel-in-progress: false
  queue: max
jobs:
  tick:
    runs-on: ubuntu-24.04
    # A run takes seconds; retries of a tick that is worth retrying add two minutes (run.ts).
    timeout-minutes: 8
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Tick
        env:
          STATE_KEY: \${{ secrets.${STATE_KEY_SECRET} }}
          WORKER_LOGIN: \${{ secrets.${LOGIN_SECRET} }}
          APPLY_NOW: \${{ inputs.apply_now }}
          REVOKE_SESSION: \${{ inputs.${REVOKE_INPUT} }}
          TRIAL_RUN: \${{ inputs.${TRIAL_INPUT} }}
        run: node ${FILES.worker}
`;
}

// The minute of the workflow's cron, or null when the file is not ours.
export function workflowMinute(text: string): number | null {
  const minute = Number(text.match(/^\s+- cron: '(\d{1,2}) \* \* \* \*'$/m)?.[1]);
  return Number.isInteger(minute) && minute >= 1 && minute <= 59 ? minute : null;
}
