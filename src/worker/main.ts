// Entry point of the bundled worker.mjs, run by the workflow in a checkout of the worker repository.
import { runWorker, runLine } from './run.ts';

const result = await runWorker({
  dir: process.cwd(), key: process.env.STATE_KEY, now: Date.now(), fetch: globalThis.fetch,
  applyNow: process.env.APPLY_NOW || null, login: process.env.WORKER_LOGIN || null,
  revoke: process.env.REVOKE_SESSION === 'true', trial: process.env.TRIAL_RUN === 'true',
  stepSummaryPath: process.env.GITHUB_STEP_SUMMARY || null,
});
console.log(runLine(result));
process.exitCode = result.exitCode;
