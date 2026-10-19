// Bundles the worker into one readable file that runs on plain `node`, without node_modules.
// Setup and upgrade put this file into the user's worker repository.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('..', import.meta.url));

export async function buildWorker(outfile = `${root}dist/worker.mjs`): Promise<string> {
  await build({
    entryPoints: [`${root}src/worker/main.ts`], outfile, bundle: true, platform: 'node', format: 'esm',
    // The node preinstalled on the runner, not the pinned one: the workflow installs nothing.
    // Settings come from here, not tsconfig.json: its target is for tsc.
    tsconfigRaw: {}, target: 'node20', minify: false, legalComments: 'none', logLevel: 'warning',
    banner: { js: `// aures worker ${pkg.version}, built from src/worker/main.ts. Do not edit.` },
  });
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(await buildWorker(process.argv[2]));
