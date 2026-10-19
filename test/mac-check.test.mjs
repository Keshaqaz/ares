import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setup } from '../src/cli/setup.mjs';
import { rules } from '../src/cli/rules.mjs';
import { status } from '../src/cli/status.mjs';
import { upgrade } from '../src/cli/upgrade.mjs';
import { uninstall } from '../src/cli/uninstall.mjs';
import { watch } from '../src/cli/watch.mjs';
import { LaunchAgent, AGENT_LABEL } from '../src/cli/launch-agent.mjs';
import { macLogin } from '../src/cli/mac-check.mjs';
import { FILES } from '../src/worker/layout.mjs';
import { window } from './support/fake-world.mjs';
import { cliWorld } from './support/cli-world.mjs';
import { UID } from './support/fake-mac.mjs';

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const exists = path => stat(path).then(() => true, () => false);
const WEEKLY_OFF = '{"formatVersion":1,"beforeExpiry":true,"weeklyAutoApply":false}\n';

// A worker installed by setup with the default rules (the weekly rule off).
async function installed() {
  const env = await cliWorld();
  const { code, io } = await env.run(setup, { answers: [''] });
  assert.equal(code, 0, io.output());
  const { mac } = env;
  const session = () => mac.files.readSession();
  const loaded = () => mac.launchctl.loaded.has(AGENT_LABEL);
  return { ...env, repo: env.world.github.repo(), session, loaded };
}

// The weekly rule switched on through `rules`.
async function watching() {
  const env = await installed();
  const { code, io } = await env.run(rules, { answers: ['2', ''] });
  assert.equal(code, 0, io.output());
  return env;
}

test('turning the weekly rule on logs this Mac into ChatGPT and starts the agent; the worker keeps its own session', async () => {
  const { world, repo, mac, keychain, run, session, loaded } = await installed();
  const { code, io } = await run(rules, { answers: ['2', ''] });
  assert.equal(code, 0, io.output());
  assert.deepEqual(io.lines.slice(-4), ['Правила сохранены и заработают со следующего запуска воркера.', macLogin(),
    io.lines.at(-2), 'Внеочередная проверка с этого Mac включена.']);
  assert.match(io.lines.at(-2), /^Откройте https:\/\/auth\.openai\.com\/codex\/device и введите код FAKE-\d+$/);
  assert.equal((await session()).refreshToken, world.auth.current.refresh);
  assert.equal(world.auth.sessions.length, 2, 'a session of its own, not the worker one');
  assert.equal(loaded(), true);
  assert.equal(await exists(mac.agent.plistPath), true);

  // The agent's pass sees the exhausted quota and calls the worker, which applies a reset on its session.
  world.chatgpt.secondary = window(604800, 100, world.now + 2 * DAY);
  world.advance(10 * MINUTE);
  const lines = [];
  await watch({ fetch: world.fetch, keychain, files: mac.files, log: line => lines.push(line),
    now: () => world.now });
  assert.deepEqual(lines, ['dispatched']);
  assert.deepEqual(world.spent(), ['reset-b']);
  assert.equal(repo.runs[0].event, 'workflow_dispatch');
  assert.deepEqual(world.violations, []);
});

test('turning the weekly rule off unloads the agent and revokes and deletes the Mac session', async () => {
  const { world, mac, run, session, loaded } = await watching();
  const macToken = (await session()).refreshToken;
  const { code, io } = await run(rules, { answers: ['2', ''] });
  assert.equal(code, 0, io.output());
  assert.equal(io.lines.at(-1), 'Внеочередная проверка с этого Mac выключена, его вход в ChatGPT отозван.');
  assert.equal(loaded(), false);
  assert.equal(await exists(mac.agent.plistPath), false);
  assert.equal(await session(), null);
  assert.deepEqual(world.auth.revoked, [macToken]);
  assert.equal(world.auth.sessions[0].family, 'active', 'the worker session stays');
  assert.equal(world.auth.sessions[1].family, 'refresh_token_invalidated');
});

test('a failed revocation does not keep the Mac session', async () => {
  const { world, run, session, loaded } = await watching();
  world.auth.revokeFail = 'network';
  const { code, io } = await run(rules, { answers: ['2', ''] });
  assert.equal(code, 0, io.output());
  assert.equal(io.lines.at(-1), 'Внеочередная проверка с этого Mac выключена. Вход Mac в ChatGPT не отозван (network), но удалён с этого Mac.');
  assert.equal(await session(), null);
  assert.equal(loaded(), false);
});

test('setup with the weekly rule chosen asks for the Mac code, and a repeated setup asks nothing', async () => {
  const env = await cliWorld();
  const first = await env.run(setup, { answers: ['2', ''] });
  assert.equal(first.code, 0, first.io.output());
  assert.equal(first.io.lines.filter(line => line === macLogin()).length, 1);
  assert.equal(env.mac.launchctl.loaded.has(AGENT_LABEL), true);
  assert.ok(await env.mac.files.readSession());

  const again = await env.run(setup, { answers: [] });
  assert.equal(again.code, 0, again.io.output());
  assert.ok(!again.io.lines.includes(macLogin()), again.io.output());
  assert.ok(!again.io.output().includes('Внеочередная проверка'), 'a working agent is not announced again');
  assert.equal(env.mac.launchctl.loaded.has(AGENT_LABEL), true);
});

test('setup after the Mac session is lost asks for the code again and clears sessionLost', async () => {
  const { world, mac, run, session, loaded } = await watching();
  const dispatched = { renewsAt: world.now + 2 * DAY, at: world.now };
  await mac.files.writeState({ sessionLost: true, dispatched, lastPass: { at: world.now, outcome: 'reauth_required' } });
  const old = await session();

  const { code, io } = await run(setup, { answers: [] });
  assert.equal(code, 0, io.output());
  assert.ok(io.lines.includes(macLogin()), io.output());
  assert.notEqual((await session()).refreshToken, old.refreshToken);
  const state = await mac.files.readState();
  assert.equal(state.sessionLost, undefined);
  assert.deepEqual(state.dispatched, dispatched, 'the window already asked for stays');
  assert.equal(loaded(), true);

  // The next pass reads the quota with the new session.
  const lines = [];
  await watch({ fetch: world.fetch, keychain: { read: async () => null }, files: mac.files, log: line => lines.push(line), now: () => world.now });
  assert.deepEqual(lines, ['idle']);
});

test('setup removes the agent and the Mac session when the rule was turned off elsewhere', async () => {
  const { world, repo, run, session, loaded } = await watching();
  world.github.write(repo, FILES.rules, WEEKLY_OFF);
  const { code, io } = await run(setup, { answers: [] });
  assert.equal(code, 0, io.output());
  assert.equal(loaded(), false);
  assert.equal(await session(), null);
});

test('an agent launchctl does not load is reported, and the command still succeeds', async () => {
  const { mac, run } = await installed();
  mac.launchctl.fail = { verb: 'bootstrap', code: 5 };
  const { code, io } = await run(rules, { answers: ['2', ''] });
  assert.equal(code, 0, io.output());
  assert.equal(io.lines.at(-1), 'Внеочередная проверка с этого Mac не запустилась (launchctl bootstrap: 5). Повторите `codex-auto-resets setup`.');
});

test('upgrade reloads the agent from a plist with this version\'s program while the rule is on', async () => {
  const { mac, run } = await watching();
  // A checkout moved, or Homebrew moved its prefix: the agent must run the program as it is now.
  const moved = new LaunchAgent({ home: mac.home, uid: UID, program: ['/node', '/new/src/cli/main.mjs', 'watch'],
    launchctl: mac.launchctl.run });
  const { code, io } = await run(upgrade, { mac: { ...mac, agent: moved } });
  assert.equal(code, 0, io.output());
  assert.match(mac.launchctl.loaded.get(AGENT_LABEL), /<string>\/new\/src\/cli\/main\.mjs<\/string>/);
});

test('upgrade with the rule off sets up nothing on this Mac', async () => {
  const { mac, run } = await installed();
  const calls = mac.launchctl.calls.length;
  const { code, io } = await run(upgrade);
  assert.equal(code, 0, io.output());
  assert.equal(mac.launchctl.calls.length, calls);
  assert.equal(await exists(mac.agent.plistPath), false);
});

test('uninstall leaves no agent, plist, Mac session, log or watch.json', async () => {
  const { world, mac, run } = await watching();
  await mac.files.writeState({ lastPass: { at: world.now, outcome: 'idle' } });
  await writeFile(mac.agent.logPath, 'idle\n');
  const macToken = (await mac.files.readSession()).refreshToken;

  const { code, io } = await run(uninstall, { answers: ['y'] });
  assert.equal(code, 0, io.output());
  assert.ok(io.lines.includes('Внеочередная проверка с этого Mac выключена, его вход в ChatGPT отозван.'), io.output());
  assert.equal(mac.launchctl.loaded.size, 0);
  assert.equal(await exists(mac.agent.plistPath), false);
  assert.equal(await exists(mac.files.dir), false);
  assert.equal(await exists(dirname(mac.agent.logPath)), false);
  assert.ok(world.auth.revoked.includes(macToken));
});

test('uninstall the user cancels leaves this Mac as it is', async () => {
  const { mac, run, loaded } = await watching();
  const { code } = await run(uninstall, { answers: ['n'] });
  assert.equal(code, 0);
  assert.equal(loaded(), true);
  assert.ok(await mac.files.readSession());
});

test('status tells whether the check from this Mac works, and what to do when it does not', async () => {
  const { mac, run } = await installed();
  const line = async () => {
    const { code, io } = await run(status);
    assert.equal(code, 0, io.output());
    return { rule: io.lines.find(l => l.includes('Когда кончится недельный лимит')), warnings: io.lines.filter(l => l.startsWith('! ')) };
  };
  assert.deepEqual(await line(), { rule: '  ☐ Когда кончится недельный лимит', warnings: [] });

  assert.equal((await run(rules, { answers: ['2', ''] })).code, 0);
  assert.deepEqual(await line(), { rule: '  ☑ Когда кончится недельный лимит · проверка с Mac работает', warnings: [] });

  await mac.files.writeState({ sessionLost: true });
  assert.deepEqual(await line(), { rule: '  ☑ Когда кончится недельный лимит · проверка с Mac не работает',
    warnings: ['! Вход этого Mac в ChatGPT потерян. Войдите заново: `codex-auto-resets setup`.'] });

  await mac.files.writeState({});
  await mac.agent.remove();
  assert.deepEqual(await line(), { rule: '  ☑ Когда кончится недельный лимит · проверка с Mac не работает',
    warnings: ['! Внеочередная проверка с этого Mac не запущена. Запустите `codex-auto-resets setup`.'] });
});
