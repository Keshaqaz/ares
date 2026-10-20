// The worker repository that setup creates. Each file has one writer: setup and upgrade
// write the workflow and the worker, the CLI writes rules, the worker writes state and summary.
export const FILES = {
  workflow: '.github/workflows/codex-auto-resets.yml', worker: 'worker.mjs',
  rules: 'rules.json', state: 'state.json.enc', summary: 'summary.json',
} as const;
// The Actions secret with the state key.
export const STATE_KEY_SECRET = 'STATE_KEY';
// The Actions secret through which `login` hands a new worker session to the worker: the CLI
// cannot open the state, and the session must not lie in the repository unsealed.
export const LOGIN_SECRET = 'WORKER_LOGIN';
// The workflow_dispatch input with which `uninstall` has the worker revoke its session.
export const REVOKE_INPUT = 'revoke_session';
// The workflow_dispatch input of a trial run (CONTEXT.md, «Пробный запуск»).
export const TRIAL_INPUT = 'trial_run';
// The before-expiry window on GitHub: wider than the gaps between its scheduled runs (ADR-0004).
export const BEFORE_EXPIRY_MS = 8 * 3600_000;
