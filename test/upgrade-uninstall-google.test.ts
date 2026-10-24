import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../src/cli/setup.ts';
import { status } from '../src/cli/status.ts';
import { upgrade } from '../src/cli/upgrade.ts';
import { uninstall } from '../src/cli/uninstall.ts';
import { GITHUB_OAUTH_CLIENT_ID } from '../src/github/oauth-app.ts';
import { cliWorld } from './support/cli-world.ts';
import { bundle } from './support/fake-apps-script.ts';
import type { FakeProject } from './support/fake-google.ts';

const GOOGLE_LOGIN = 'https://accounts.google.com/';
const CONNECTIONS = 'https://myaccount.google.com/connections';
const OAUTH_APP_LINK = `https://github.com/settings/connections/applications/${GITHUB_OAUTH_CLIENT_ID}`;
const link = (project: FakeProject): string => `https://script.google.com/home/projects/${project.scriptId}`;

// A worker installed on Google by setup with the default rules; in env, the platform is already chosen.
async function onGoogle(env?: Awaited<ReturnType<typeof cliWorld>>) {
  const answers = env ? [''] : ['2', ''];
  env ??= await cliWorld();
  const { code, io } = await env.run(setup, { answers });
  assert.equal(code, 0, io.output());
  const project = env.world.google.project();
  assert.ok(project?.gas);
  return { ...env, project, gas: project.gas };
}

test('upgrade on Google puts the new bundle into the same deployment: the URL, the state and the schedule stay', async () => {
  const { world, mac, project, gas, secretKeychain, run } = await onGoogle();
  const install = await mac.files.readInstall();
  const [deploymentId] = [...project.deployments.keys()];
  const properties = new Map(gas.properties);
  const versions = project.versions.length;
  const next = `${await bundle()}\n// next version\n`;
  const githubRequests = world.github.requests.length, opened = world.google.opened.length;

  const { code, io } = await run(upgrade, { appsScriptSource: next });
  assert.equal(code, 0, io.output());
  assert.deepEqual([...project.deployments], [[deploymentId, versions + 1]]);
  assert.equal(project.files.find(file => file.name === 'worker')?.source, next);
  assert.deepEqual(await mac.files.readInstall(), install);
  assert.equal(await secretKeychain.read(), world.google.deployedSecret());
  assert.deepEqual(gas.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.deepEqual(new Map([...gas.properties].filter(([key]) => key !== 'journal')),
    new Map([...properties].filter(([key]) => key !== 'journal')));
  assert.match(io.lines.at(-1) ?? '', /^Воркер обновлён до версии \d+\.\d+\.\d+\. Изменения заработают со следующего запуска\.$/);
  assert.equal(world.github.requests.length, githubRequests, 'the GitHub repository is not asked');
  assert.deepEqual(world.google.opened.slice(opened), [], 'the kept sign-in is used');

  // The worker answers this Mac under the same URL with the new secret.
  const shown = await run(status);
  assert.equal(shown.code, 0, shown.io.output());
  assert.ok(shown.io.lines.includes('СБРОСЫ · 2'), shown.io.output());
  assert.deepEqual(world.google.violations, []);
});

test('upgrade on Google with a sign-in Google ended opens the sign-in and goes on', async () => {
  const { world, project, run } = await onGoogle();
  world.google.expireRefreshTokens();
  const opened = world.google.opened.length;
  const versions = project.versions.length;
  const { code, io } = await run(upgrade);
  assert.equal(code, 0, io.output());
  assert.ok(world.google.opened.slice(opened).some(href => href.startsWith(GOOGLE_LOGIN)), io.output());
  assert.equal(project.versions.length, versions + 1);
  assert.match(io.lines.at(-1) ?? '', /^Воркер обновлён до версии/);
});

// The web app keeps answering with the previous version of the deployment for a few seconds;
// the upgrade waits it out instead of trusting the first answer (issue 20).
test('upgrade on Google waits out a web app still serving the previous version', async () => {
  const { world, project, gas, secretKeychain, run } = await onGoogle();
  world.google.servePrevious = 2;
  const [deploymentId] = [...project.deployments.keys()];
  const versions = project.versions.length;
  const next = `${await bundle()}\n// next version\n`;

  const { code, io } = await run(upgrade, { appsScriptSource: next });
  assert.equal(code, 0, io.output());
  assert.ok(io.waits.includes('Ждём, когда Google начнёт отдавать новую версию воркера…'), io.output());
  assert.deepEqual([...project.deployments], [[deploymentId, versions + 1]]);
  assert.equal(await secretKeychain.read(), world.google.deployedSecret());
  assert.deepEqual(gas.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.match(io.lines.at(-1) ?? '', /^Воркер обновлён до версии/);
  assert.deepEqual(world.google.violations, []);
});

test('upgrade on Google sends a deleted project or deployment to setup', async () => {
  const { world, project, run } = await onGoogle();
  project.deployments.clear();
  let result = await run(upgrade);
  assert.equal(result.code, 1);
  assert.equal(result.io.lines.at(-1), 'Проекта или развёртывания воркера в Google больше нет. Запустите `aures setup`: он развернёт воркер заново.');
  world.google.projects.clear();
  result = await run(upgrade);
  assert.equal(result.code, 1);
  assert.equal(result.io.lines.at(-1), 'Проекта или развёртывания воркера в Google больше нет. Запустите `aures setup`: он развернёт воркер заново.');
});

test('uninstall on Google stops the worker, deletes its web app, ends the Google sign-in and names the manual steps', async () => {
  const { world, mac, keychain, project, gas, run } = await onGoogle();
  const session = JSON.parse(gas.properties.get('state') ?? 'null').session as { refreshToken: string };
  const githubRequests = world.github.requests.length;
  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  assert.match(io.output(), new RegExp(`Будут удалены воркер на Google \\(${link(project)}`));
  assert.equal(world.github.requests.length, githubRequests, 'no GitHub sign-in for a worker that never was there');
  assert.deepEqual(gas.triggers, []);
  assert.equal(gas.authInvalidated, true);
  assert.deepEqual(world.auth.revoked, [session.refreshToken]);
  assert.equal(project.deployments.size, 0);
  assert.equal(world.google.refreshTokens.size, 0, 'the Google sign-in is revoked');
  assert.equal(keychain.entries.size, 0);
  assert.equal(await mac.files.readInstall(), null);
  assert.deepEqual(io.lines.slice(-5), [
    'Воркер на Google остановлен, его вход в ChatGPT отозван.',
    'Web app воркера на Google удалён.',
    'Вход aures в Google отозван.',
    'Вход в Google и секрет воркера удалены из Связки ключей.',
    `Последний шаг: удалите проект aures-worker на странице ${link(project)}`,
  ]);
  assert.ok(!io.output().includes(CONNECTIONS), 'the stopped worker left no entry to check for');
  assert.deepEqual(world.google.violations, []);
});

test('uninstall with a worker on each platform, the one on GitHub retired, removes both', async () => {
  const env = await cliWorld();
  let result = await env.run(setup, { answers: ['1', ''] });
  assert.equal(result.code, 0, result.io.output());
  const repo = env.world.github.repo();
  assert.ok(repo);
  // Retired by a switch to Google: no schedule; its GitHub sign-in stays in the Keychain.
  repo.workflowState = 'disabled_manually';
  await env.mac.files.writeInstall({ platform: 'google' });
  const { world, keychain, project, gas, run } = await onGoogle(env);

  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  // The move to Google is why GitHub is asked for anything at all; the line comes before the ask.
  const kept = io.lines.indexOf('В Связке ключей остался вход в GitHub от прежнего воркера; его репозиторий тоже будет удалён.');
  const asked = io.lines.indexOf('Для удаления репозитория GitHub просит отдельное разрешение: войдите ещё раз.');
  assert.ok(kept !== -1 && kept < asked, io.output());
  assert.match(io.output(), /Будут удалены репозиторий https:\/\/github\.com\/\S+ со всей историей, воркер на Google/);
  assert.equal(world.github.repo(), undefined);
  assert.deepEqual(gas.triggers, []);
  assert.equal(project.deployments.size, 0);
  assert.equal(world.google.refreshTokens.size, 0);
  assert.equal(keychain.entries.size, 0);
  assert.deepEqual(io.lines.slice(-3), [
    'Осталось сделать вручную:',
    `  1. Удалите проект aures-worker на странице ${link(project)}`,
    `  2. Закройте доступ к GitHub кнопкой Revoke на странице ${OAUTH_APP_LINK}`,
  ]);
  assert.deepEqual(world.google.violations, []);
  assert.deepEqual(world.github.violations, []);
});

test('uninstall on Google with a worker that does not answer names the access to take back for sure', async () => {
  const { project, gas, secretKeychain, run } = await onGoogle();
  await secretKeychain.remove();
  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  assert.ok(io.lines.includes('Воркер на Google не ответил: в Связке ключей этого Mac нет секрета воркера. ' +
    'Его расписание и вход в ChatGPT удалятся вместе с проектом.'), io.output());
  assert.deepEqual(gas.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.equal(project.deployments.size, 0);
  assert.equal(io.lines.at(-1), `  2. Закройте доступ aures-worker на странице ${CONNECTIONS}`);
});

test('uninstall on Google names the aures access when Google does not end the sign-in', async () => {
  const { world, run } = await onGoogle();
  world.google.revokeFail = 503;
  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  assert.ok(!io.lines.includes('Вход aures в Google отозван.'));
  assert.equal(io.lines.at(-1), `  2. Закройте доступ aures на странице ${CONNECTIONS}`);
});

test('uninstall on Google deletes nothing until the user confirms', async () => {
  const { world, keychain, project, gas, run } = await onGoogle();
  const entries = keychain.entries.size;
  const { code, io } = await run(uninstall, { answers: [''] });
  assert.equal(code, 0);
  assert.equal(io.lines.at(-1), 'Отменено.');
  assert.deepEqual(gas.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.equal(project.deployments.size, 1);
  assert.ok(world.google.refreshTokens.size > 0);
  assert.equal(keychain.entries.size, entries);
});

test('uninstall on Google goes on when the web app cannot be deleted, and leaves it to the project', async () => {
  const { world, keychain, mac, run } = await onGoogle();
  world.google.failNext = 'delete_deployment';
  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  assert.ok(io.lines.includes('Web app воркера на Google не удалён (delete_deployment_500). Он удалится вместе с проектом.'), io.output());
  assert.equal(world.google.refreshTokens.size, 0);
  assert.equal(keychain.entries.size, 0);
  assert.equal(await mac.files.readInstall(), null);
});

test('uninstall after a setup on Google cut short before the deploy names only the project to delete', async () => {
  const { world, mac, keychain, run } = await cliWorld();
  await mac.files.writeInstall({ platform: 'google', google: { scriptId: 'fake-script-cut' } });
  keychain.entries.set('google', '1//fake-left-behind');
  world.google.refreshTokens.set('1//fake-left-behind', []);
  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  assert.equal(world.google.refreshTokens.size, 0);
  assert.equal(keychain.entries.size, 0);
  assert.equal(io.lines.at(-1), 'Последний шаг: удалите проект aures-worker на странице https://script.google.com/home/projects/fake-script-cut');
});
