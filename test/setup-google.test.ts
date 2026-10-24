import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../src/cli/setup.ts';
import { credit } from './support/fake-world.ts';
import { cliWorld } from './support/cli-world.ts';
import type { CliWorld, RunOptions } from './support/cli-world.ts';
import { USER_SETTINGS } from './support/fake-google.ts';
import type { FakeProject } from './support/fake-google.ts';

const HOUR = 3600_000, DAY = 24 * HOUR;
const GOOGLE_LOGIN = 'https://accounts.google.com/';
// The device-code page the ChatGPT sign-in opens (issue 23).
const DEVICE = 'https://auth.openai.com/codex/device';

async function googleWorld() {
  const cli = await cliWorld();
  // On Google the rules are set without a question (issue 24), so the platform is the only answer.
  return { ...cli, run: ({ answers = ['2'], ...rest }: RunOptions = {}) => cli.run(setup, { answers, ...rest }) };
}
const deployed = ({ world }: Pick<CliWorld, 'world'>): FakeProject => {
  const project = world.google.project();
  assert.ok(project);
  return project;
};
const property = (project: FakeProject, key: string): unknown => JSON.parse(project.gas?.properties.get(key) ?? 'null');
const noViolations = ({ world }: Pick<CliWorld, 'world'>) => {
  assert.deepEqual(world.google.violations, []);
  assert.deepEqual(world.violations, []);
};

test('setup on Google goes from nothing to a scheduled worker and ends with a trial run that spends nothing', async () => {
  const cli = await googleWorld();
  const { world, mac } = cli;
  world.chatgpt.credits.push(credit('RateLimitResetCredit_0eb466b3212c819193799a1741f067f8', world.now + 30 * 60_000));
  const { code, io } = await cli.run();
  assert.equal(code, 0, io.output());

  // Both platforms are named with their cost, none is recommended.
  assert.match(io.output(), /1\. GitHub Actions — .*за 8 часов/);
  assert.match(io.output(), /2\. Google Apps Script — .*каждые 5 минут.*непроверенном приложении/);
  assert.doesNotMatch(io.output(), /рекоменд/i);
  // The general warning about both «unverified app» screens comes before the first sign-in.
  const warned = io.lines.findIndex(line => line.includes('два предупреждения о непроверенном приложении'));
  const signIn = io.lines.findIndex(line => line.startsWith('Вход в Google в браузере'));
  assert.ok(warned >= 0 && warned < signIn, io.output());
  // The sign-in hint names the buttons of the real screens, and there is no «Allow» to press (issue 21).
  assert.match(io.output(), /«Эксперты Google не проверяли это приложение» нажмите «Продолжить»/);
  assert.match(io.output(), /«Вход в сервис "aures"»/);
  assert.match(io.output(), /отметьте все галочки \(или «Выбрать все»\) и нажмите «Продолжить»/);
  // The consent hint walks the «aures-worker (Unverified)» page and the popup with its boxes.
  assert.match(io.output(), /«aures-worker \(Unverified\)»: нажмите «Review permissions», согласие откроется во всплывающем окне/);
  assert.match(io.output(), /«Перейти на страницу "aures-worker" \(небезопасно\)»/);
  assert.match(io.output(), /отметьте обе галочки \(или «Выбрать все»\) и нажмите «Продолжить»/);
  assert.doesNotMatch(io.output(), /«Разрешить»|«Allow»/);
  // The rules go in without a question (issue 24): the platform is the only prompt, the worker
  // gets both rules on, and the one line names them and where to change them.
  assert.deepEqual(io.asked, ['Введите 1 или 2: ']);
  assert.doesNotMatch(io.output(), /Когда применять сбросы/);
  assert.match(io.output(),
    /Правила: перед истечением \(в последний час\) — вкл\., когда кончится недельный лимит — вкл\. Изменить: `aures rules` или экран `aures`\./);

  const project = deployed(cli);
  assert.equal(world.google.projects.size, 1);
  const [deploymentId] = [...project.deployments.keys()];
  const url = `https://script.google.com/macros/s/${deploymentId}/exec`;
  assert.deepEqual(world.google.opened.filter(href => !href.startsWith(GOOGLE_LOGIN)), [USER_SETTINGS, url, DEVICE]);
  assert.equal(project.authorized, true);
  assert.deepEqual(project.gas?.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.deepEqual(property(project, 'rules'), { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: true });
  const state = property(project, 'state') as { session: { accountId: string; refreshToken: string } };
  assert.equal(state.session.accountId, world.accountId);
  assert.equal(state.session.refreshToken, world.auth.current?.refresh);
  assert.deepEqual((property(project, 'journal') as { kind: string }[]).map(entry => entry.kind), ['login', 'trial']);
  assert.deepEqual(world.consumeCalls(), []);
  assert.match(io.lines.at(-1) ?? '', /^Воркер работает\. Сбросов: 3, .* Сейчас правила применили бы сброс RES67F8 \(перед истечением\)\.$/);

  assert.deepEqual(await mac.files.readInstall(), { platform: 'google', google: { scriptId: project.scriptId, deploymentId, url },
    accounts: { google: 'owner@example.invalid', chatgpt: 'fake@example.invalid' } });
  assert.equal(world.google.deployedSecret(), await cli.secretKeychain.read());
  assert.equal(world.github.requests.length, 0, 'GitHub is not touched');
  assert.equal(mac.launchctl.calls.length, 0, 'the weekly rule needs no check from this Mac on Google');
  noViolations(cli);
});

test('a repeated setup on Google finds the project and keeps its state, rules and schedule, without new sign-ins', async () => {
  const cli = await googleWorld();
  const { world } = cli;
  await cli.run({ answers: ['2'] });
  const project = deployed(cli);
  const before = new Map(project.gas?.properties);
  const versions = project.versions.length;
  const requests = world.google.requests.length;
  world.advance(DAY);

  const { code, io } = await cli.run({ answers: [] });
  assert.equal(code, 0, io.output());
  assert.deepEqual(io.asked, [], 'neither the platform nor the rules are asked again');
  assert.doesNotMatch(io.output(), /Изменить: `aures rules`/, 'the rules line is not printed again');
  assert.equal(world.google.projects.size, 1);
  assert.equal(project.versions.length, versions, 'nothing is deployed again');
  assert.equal(world.google.requests.slice(requests).filter(r => !r.url.includes('/macros/')).length, 0, 'no Google sign-in or API call');
  assert.doesNotMatch(io.output(), /auth\.openai\.com|не проверял/);
  assert.match(io.output(), /Вход в ChatGPT уже есть\./);
  assert.equal(project.gas?.properties.get('rules'), before.get('rules'));
  const state = property(project, 'state') as { session: { refreshToken: string } };
  assert.equal(state.session.refreshToken, world.auth.sessions[0]?.refresh);
  assert.deepEqual(project.gas?.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.match(io.lines.at(-1) ?? '', /^Воркер работает\. Сбросов: 2/);
  noViolations(cli);
});

test('setup stopped while the script waits to be allowed goes on with the consent in the same project', async () => {
  const cli = await googleWorld();
  const { world, googleKeychain } = cli;
  world.google.apiEnabled = true;
  world.google.allowsScript = false;
  // The user gives up waiting: Ctrl-C after a few polls.
  let polls = 0;
  const interrupted = cli.run({ sleep: async ms => { if (++polls > 3) throw new Error('Ctrl-C'); world.advance(ms); } });
  await assert.rejects(interrupted, /Ctrl-C/);
  const project = deployed(cli);
  assert.equal(project.authorized, false);
  const token = await googleKeychain.read();

  world.google.allowsScript = true;
  const { code, io } = await cli.run({ answers: [] });
  assert.equal(code, 0, io.output());
  assert.equal(world.google.projects.size, 1);
  assert.equal(project.versions.length, 1, 'the deployed version is kept');
  assert.equal(world.google.opened.filter(href => href.startsWith(GOOGLE_LOGIN)).length, 1, 'one Google sign-in');
  assert.equal(await googleKeychain.read(), token);
  assert.match(io.output(), /Разрешите скрипту воркера работать: https:\/\/script\.google\.com\/macros\/s\/.*\/exec/);
  // The consent hint again names the real screens, and no «Allow» button exists on them (issue 21).
  assert.match(io.output(), /«aures-worker \(Unverified\)»: нажмите «Review permissions»/);
  assert.match(io.output(), /«Дополнительные настройки» и «Перейти на страницу "aures-worker" \(небезопасно\)»/);
  assert.doesNotMatch(io.output(), /«Разрешить»|«Allow»/);
  assert.deepEqual(project.gas?.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.match(io.lines.at(-1) ?? '', /^Воркер работает\./);
  noViolations(cli);
});

test('setup interrupted right after the project is created deploys into that project', async () => {
  const cli = await googleWorld();
  const { world, mac } = cli;
  world.google.apiEnabled = true;
  world.google.failNext = 'update_content';
  const first = await cli.run();
  assert.equal(first.code, 1);
  assert.match(first.io.lines.at(-1) ?? '', /Ошибка Google \(update_content_500\)\. Повторите `aures setup`: сделанное сохранится/);
  const project = deployed(cli);
  assert.deepEqual(await mac.files.readInstall(), { platform: 'google', google: { scriptId: project.scriptId },
    accounts: { google: 'owner@example.invalid' } });

  const { code, io } = await cli.run({ answers: [] });
  assert.equal(code, 0, io.output());
  assert.equal(world.google.projects.size, 1);
  assert.equal(project.deployments.size, 1);
  noViolations(cli);
});

test('a worker that does not know the secret in the Keychain is deployed again under the same URL', async () => {
  const cli = await googleWorld();
  const { world, secretKeychain, mac } = cli;
  await cli.run();
  const install = await mac.files.readInstall();
  const old = await secretKeychain.read();
  await secretKeychain.write('another-secret');

  const { code, io } = await cli.run({ answers: [] });
  assert.equal(code, 0, io.output());
  assert.deepEqual(await mac.files.readInstall(), install);
  const fresh = await secretKeychain.read();
  assert.notEqual(fresh, old);
  assert.equal(world.google.deployedSecret(), fresh);
  assert.equal(deployed(cli).versions.length, 2);
  assert.match(io.output(), /Вход в ChatGPT уже есть\./);
  noViolations(cli);
});

// A redeployed web app keeps answering with the previous version, which does not know the new
// secret, until Google serves the new one; the setup waits that out (issue 20).
test('a web app still serving the previous version after a redeploy is waited out', async () => {
  const cli = await googleWorld();
  const { world, secretKeychain } = cli;
  await cli.run();
  await secretKeychain.write('another-secret');
  world.google.servePrevious = 2;

  const { code, io } = await cli.run({ answers: [] });
  assert.equal(code, 0, io.output());
  assert.ok(io.waits.includes('Ждём, когда Google начнёт отдавать новую версию воркера…'), io.output());
  assert.equal(world.google.deployedSecret(), await secretKeychain.read());
  assert.equal(deployed(cli).versions.length, 2);
  assert.match(io.lines.at(-1) ?? '', /^Воркер работает\./);
  noViolations(cli);
});

test('a web app that keeps answering with the previous version past the minute is a clear failure', async () => {
  const cli = await googleWorld();
  const { world, secretKeychain } = cli;
  await cli.run();
  await secretKeychain.write('another-secret');
  world.google.servePrevious = 1000;

  const { code, io } = await cli.run({ answers: [] });
  assert.equal(code, 1);
  assert.equal(io.lines.at(-1), 'Web app воркера всё ещё отвечает прежней версией: новая не вступила в силу за минуту. ' +
    'Повторите `aures setup` через несколько минут.');
  assert.ok(io.waits.includes('Ждём, когда Google начнёт отдавать новую версию воркера…'), io.output());
  assert.equal(io.waits.at(-1), null, 'the wait line is taken away');
  noViolations(cli);
});

test('the platform asked again until the answer is 1 or 2, and GitHub keeps its own path', async () => {
  const cli = await googleWorld();
  const { code, io } = await cli.run({ answers: ['3', '', '1', ''] });
  assert.equal(code, 0, io.output());
  assert.equal(io.asked.filter(question => question === 'Введите 1 или 2: ').length, 3);
  assert.deepEqual(await cli.mac.files.readInstall(), { platform: 'github', accounts: { chatgpt: 'fake@example.invalid' } });
  assert.ok(cli.world.github.repo());
  assert.equal(cli.world.google.requests.length, 0);
  assert.match(io.output(), /Перед истечением \(в последние 8 часов\)/);
});
