// Entry point of the Apps Script bundle. scripts/build-worker.ts makes tick, doGet and doPost
// global functions and puts platform in place of the globals Apps Script lacks.
import { appsScriptWorker } from './worker.ts';
import { appsScript, AbortSignal, base64UrlBuffer } from './runtime.ts';
import { SyncPromise } from './sync-promise.ts';

// Declared by the secret file of the project (layout.ts, SECRET_GLOBAL), if it is there.
declare const AURES_SECRET: unknown;

export const { tick, doGet, doPost } = appsScriptWorker({ gas: appsScript,
  secret: () => typeof AURES_SECRET === 'string' && AURES_SECRET ? AURES_SECRET : null });
export const platform = { Promise: SyncPromise, AbortSignal, Buffer: base64UrlBuffer(appsScript) };
