// A fake Apps Script project: the built worker bundle runs in node:vm, among fakes of the
// services it uses, with UrlFetchApp pointed at the fake ChatGPT world. The vm context has
// ECMAScript built-ins only, as Apps Script does: no fetch, Buffer, timers or modules.
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { appsScriptSource } from '../../scripts/build-worker.ts';
import { SCRIPT_SCOPES, secretSource } from '../../src/apps-script/layout.ts';
import type { AppsScript, HttpResponse, Lock, Trigger, UrlFetchRequest, TextOutput } from '../../src/apps-script/runtime.ts';
import type { FakeWorld } from './fake-world.ts';

// Apps Script quota: one Script Properties value.
export const PROPERTY_VALUE_LIMIT = 9 * 1024;
const EVERY_MINUTES = [1, 5, 10, 15, 30];

// The script's consent has these two boxes (issue 29): the triggers (script.scriptapp) and the
// external services (script.external_request).
export type ScriptScope = 'scriptapp' | 'external_request';

// Apps Script's exception for a service called without its scope, as the worker recognizes it
// (src/apps-script/runtime.ts): the standard phrase with the scope's URL in it.
const withoutScope = (call: string, scopeUrl: string): Error =>
  new Error(`You do not have permission to call ${call}. Required permissions: (${scopeUrl})`);

export interface FakeTrigger { handler: string; minutes: number }
export interface Reply { mimeType: string; text: string; json: Record<string, unknown> | null }

export interface FakeAppsScript {
  properties: Map<string, string>;
  // The longest value ever written, in bytes.
  largestValue: number;
  triggers: FakeTrigger[];
  lockHeld: boolean;
  authInvalidated: boolean;
  // Every fetchAll, as the requests it got.
  batches: UrlFetchRequest[][];
  // Called before a batch is served: another execution may start meanwhile.
  onFetch: (() => void) | null;
  violations: string[];
  // Runs these sources as the project's files from now on, as a new version does; properties
  // and triggers stay.
  load(files: string[]): void;
  // Calls into the script the way Apps Script does.
  tick(): void;
  doGet(): Reply;
  doPost(body: unknown): Reply;
}

let source: Promise<string> | null = null;
export const bundle = (): Promise<string> => source ??= appsScriptSource();

const output = (content: string): TextOutput & { mimeType: string } => {
  const text = { mimeType: 'TEXT', getContent: () => content,
    setMimeType: (mimeType: string) => { text.mimeType = mimeType; return text; } };
  return text;
};

// secret is the one the project's secret file declares; null leaves the file out. files, when
// given, are the project's sources instead of the secret file and the bundle. scopes, when given,
// names what the owner granted the script at its consent, read at each call: a service whose
// scope is not in it fails as Apps Script fails it (issue 29).
export async function fakeAppsScript({ world, secret = 'fake-secret-0123456789', files, scopes }: { world: FakeWorld;
  secret?: string | null; files?: string[]; scopes?: () => ScriptScope[] | null }): Promise<FakeAppsScript> {
  let context: Record<string, unknown> = {};
  const gas: FakeAppsScript = {
    properties: new Map(), largestValue: 0, triggers: [], lockHeld: false, authInvalidated: false, batches: [],
    onFetch: null, violations: [],
    load: sources => {
      context = vm.createContext({ ...services, fakeNow: () => world.now });
      vm.runInContext('Date.now = function () { return fakeNow(); };', context);
      sources.forEach((source, i) => vm.runInContext(source, context, { filename: `file${i}.gs` }));
    },
    tick: () => { (context.tick as () => void)(); },
    doGet: () => reply((context.doGet as (e: object) => TextOutput & { mimeType: string })({})),
    doPost: body => reply((context.doPost as (e: object) => TextOutput & { mimeType: string })(
      { postData: { contents: typeof body === 'string' ? body : JSON.stringify(body), type: 'application/json' } })),
  };
  const reply = (out: TextOutput & { mimeType: string }): Reply => {
    const text = out.getContent();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a text page */ }
    return { mimeType: out.mimeType, text, json };
  };

  const serve = (request: UrlFetchRequest): HttpResponse => {
    const { url, method, headers, contentType, payload, muteHttpExceptions, followRedirects } = request;
    if (!muteHttpExceptions) gas.violations.push(`muteHttpExceptions ${url}`);
    if (Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) gas.violations.push(`content-type header ${url}`);
    if (method !== method.toLowerCase()) gas.violations.push(`method ${method}`);
    const served = world.serve({ url, method: method.toUpperCase(),
      headers: new Headers({ ...headers, ...contentType ? { 'content-type': contentType } : {} }),
      body: payload ?? '', redirect: followRedirects ? 'follow' : 'error' });
    return { getResponseCode: () => served.status, getContentText: () => served.text };
  };

  const services: AppsScript = {
    // A request that does not reach its server fails the whole batch, as in Apps Script.
    UrlFetchApp: { fetchAll: requests => {
      if (scopes && !(scopes() ?? []).includes('external_request')) throw withoutScope('fetchAll', SCRIPT_SCOPES.externalRequest);
      const hook = gas.onFetch;
      gas.onFetch = null;
      hook?.();
      gas.batches.push(requests);
      return requests.map(serve);
    } },
    PropertiesService: { getScriptProperties: () => {
      const props = {
        getProperty: (key: string) => gas.properties.get(key) ?? null,
        setProperty: (key: string, value: string) => {
          const size = Buffer.byteLength(value);
          if (size > PROPERTY_VALUE_LIMIT) throw new Error(`Argument too large: ${key}`);
          gas.largestValue = Math.max(gas.largestValue, size);
          gas.properties.set(key, value);
          return props;
        },
        deleteAllProperties: () => { gas.properties.clear(); return props; },
      };
      return props;
    } },
    // One script lock for all executions; this execution cannot wait for another, so a lock held
    // elsewhere is a lock that did not come in time.
    LockService: { getScriptLock: (): Lock => {
      let mine = false;
      return {
        tryLock: () => {
          if (gas.lockHeld) return false;
          gas.lockHeld = mine = true;
          return true;
        },
        releaseLock: () => { if (mine) gas.lockHeld = mine = false; },
      };
    } },
    ScriptApp: {
      getProjectTriggers: () => {
        if (scopes && !(scopes() ?? []).includes('scriptapp')) throw withoutScope('getProjectTriggers', SCRIPT_SCOPES.scriptapp);
        return gas.triggers.map((trigger): Trigger & { fake: FakeTrigger } =>
          ({ fake: trigger, getHandlerFunction: () => trigger.handler }));
      },
      // As the documentation has it: the authorized scopes of the list asked about, null when
      // nothing says (a script the fake never gave a consent to answers with its services
      // instead, as the web app answers Google's 403 page before the script runs).
      getAuthorizationInfo: (authMode, asked) => ({
        getAuthorizedScopes: () => {
          if (authMode !== 'FULL') gas.violations.push(`authMode ${authMode}`);
          const granted = scopes?.() ?? null;
          return granted && asked.filter(url => granted.some(scope =>
            (scope === 'external_request' ? SCRIPT_SCOPES.externalRequest : SCRIPT_SCOPES.scriptapp) === url));
        },
      }),
      AuthMode: { FULL: 'FULL' },
      deleteTrigger: trigger => {
        gas.triggers = gas.triggers.filter(t => t !== (trigger as Trigger & { fake: FakeTrigger }).fake);
      },
      newTrigger: handler => ({ timeBased: () => ({ everyMinutes: minutes => ({ create: () => {
        if (!EVERY_MINUTES.includes(minutes)) throw new Error(`everyMinutes(${minutes})`);
        const trigger = { handler, minutes };
        gas.triggers.push(trigger);
        return { getHandlerFunction: () => handler };
      } }) }) }),
      invalidateAuth: () => { gas.authInvalidated = true; },
    },
    ContentService: { createTextOutput: output, MimeType: { JSON: 'JSON', TEXT: 'TEXT' } },
    Utilities: {
      getUuid: () => randomUUID(),
      // Apps Script bytes are signed.
      base64DecodeWebSafe: text => [...Buffer.from(text, 'base64url')].map(byte => byte << 24 >> 24),
      newBlob: bytes => ({ getDataAsString: () => Buffer.from(bytes.map(byte => byte & 0xff)).toString('utf8') }),
    },
  };

  gas.load(files ?? [...secret === null ? [] : [secretSource(secret)], await bundle()]);
  return gas;
}
