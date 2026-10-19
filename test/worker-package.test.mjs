import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorker } from '../scripts/build-worker.mjs';
import { workflowYaml } from '../src/worker/workflow.mjs';
import { FILES, STATE_KEY_SECRET } from '../src/worker/layout.mjs';
import { generateKey } from '../src/worker/state-file.mjs';
import { fakeWorld } from './support/fake-world.mjs';
import { workerRepo } from './support/worker-repo.mjs';

const run = promisify(execFile);
const RULES = { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: false };

test('the workflow runs hourly on a static cron at the chosen minute, one run at a time, with only contents: write', () => {
  const yaml = workflowYaml({ minute: 17 });
  assert.match(yaml, /^ {2}schedule:\n {4}- cron: '17 \* \* \* \*'\n {2}workflow_dispatch:\n/m);
  assert.equal(yaml.match(/cron:/g).length, 1);
  assert.match(yaml, /^ {6}apply_now:\n/m);
  assert.match(yaml, /^concurrency:\n {2}group: codex-auto-resets\n {2}cancel-in-progress: false\n/m);
  assert.match(yaml, /^permissions:\n {2}contents: write\n(?! )/m);
  assert.equal(yaml.match(/permissions:/g).length, 1);
  // Third-party code runs with the session only when pinned to a commit.
  for (const [, ref] of yaml.matchAll(/uses: [^@\s]+@(\S+)/g)) assert.match(ref, /^[0-9a-f]{40}$/);
  assert.match(yaml, new RegExp(`STATE_KEY: \\$\\{\\{ secrets\\.${STATE_KEY_SECRET} \\}\\}`));
  assert.match(yaml, new RegExp(`run: node ${FILES.worker}\\n`));
  assert.doesNotMatch(yaml, /npm|setup-node|cache/);
  for (const minute of [0, 60, 1.5, '5']) assert.throws(() => workflowYaml({ minute }), RangeError);
  assert.doesNotThrow(() => workflowYaml({ minute: 1 }));
  assert.doesNotThrow(() => workflowYaml({ minute: 59 }));
});

async function bundled() {
  const dir = await mkdtemp(join(tmpdir(), 'worker-build-'));
  const file = await buildWorker(join(dir, FILES.worker));
  return { dir, file, text: await readFile(file, 'utf8') };
}

test('the build is one file that imports only node built-ins', async () => {
  const { dir, text } = await bundled();
  assert.deepEqual(await readdir(dir), [FILES.worker]);
  const imports = [...text.matchAll(/(?:^|\n)import\s[^;]*?from\s*["']([^"']+)["']|import\(["']([^"']+)["']\)/g)].map(m => m[1] ?? m[2]);
  assert.ok(imports.length > 0);
  for (const name of imports) assert.match(name, /^node:/);
  assert.doesNotMatch(text, /node_modules/);
});

test('the built worker runs on plain node in a checkout without node_modules', async () => {
  const world = fakeWorld();
  const repo = await workerRepo({ state: { formatVersion: 1, session: world.login(), pending: null, applied: [] }, rules: RULES });
  const { file } = await bundled();
  await writeFile(join(repo.dir, FILES.worker), await readFile(file));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_STEP_SUMMARY: repo.stepSummary };

  // A wrong key never reaches the network, so plain node shows the whole bundle loads.
  const failed = await run(process.execPath, [FILES.worker], { cwd: repo.dir, env: { ...env, STATE_KEY: generateKey() } })
    .catch(error => error);
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /broken_state: state_undecryptable/);
  assert.match(await repo.readStepSummary(), /state_undecryptable/);

  // The full tick, with fetch pointed at the fake world from a preload.
  const preload = join(repo.root, 'fake-fetch.mjs');
  await writeFile(preload, `import { fakeWorld } from ${JSON.stringify(new URL('./support/fake-world.mjs', import.meta.url).href)};
    const world = fakeWorld({ now: ${world.now} });
    world.auth.sessions.push(...${JSON.stringify(world.auth.sessions)});
    globalThis.fetch = world.fetch;\n`);
  const ok = await run(process.execPath, ['--import', preload, FILES.worker], { cwd: repo.dir, env: { ...env, STATE_KEY: repo.key } });
  assert.equal(ok.stdout.trim(), 'idle');
  assert.deepEqual(repo.commits(), ['Set up worker', 'Worker tick: idle']);
  assert.equal(JSON.parse(repo.show(FILES.summary)).resets[0].creditId, 'reset-a');
});
