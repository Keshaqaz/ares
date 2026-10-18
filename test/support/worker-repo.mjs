// A worker repository on local git: a bare origin seeded the way setup seeds it, and a
// clone of it as the Actions checkout. Reads go to origin, so a test sees only what was pushed.
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FILES } from '../../src/worker/layout.mjs';
import { sealState, openState, generateKey } from '../../src/worker/state-file.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const AUTHOR = ['-c', 'user.name=cli', '-c', 'user.email=cli@example.invalid'];

export async function workerRepo({ state, rules }) {
  const root = await mkdtemp(join(tmpdir(), 'worker-repo-'));
  const origin = join(root, 'origin.git'), seed = join(root, 'seed'), dir = join(root, 'checkout');
  const key = generateKey();
  git(root, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(root, 'clone', '--quiet', origin, seed);
  await writeFile(join(seed, FILES.state), sealState(state, key));
  await writeFile(join(seed, FILES.rules), `${JSON.stringify(rules)}\n`);
  git(seed, 'add', '.');
  git(seed, ...AUTHOR, 'commit', '--quiet', '-m', 'Set up worker');
  git(seed, 'push', '--quiet', 'origin', 'main');
  let checkouts = 0;
  // A shallow clone of origin, as each run's actions/checkout makes.
  const checkout = (path = join(root, `checkout-${++checkouts}`)) => {
    git(root, 'clone', '--quiet', '--depth', '1', `file://${origin}`, path);
    return path;
  };
  checkout(dir);

  const show = (path, rev = 'main') => { try { return git(origin, 'show', `${rev}:${path}`); } catch { return null; } };
  const stepSummary = join(root, 'step-summary.md');
  return {
    root, dir, key, checkout, stepSummary,
    commits: () => git(origin, 'log', '--format=%s', 'main').split('\n').reverse(),
    // State as pushed at `rev` of origin.
    state: (rev = 'main') => openState(show(FILES.state, rev), key),
    show,
    // The CLI writes rules through the GitHub API while the worker runs.
    pushRules: async next => {
      git(seed, 'pull', '--quiet', 'origin', 'main');
      await writeFile(join(seed, FILES.rules), `${JSON.stringify(next)}\n`);
      git(seed, ...AUTHOR, 'commit', '--quiet', '-am', 'Change rules');
      git(seed, 'push', '--quiet', 'origin', 'main');
    },
    readStepSummary: () => readFile(stepSummary, 'utf8').catch(() => ''),
  };
}
