import pkg from '../../package.json' with { type: 'json' };
import { FILES } from '../worker/layout.mjs';
import { readRules, BrokenState, RULES_MIGRATIONS } from '../worker/state-file.mjs';
import { workflowYaml, workflowMinute } from '../worker/workflow.mjs';
import { CommandFailed, connectGitHub, installedWorker, command } from './common.mjs';

// `codex-auto-resets upgrade`, after `brew upgrade`: puts this version's worker and workflow
// into the user's repository and migrates the rules file. The worker migrates its sealed
// state itself when it reads it. Nothing changes the code that runs with the user's
// session until the user runs this. rulesMigrations are the rules format steps.
export async function upgrade({ fetch, keychain, io, workerSource, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), rulesMigrations = RULES_MIGRATIONS }) {
  return command('upgrade', io, async () => {
    const { api, login } = await connectGitHub({ fetch, keychain, io, now, sleep });
    const repo = await installedWorker({ api, login });
    const name = repo.full_name;
    const [worker, workflow, rules] = await Promise.all([api.file(name, FILES.worker), api.file(name, FILES.workflow),
      api.file(name, FILES.rules)]);
    if (!worker || !workflow || !rules) {
      throw new CommandFailed('Установка воркера не завершена. Запустите `codex-auto-resets setup`: он дозаполнит недостающее.');
    }
    // The cron is never rewritten: the new workflow runs at the same minute.
    const minute = workflowMinute(workflow.text);
    if (minute === null) {
      throw new CommandFailed(`В workflow воркера не найдено расписание: файл изменён вручную. Удалите ${FILES.workflow} ` +
        'в репозитории и запустите `codex-auto-resets setup`.');
    }
    let current;
    try { current = readRules(rules.text, rulesMigrations); } catch (error) {
      if (!(error instanceof BrokenState)) throw error;
      throw new CommandFailed(error.reason === 'rules_format_unknown' ?
        `Правила в репозитории новее этой версии codex-auto-resets. Обновите программу: \`brew upgrade codex-auto-resets\`.` :
        `Файл ${FILES.rules} не читается. Выберите правила заново: \`codex-auto-resets rules\`, затем повторите upgrade.`);
    }

    // The new worker reads the older rules, so it goes first; the workflow goes last, as in setup.
    const writes = [];
    if (worker.text !== workerSource) {
      writes.push(['код воркера', FILES.worker, workerSource, `Upgrade the worker to ${pkg.version}`, worker.sha]);
    }
    if (JSON.parse(rules.text).formatVersion !== current.formatVersion) {
      writes.push(['правила', FILES.rules, `${JSON.stringify(current, null, 2)}\n`,
        `Migrate the general rules to format ${current.formatVersion}`, rules.sha]);
    }
    const yaml = workflowYaml({ minute });
    if (workflow.text !== yaml) writes.push(['workflow', FILES.workflow, yaml, `Upgrade the worker workflow to ${pkg.version}`, workflow.sha]);
    if (!writes.length) {
      io.print(`Воркер уже актуален (версия ${pkg.version}).`);
      return 0;
    }
    for (const [, file, text, message, sha] of writes) await api.putFile(name, file, text, { message, sha });
    io.print(`Воркер обновлён до версии ${pkg.version}: ${writes.map(([label]) => label).join(', ')}. ` +
      'Изменения вступят в силу со следующего запуска воркера.');
    return 0;
  });
}
