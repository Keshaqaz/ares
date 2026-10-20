// Bundles the worker into one readable file that runs on plain `node`, without node_modules.
// Setup and upgrade put this file into the user's worker repository. buildAppsScript bundles the
// same worker for Apps Script.
import { build } from 'esbuild';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
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

// The worker as one Apps Script file: no modules, the global functions tick, doGet and doPost.
// Async functions are compiled to generators over the global Promise, which the wrapper
// shadows with the bundle's own synchronous one (src/apps-script/sync-promise.ts), together
// with AbortSignal and Buffer. node:crypto becomes Utilities.getUuid.
export async function appsScriptSource(): Promise<string> {
  const { outputFiles: [bundle] = [] } = await build({
    entryPoints: [`${root}src/apps-script/main.ts`], bundle: true, write: false, platform: 'neutral', format: 'iife',
    globalName: 'AuresWorker', alias: { 'node:crypto': `${root}src/apps-script/node-crypto.ts` },
    tsconfigRaw: {}, target: 'es2017', supported: { 'async-await': false }, minify: false, legalComments: 'none', logLevel: 'warning',
  });
  if (!bundle) throw new Error('esbuild wrote no bundle');
  return [
    `// aures worker ${pkg.version} for Apps Script, built from src/apps-script/main.ts. Do not edit.`,
    'var AuresWorker = (function () {',
    '  var Promise, AbortSignal, Buffer;',
    bundle.text,
    '  ({ Promise, AbortSignal, Buffer } = AuresWorker.platform);',
    '  return AuresWorker;',
    '})();',
    'function tick() { AuresWorker.tick(); }',
    'function doGet(e) { return AuresWorker.doGet(e); }',
    'function doPost(e) { return AuresWorker.doPost(e); }',
    '',
  ].join('\n');
}

export async function buildAppsScript(outfile = `${root}dist/apps-script/worker.js`): Promise<string> {
  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, await appsScriptSource());
  return outfile;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(await buildWorker(process.argv[2]));
  console.log(await buildAppsScript());
}
