// An Actions runner for the fake GitHub: each run checks the repository out into local git,
// runs the worker on those files with the STATE_KEY and WORKER_LOGIN secrets and the dispatch inputs, and brings
// the worker's pushes back into the fake repository. So the CLI and the worker meet only
// through the files and the secrets, as on GitHub. With { node: true } the run executes the worker.mjs
// found in the repository on plain node, as the workflow does; that child process sees a copy
// of the fake world (clock, sessions, quotas and resets) and its changes stay in the child.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { runWorker } from '../../src/worker/run.mjs';
import { FILES, STATE_KEY_SECRET, LOGIN_SECRET, REVOKE_INPUT } from '../../src/worker/layout.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
const AUTHOR = ['-c', 'user.name=fake-github', '-c', 'user.email=fake-github@example.invalid'];

// The worker as the workflow runs it: `node worker.mjs` with STATE_KEY, APPLY_NOW, WORKER_LOGIN and REVOKE_SESSION.
async function nodeWorker(world, root, dir, key, applyNow, login, revoke) {
  const preload = join(root, 'fake-fetch.mjs');
  const { now, accountId, auth: { current }, chatgpt: { primary, secondary, credits } } = world;
  await writeFile(preload, `import { fakeWorld } from ${JSON.stringify(new URL('./fake-world.mjs', import.meta.url).href)};
    const world = fakeWorld(${JSON.stringify({ now, accountId })});
    Object.assign(world.chatgpt, ${JSON.stringify({ primary, secondary, credits })});
    world.auth.current = ${JSON.stringify(current)};
    globalThis.fetch = world.fetch;
    Date.now = () => world.now;\n`);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, STATE_KEY: key ?? '', APPLY_NOW: applyNow ?? '',
    WORKER_LOGIN: login ?? '', REVOKE_SESSION: String(revoke) };
  const result = await promisify(execFile)(process.execPath, ['--import', preload, FILES.worker], { cwd: dir, env })
    .catch(error => error);
  return { stdout: result.stdout, exitCode: result.code ?? 0 };
}

export function actionsRunner(world, { node = false } = {}) {
  return async (repo, run) => {
    const root = await mkdtemp(join(tmpdir(), 'actions-run-'));
    const origin = join(root, 'origin.git'), seed = join(root, 'seed'), dir = join(root, 'checkout');
    git(root, 'init', '--quiet', '--bare', '-b', 'main', origin);
    git(root, 'clone', '--quiet', origin, seed);
    for (const [path, { text }] of repo.files) {
      await mkdir(dirname(join(seed, path)), { recursive: true });
      await writeFile(join(seed, path), text);
    }
    git(seed, 'add', '.');
    git(seed, ...AUTHOR, 'commit', '--quiet', '-m', 'Fake GitHub contents');
    git(seed, 'push', '--quiet', 'origin', 'main');
    git(root, 'clone', '--quiet', '--depth', '1', `file://${origin}`, dir);

    const key = world.github.secret(repo, STATE_KEY_SECRET), applyNow = run.inputs?.apply_now || null;
    const login = world.github.secret(repo, LOGIN_SECRET) || null;
    const revoke = run.inputs?.[REVOKE_INPUT] === 'true';
    let printed, exitCode;
    if (node) ({ stdout: printed, exitCode } = await nodeWorker(world, root, dir, key, applyNow, login, revoke));
    else {
      const result = await runWorker({ dir, key, now: world.now, fetch: world.fetch, applyNow, login, revoke });
      printed = result.reason ? `${result.outcome}: ${result.reason}` : result.outcome;
      exitCode = result.exitCode;
    }
    for (const path of git(origin, 'ls-tree', '-r', '--name-only', 'main').split('\n').filter(Boolean)) {
      const text = git(origin, 'show', `main:${path}`);
      if (repo.files.get(path)?.text !== text) world.github.write(repo, path, text);
    }
    // Lines as the job log shows them: a timestamp, then what the step printed.
    const at = new Date(world.now).toISOString();
    const log = [`##[group]Run node ${FILES.worker}`, ...printed.trim().split('\n')].map(line => `${at} ${line}\n`).join('');
    return { conclusion: exitCode === 0 ? 'success' : 'failure', log };
  };
}
