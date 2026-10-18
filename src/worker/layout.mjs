// The worker repository that setup creates. Each file has one writer: setup and upgrade
// write the workflow and the worker, the CLI writes rules, the worker writes state and summary.
export const FILES = {
  workflow: '.github/workflows/codex-auto-resets.yml', worker: 'worker.mjs',
  rules: 'rules.json', state: 'state.json.enc', summary: 'summary.json',
};
// The Actions secret with the state key.
export const STATE_KEY_SECRET = 'STATE_KEY';
