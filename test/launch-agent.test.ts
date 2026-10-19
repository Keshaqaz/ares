import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { LaunchAgent, LaunchctlFailed, AGENT_LABEL, agentProgram } from '../src/cli/launch-agent.ts';
import { fakeMac, UID } from './support/fake-mac.ts';

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

test('the agent runs through the Homebrew opt path, which survives brew upgrade, or through this node and main.ts', () => {
  assert.deepEqual(agentProgram({ main: '/opt/homebrew/Cellar/aures/0.1.0/libexec/src/cli/main.ts', node: '/opt/homebrew/opt/node/bin/node' }),
    ['/opt/homebrew/opt/aures/bin/aures', 'watch']);
  assert.deepEqual(agentProgram({ main: '/usr/local/Cellar/aures/0.2.0_1/libexec/src/cli/main.ts', node: '/usr/local/bin/node' }),
    ['/usr/local/opt/aures/bin/aures', 'watch']);
  assert.deepEqual(agentProgram({ main: '/Users/me/src/aures/src/cli/main.ts', node: '/Users/me/.cache/node/bin/node' }),
    ['/Users/me/.cache/node/bin/node', '/Users/me/src/aures/src/cli/main.ts', 'watch']);
});

test('install writes the plist and loads it into the user GUI domain', async () => {
  const { home, launchctl, agent } = await fakeMac();
  await agent.install();
  const plist = await readFile(agent.plistPath, 'utf8');
  assert.equal(agent.plistPath, join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`));
  assert.match(plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.match(plist, new RegExp(`<key>Label</key>\\s*<string>${AGENT_LABEL.replaceAll('.', '\\.')}</string>`));
  assert.match(plist, /<key>ProgramArguments<\/key>\s*<array>\s*<string>\/opt\/homebrew\/opt\/aures\/bin\/aures<\/string>\s*<string>watch<\/string>\s*<\/array>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>120<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  const log = join(home, 'Library', 'Logs', 'codex-auto-resets', 'watch.log');
  assert.match(plist, new RegExp(`<key>StandardOutPath</key>\\s*<string>${log}</string>`));
  assert.match(plist, new RegExp(`<key>StandardErrorPath</key>\\s*<string>${log}</string>`));
  // launchd does not create the folder for the log.
  assert.equal(await exists(dirname(log)), true);
  assert.deepEqual(launchctl.loaded.get(AGENT_LABEL), plist);
  assert.deepEqual(launchctl.calls.at(-1), ['bootstrap', `gui/${UID}`, agent.plistPath]);
  assert.equal(await agent.loaded(), true);
});

test('install over a loaded agent reloads it from the new plist', async () => {
  const { launchctl, agent } = await fakeMac();
  await agent.install();
  const moved = new LaunchAgent({ home: agent.home, uid: UID, program: ['/node', '/new/main.ts', 'watch'], launchctl: launchctl.run });
  await moved.install();
  assert.match(launchctl.loaded.get(AGENT_LABEL) ?? '', /<string>\/new\/main\.ts<\/string>/);
  assert.deepEqual(launchctl.calls.slice(-2), [['bootout', `gui/${UID}/${AGENT_LABEL}`], ['bootstrap', `gui/${UID}`, agent.plistPath]]);
});

test('install leaves a loaded agent with the same plist alone: a bootout would kill a pass in the middle of a refresh', async () => {
  const { launchctl, agent } = await fakeMac();
  await agent.install();
  const calls = launchctl.calls.length;
  await agent.install();
  assert.deepEqual(launchctl.calls.slice(calls), [['print', `gui/${UID}/${AGENT_LABEL}`]]);
});

test('plist strings are escaped', async () => {
  const { launchctl } = await fakeMac();
  const agent = new LaunchAgent({ home: '/tmp/a&b', uid: UID, program: ['/x<y>/node', 'watch'], launchctl: launchctl.run });
  assert.match(agent.plist(), /<string>\/x&lt;y&gt;\/node<\/string>/);
  assert.match(agent.plist(), /<string>\/tmp\/a&amp;b\/Library\/Logs\/codex-auto-resets\/watch\.log<\/string>/);
});

test('a bootstrap that keeps failing is reported with its exit code', async () => {
  const { launchctl, agent } = await fakeMac();
  launchctl.fail = { verb: 'bootstrap', code: 37 };
  await assert.rejects(agent.install(), error => error instanceof LaunchctlFailed && error.message === 'bootstrap: 37');
  assert.equal(launchctl.calls.filter(([verb]) => verb === 'bootstrap').length, 3, 'a bootout just before may still be finishing');
});

test('remove unloads the agent and deletes the plist; it tells whether there was anything', async () => {
  const { launchctl, agent } = await fakeMac();
  assert.equal(await agent.remove(), false);
  await agent.install();
  assert.equal(await agent.remove(), true);
  assert.equal(launchctl.loaded.size, 0);
  assert.equal(await exists(agent.plistPath), false);
  assert.equal(await agent.loaded(), false);

  // A plist left without a loaded agent still counts.
  await mkdir(dirname(agent.plistPath), { recursive: true });
  await writeFile(agent.plistPath, agent.plist());
  assert.equal(await agent.remove(), true);
});

test('removeLogFolder deletes the folder with the log', async () => {
  const { agent } = await fakeMac();
  await agent.install();
  await writeFile(agent.logPath, 'idle\n');
  await agent.removeLogFolder();
  assert.equal(await exists(dirname(agent.logPath)), false);
  await agent.removeLogFolder();
});
