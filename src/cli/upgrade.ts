import pkg from '../../package.json' with { type: 'json' };
import { FILES } from '../worker/layout.ts';
import { readRules, BrokenState, RULES_MIGRATIONS } from '../worker/state-file.ts';
import { workflowYaml, workflowMinute } from '../worker/workflow.ts';
import { GoogleFailure } from '../google/api.ts';
import { CommandFailed, unfinished, connectGitHub, installedWorker, command } from './common.ts';
import type { CommandOptions, Sleep } from './common.ts';
import { connectGoogle, deployWorker, askAfterDeploy, workerDid, readSecret } from './google.ts';
import type { GoogleWorker } from './watch-files.ts';
import type { Migration, Rules } from '../worker/state-file.ts';
import { t } from './language.ts';
import { reloadAgent } from './mac-check.ts';

const updatedLine = (): string => t(`The worker is updated to ${pkg.version}. The changes take effect from the next run.`,
  `Воркер обновлён до версии ${pkg.version}. Изменения заработают со следующего запуска.`);

// `aures upgrade`, after `brew upgrade`: puts this version's worker into the worker of this
// install, on the platform the install record names (ADR-0007). Nothing changes the code that
// runs with the user's session until the user runs this. A worker left on the other platform
// gets this version when the user switches back to it.
// workerSource is the GitHub worker bundle, appsScriptSource the Apps Script one; rulesMigrations
// are the rules format steps.
export interface UpgradeOptions extends CommandOptions { workerSource: string; appsScriptSource: string; rulesMigrations?: Migration[] }
export async function upgrade(options: UpgradeOptions): Promise<number> {
  const { io, mac: { files }, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = options;
  return command('upgrade', io, async () => {
    const install = await files.readInstall();
    if (install?.platform === 'google') return upgradeGoogle({ ...options, now, sleep }, install.google);
    return upgradeGitHub({ ...options, now, sleep });
  });
}

// On GitHub: the worker and the workflow go into the user's repository and the rules file is
// migrated. The worker migrates its sealed state itself when it reads it. The agent of the
// check from this Mac is reloaded with this version's program.
async function upgradeGitHub({ fetch, keychain, io, open, copy, workerSource, mac, now, sleep, rulesMigrations = RULES_MIGRATIONS }:
  UpgradeOptions & { now: () => number; sleep: Sleep }): Promise<number> {
  const { api, login } = await connectGitHub({ fetch, keychain, io, open, copy, now, sleep });
  const repo = await installedWorker({ api, login });
  const name = repo.full_name;
  const [worker, workflow, rules] = await Promise.all([api.file(name, FILES.worker), api.file(name, FILES.workflow),
    api.file(name, FILES.rules)]);
  if (!worker || !workflow || !rules) {
    throw new CommandFailed(unfinished());
  }
  // The cron is never rewritten: the new workflow runs at the same minute.
  const minute = workflowMinute(workflow.text);
  if (minute === null) {
    throw new CommandFailed(t(`The file ${FILES.workflow} was changed by hand. Delete it in the repository and run \`aures setup\`.`,
      `Файл ${FILES.workflow} изменён вручную. Удалите его в репозитории и запустите \`aures setup\`.`));
  }
  let current: Rules;
  try { current = readRules(rules.text, rulesMigrations); } catch (error) {
    if (!(error instanceof BrokenState)) throw error;
    throw new CommandFailed(error.reason === 'rules_format_unknown' ?
      t('The rules were saved by a newer version. Update the program: `brew upgrade aures`.',
        'Правила сохранены более новой версией. Обновите программу: `brew upgrade aures`.') :
      t('The rules do not read. Choose them again: `aures rules`, then run upgrade again.',
        'Правила не читаются. Выберите их заново: `aures rules`, затем повторите upgrade.'));
  }
  await reloadAgent({ weekly: current.weeklyAutoApply, mac, io });

  // The new worker reads the older rules, so it goes first; the workflow goes last, as in setup.
  const writes: [file: string, text: string, message: string, sha: string][] = [];
  if (worker.text !== workerSource) {
    writes.push([FILES.worker, workerSource, `Upgrade the worker to ${pkg.version}`, worker.sha]);
  }
  // readRules has read it as an object.
  if ((JSON.parse(rules.text) as { formatVersion?: unknown }).formatVersion !== current.formatVersion) {
    writes.push([FILES.rules, `${JSON.stringify(current, null, 2)}\n`,
      `Migrate the general rules to format ${current.formatVersion}`, rules.sha]);
  }
  const yaml = workflowYaml({ minute });
  if (workflow.text !== yaml) writes.push([FILES.workflow, yaml, `Upgrade the worker workflow to ${pkg.version}`, workflow.sha]);
  if (!writes.length) {
    io.print(t(`The worker is already the latest version (${pkg.version}).`, `Воркер уже последней версии (${pkg.version}).`));
    return 0;
  }
  for (const [file, text, message, sha] of writes) await api.putFile(name, file, text, { message, sha });
  io.print(updatedLine());
  return 0;
}

// On Google: the bundle goes into the same project and deployment.
async function upgradeGoogle(options: UpgradeOptions & { now: () => number; sleep: Sleep }, google: GoogleWorker | undefined): Promise<number> {
  await redeployGoogle(options, google);
  options.io.print(updatedLine());
  return 0;
}

// Puts this version of the worker on Google into the same project and deployment, so the web
// app keeps its URL, and the Script Properties with the state, the rules and the journal stay as
// they are: what `upgrade` and «Починить» do. The doPost secret is new, as on every deploy. A
// Google sign-in that ended opens again. The schedule is left as it is.
export type RedeployOptions = Pick<UpgradeOptions, 'fetch' | 'googleKeychain' | 'secretKeychain' | 'io' | 'open' | 'mac' | 'appsScriptSource'> &
  { now: () => number; sleep: Sleep };
export async function redeployGoogle({ fetch, googleKeychain, secretKeychain, io, open, mac, appsScriptSource, now, sleep }: RedeployOptions,
  google: GoogleWorker | undefined): Promise<void> {
  const { deploymentId, url } = google ?? {};
  if (!google || !deploymentId || !url) throw new CommandFailed(unfinished());
  const api = await connectGoogle({ fetch, keychain: googleKeychain, io, open, now, files: mac.files });
  try {
    await deployWorker({ api, secretKeychain, io, open, sleep, workerSource: appsScriptSource, deployment: { scriptId: google.scriptId, deploymentId } });
  } catch (error) {
    if (!(error instanceof GoogleFailure && ['update_content_404', 'update_deployment_404'].includes(error.reason))) throw error;
    throw new CommandFailed(t('The worker project or its deployment is gone from Google. Run `aures setup`: it deploys the worker anew.',
      'Проекта или развёртывания воркера в Google больше нет. Запустите `aures setup`: он развернёт воркер заново.'));
  }
  // The web app of the just-updated deployment can still serve the previous version, answering
  // forbidden to the fresh secret; askAfterDeploy waits that out. The new version answers to the
  // new secret — or says the script was not given every scope at its consent (issue 29), which
  // tells the user to redo the consent instead of a vague success.
  const secret = await readSecret(secretKeychain);
  const reply = secret && await askAfterDeploy({ fetch, url, secret, now, sleep, io, command: 'upgrade' });
  if (!reply) {
    throw new CommandFailed(t('The worker is updated, but the script has to be allowed to run again: run `aures setup`.',
      'Воркер обновлён, но скрипту нужно снова разрешить работать: запустите `aures setup`.'));
  }
  // A reply that is not ok tells its own story: 'scopes' says to redo the consent at `aures setup`.
  workerDid(reply, 'upgrade');
}
