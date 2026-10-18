import { FILES, STATE_KEY_SECRET } from './layout.mjs';

// The worker repository's only workflow. The cron is static and never rewritten after
// setup (ADR-0004); setup picks the minute so that installations do not all start together.

export function workflowYaml({ minute }) {
  // Minute 0 is GitHub's busiest moment for schedules.
  if (!Number.isInteger(minute) || minute < 1 || minute > 59) throw new RangeError('minute must be 1..59');
  return `name: codex-auto-resets
on:
  schedule:
    - cron: '${minute} * * * *'
  workflow_dispatch:
    inputs:
      apply_now:
        description: 'Issued reset to apply now (creditId); empty for a regular tick'
        required: false
        default: ''
        type: string
# The worker commits its encrypted state and nothing else.
permissions:
  contents: write
# One run at a time: two runs could refresh the session twice. queue: max keeps every pending
# run (the default replaces it), so a scheduled run never drops a queued «Применить сейчас».
concurrency:
  group: codex-auto-resets
  cancel-in-progress: false
  queue: max
jobs:
  tick:
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Tick
        env:
          STATE_KEY: \${{ secrets.${STATE_KEY_SECRET} }}
          APPLY_NOW: \${{ inputs.apply_now }}
        run: node ${FILES.worker}
`;
}
