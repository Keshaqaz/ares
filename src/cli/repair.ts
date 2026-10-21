// «Починить» on the screen «Воркер» (CONTEXT.md): this version of the worker goes into the
// worker on its platform again and the schedule comes back, unless the worker is on pause. The
// state, the rules, the ChatGPT sign-in and the journal are not touched: on GitHub only the
// worker and the workflow are written, on Google the bundle goes into the same deployment
// (redeployGoogle, as `upgrade` does) and the Script Properties stay.
import pkg from '../../package.json' with { type: 'json' };
import { FILES } from '../worker/layout.ts';
import { workflowYaml, workflowMinute } from '../worker/workflow.ts';
import { CommandFailed, WORKFLOW_FILE, unfinished } from './common.ts';
import type { Sleep } from './common.ts';
import { redeployGoogle } from './upgrade.ts';
import type { RedeployOptions } from './upgrade.ts';
import type { Worker, GitHubWorker } from './active-worker.ts';
import { t } from './language.ts';

// The bundles are null when this install has no build of them.
export interface RepairOptions extends Omit<RedeployOptions, 'appsScriptSource'> {
  worker: Worker;
  workerSource: string | null;
  appsScriptSource: string | null;
  // The worker opened again: on Google it answers to the new secret of the deploy.
  reopen: () => Promise<Worker>;
  random?: () => number;
  sleep: Sleep;
}

// Resolves to the worker to go on with and what to tell the user.
export async function repairWorker(options: RepairOptions): Promise<{ worker: Worker; message: string }> {
  const { worker, mac: { files } } = options;
  const install = await files.readInstall();
  if (!install) throw new CommandFailed(unfinished());
  const paused = install.paused === true;
  const source = worker.platform === 'github' ? options.workerSource : options.appsScriptSource;
  if (source === null) {
    throw new CommandFailed(t('There is no worker build in this program. Reinstall it: `brew reinstall aures`.',
      'В этой программе нет сборки воркера. Переустановите её: `brew reinstall aures`.'));
  }
  let repaired: Worker = worker;
  if (worker.platform === 'github') await repairGitHub(worker, source, paused, options.random ?? Math.random);
  else {
    await redeployGoogle({ ...options, appsScriptSource: source }, install.google);
    repaired = await options.reopen();
    if (repaired.platform === 'google' && !paused) await repaired.ask('schedule', { on: true });
  }
  return { worker: repaired, message: paused ?
    t(`The worker is repaired: version ${pkg.version} is in. The worker is paused, its schedule stays off.`,
      `Воркер починен: залита версия ${pkg.version}. Воркер на паузе, расписание осталось снятым.`) :
    t(`The worker is repaired: version ${pkg.version} is in, its schedule is back.`,
      `Воркер починен: залита версия ${pkg.version}, расписание вернулось.`) };
}

// The worker and the workflow of this version, each written only when it differs; the cron
// keeps its minute while the workflow has one. The workflow goes last, as in setup.
async function repairGitHub({ api, repo }: GitHubWorker, workerSource: string, paused: boolean, random: () => number): Promise<void> {
  const name = repo.full_name;
  const [worker, workflow] = await Promise.all([api.file(name, FILES.worker), api.file(name, FILES.workflow)]);
  if (worker?.text !== workerSource) {
    await api.putFile(name, FILES.worker, workerSource, { message: `Repair the worker (${pkg.version})`, sha: worker?.sha });
  }
  const minute = (workflow && workflowMinute(workflow.text)) ?? 1 + Math.floor(random() * 59);
  const yaml = workflowYaml({ minute });
  if (workflow?.text !== yaml) {
    await api.putFile(name, FILES.workflow, yaml, { message: `Repair the worker workflow (${pkg.version})`, sha: workflow?.sha });
  }
  if (!paused) await api.setWorkflow(name, WORKFLOW_FILE, true);
}
