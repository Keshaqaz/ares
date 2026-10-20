import test from 'node:test';
import assert from 'node:assert/strict';
import { connectGoogle, deployWorker } from '../src/cli/google.ts';
import type { WorkerDeployment } from '../src/cli/google.ts';
import { postWorker } from '../src/google/api.ts';
import { command } from '../src/cli/common.ts';
import { cliWorld } from './support/cli-world.ts';
import type { CliWorld } from './support/cli-world.ts';
import { USER_SETTINGS } from './support/fake-google.ts';
import { bundle } from './support/fake-apps-script.ts';

const RULES = { beforeExpiry: true, weeklyAutoApply: false };

// Signs in to Google and deploys the worker over the given deployment, as setup and upgrade do.
async function deploy(cli: CliWorld, deployment: WorkerDeployment | null = null) {
  const { world, googleKeychain, secretKeychain } = cli;
  let deployed: WorkerDeployment | null = null;
  const now = () => world.now, sleep = async (ms: number) => world.advance(ms);
  const { code, io } = await cli.run(async ({ fetch, io }) => {
    const api = await connectGoogle({ fetch, keychain: googleKeychain, io, open: world.google.open, now });
    deployed = await deployWorker({ api, secretKeychain, io, open: world.google.open, sleep, workerSource: await bundle(), deployment });
    return 0;
  });
  assert.equal(code, 0);
  assert.ok(deployed);
  return { deployed: deployed as WorkerDeployment, io };
}
// The CLI's doPost with the secret from the Keychain.
const post = async (cli: CliWorld, url: string, action: string, extra: Record<string, unknown> = {}) =>
  postWorker(cli.world.fetch, url, { secret: await cli.secretKeychain.read(), action, ...extra });
const noViolations = ({ world }: CliWorld) => {
  assert.deepEqual(world.google.violations, []);
  assert.deepEqual(world.violations, []);
};

test('the first deploy waits for the Apps Script API: it opens usersettings, explains the switch and retries until it is on', async () => {
  const cli = await cliWorld();
  const { world } = cli;
  const { deployed, io } = await deploy(cli);
  assert.equal(world.google.opened.filter(url => url === USER_SETTINGS).length, 1, 'usersettings opens once');
  assert.match(io.output(), /API скрипта приложений Google Apps/);
  const creates = world.google.requests.filter(r => r.method === 'POST' && r.url.endsWith('/v1/projects'));
  assert.ok(creates.length >= 3, 'the create is repeated while the API is off');
  assert.deepEqual(io.waits.at(-1), null);
  const project = world.google.project();
  assert.ok(project);
  assert.equal(world.google.projects.size, 1);
  assert.equal(deployed.scriptId, project.scriptId);
  assert.equal(deployed.url, `https://script.google.com/macros/s/${deployed.deploymentId}/exec`);
  assert.deepEqual(project.files.map(file => file.name).sort(), ['appsscript', 'secret', 'worker']);
  assert.equal(world.google.deployedSecret(), await cli.secretKeychain.read());
  assert.match(await cli.googleKeychain.read() ?? '', /^1\/\//);

  // The owner grants the script its scopes; then doPost answers to the secret in the Keychain.
  assert.equal(await post(cli, deployed.url, 'status'), null, 'before the consent Google shows a page');
  await world.google.open(deployed.url);
  assert.equal((await post(cli, deployed.url, 'rules', { rules: RULES }))?.ok, true);
  assert.deepEqual(await postWorker(world.fetch, deployed.url, { secret: 'wrong', action: 'status' }), { ok: false, error: 'forbidden' });
  noViolations(cli);
});

test('with a box left unticked the CLI names the missing access and signs in again', async () => {
  const cli = await cliWorld();
  cli.world.google.apiEnabled = true;
  cli.world.google.consents = [['projects'], [], ['projects', 'deployments']];
  const { io } = await deploy(cli);
  const logins = cli.world.google.opened.filter(url => url.startsWith('https://accounts.google.com/'));
  assert.equal(logins.length, 3);
  assert.match(io.output(), /Google не дал доступ к: развёртывания проектов Google Apps Script\. /);
  assert.match(io.output(), /Google не дал доступ к: проекты Google Apps Script, развёртывания проектов Google Apps Script\. /);
  assert.deepEqual(cli.world.google.refreshTokens.get(await cli.googleKeychain.read() ?? ''),
    ['https://www.googleapis.com/auth/script.projects', 'https://www.googleapis.com/auth/script.deployments']);
  assert.equal(cli.world.google.projects.size, 1);
  noViolations(cli);
});

test('a refresh token Google no longer takes opens the sign-in again, and a kept one does not', async () => {
  const cli = await cliWorld();
  cli.world.google.apiEnabled = true;
  const first = await deploy(cli);
  const kept = await cli.googleKeychain.read();
  const again = await deploy(cli, first.deployed);
  assert.equal(cli.world.google.opened.filter(url => url.startsWith('https://accounts.google.com/')).length, 1);
  assert.doesNotMatch(again.io.output(), /Вход в Google/);
  assert.equal(await cli.googleKeychain.read(), kept);

  cli.world.google.expireRefreshTokens();
  const renewed = await deploy(cli, first.deployed);
  assert.equal(cli.world.google.opened.filter(url => url.startsWith('https://accounts.google.com/')).length, 2);
  assert.match(renewed.io.output(), /Вход в Google в браузере/);
  assert.doesNotMatch(renewed.io.output(), /invalid_grant|ошибк/i);
  assert.notEqual(await cli.googleKeychain.read(), kept);
  assert.ok(cli.world.google.refreshTokens.has(await cli.googleKeychain.read() ?? ''));
  noViolations(cli);
});

test('a refused consent ends the sign-in with an explanation', async () => {
  const cli = await cliWorld();
  cli.world.google.consents = ['denied'];
  const { code, io } = await cli.run(async ({ fetch, io }) =>
    command('setup', io, async () => {
      await connectGoogle({ fetch, keychain: cli.googleKeychain, io, open: cli.world.google.open, now: () => cli.world.now });
      return 0;
    }));
  assert.equal(code, 1);
  assert.match(io.output(), /Вход в Google отклонён/);
  assert.equal(await cli.googleKeychain.read(), null);
});

test('a repeated deploy updates the same deployment: the web app keeps its URL and state, and only the new secret opens it', async () => {
  const cli = await cliWorld();
  cli.world.google.apiEnabled = true;
  const { deployed } = await deploy(cli);
  await cli.world.google.open(deployed.url);
  await post(cli, deployed.url, 'rules', { rules: RULES });
  const login = await post(cli, deployed.url, 'login', { login: { id: 'login-1', session: cli.world.login() } });
  assert.equal(login?.outcome, 'idle');
  const oldSecret = await cli.secretKeychain.read();

  const { deployed: again } = await deploy(cli, deployed);
  assert.deepEqual(again, deployed);
  const project = cli.world.google.project();
  assert.equal(cli.world.google.projects.size, 1);
  assert.equal(project?.deployments.size, 1);
  assert.equal(project?.versions.length, 2);
  assert.notEqual(await cli.secretKeychain.read(), oldSecret);
  assert.deepEqual(await postWorker(cli.world.fetch, again.url, { secret: oldSecret, action: 'status' }), { ok: false, error: 'forbidden' });
  const status = await post(cli, again.url, 'status');
  assert.equal(status?.ok, true);
  assert.deepEqual((status?.summary as { login?: { id: string } } | null)?.login?.id, 'login-1');
  noViolations(cli);
});

test('a deploy interrupted after the project was created goes on in that project, which the caller learned at once', async () => {
  const cli = await cliWorld();
  cli.world.google.apiEnabled = true;
  const created: string[] = [];
  let deployed: WorkerDeployment | null = null;
  const now = () => cli.world.now, sleep = async (ms: number) => cli.world.advance(ms);
  await cli.run(async ({ fetch, io }) => {
    const api = await connectGoogle({ fetch, keychain: cli.googleKeychain, io, open: cli.world.google.open, now });
    cli.world.google.failNext = 'create_deployment';
    await assert.rejects(deployWorker({ api, secretKeychain: cli.secretKeychain, io, open: cli.world.google.open, sleep,
      workerSource: await bundle(), deployment: null, onProject: id => created.push(id) }));
    deployed = await deployWorker({ api, secretKeychain: cli.secretKeychain, io, open: cli.world.google.open, sleep,
      workerSource: await bundle(), deployment: { scriptId: created[0] ?? '' }, onProject: id => created.push(id) });
    return 0;
  });
  assert.equal(created.length, 1);
  assert.equal(cli.world.google.projects.size, 1);
  assert.equal((deployed as WorkerDeployment | null)?.scriptId, created[0]);
  assert.equal(await cli.secretKeychain.read(), cli.world.google.deployedSecret());
});
