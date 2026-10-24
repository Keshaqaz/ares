// The Apps Script services the worker uses, typed as far as it uses them, and the pieces of a
// web runtime that Apps Script lacks: fetch, AbortSignal and the one use of Buffer.
import { object } from '../chatgpt/http.ts';
import type { Fetch } from '../chatgpt/http.ts';
import { SCRIPT_SCOPES } from './layout.ts';

export interface UrlFetchRequest {
  url: string; method: string; headers: Record<string, string>; contentType?: string; payload?: string;
  muteHttpExceptions: boolean; followRedirects: boolean;
}
export interface HttpResponse { getResponseCode(): number; getContentText(): string }
// What ScriptApp.getAuthorizationInfo answers: which of the scopes it was asked about are granted.
export interface AuthorizationInfo { getAuthorizedScopes(): string[] | null }
export interface Properties {
  getProperty(key: string): string | null;
  setProperty(key: string, value: string): Properties;
  deleteAllProperties(): Properties;
}
export interface Lock { tryLock(timeoutMs: number): boolean; releaseLock(): void }
export interface Trigger { getHandlerFunction(): string }
export interface TriggerBuilder { timeBased(): { everyMinutes(minutes: number): { create(): Trigger } } }
export interface TextOutput { getContent(): string; setMimeType(mimeType: string): TextOutput }
export interface Blob { getDataAsString(): string }

export interface AppsScript {
  UrlFetchApp: { fetchAll(requests: UrlFetchRequest[]): HttpResponse[] };
  PropertiesService: { getScriptProperties(): Properties };
  LockService: { getScriptLock(): Lock };
  ScriptApp: {
    getProjectTriggers(): Trigger[];
    deleteTrigger(trigger: Trigger): void;
    newTrigger(functionName: string): TriggerBuilder;
    invalidateAuth(): void;
    // Says, without a request, which of the given scopes the user granted the script.
    getAuthorizationInfo(authMode: string, scopes: string[]): AuthorizationInfo;
    AuthMode: { FULL: string };
  };
  ContentService: { createTextOutput(content: string): TextOutput; MimeType: { JSON: string; TEXT: string } };
  Utilities: { getUuid(): string; base64DecodeWebSafe(text: string): number[]; newBlob(data: number[]): Blob };
}

// The event of doGet and doPost; only the body of a POST is read.
export interface WebAppEvent { postData?: { contents?: string } }

declare const UrlFetchApp: AppsScript['UrlFetchApp'];
declare const PropertiesService: AppsScript['PropertiesService'];
declare const LockService: AppsScript['LockService'];
declare const ScriptApp: AppsScript['ScriptApp'];
declare const ContentService: AppsScript['ContentService'];
declare const Utilities: AppsScript['Utilities'];

// The global services, read when the script is called: they are there only inside Apps Script.
export const appsScript = (): AppsScript => ({ UrlFetchApp, PropertiesService, LockService, ScriptApp, ContentService, Utilities });

// The script's own consent did not give every scope its manifest asks for (issue 29): thrown
// where the authorization is read directly, as a service without its scope throws Apps Script's
// own exception of the same meaning. missingScopes() tells both apart from real failures.
export class MissingScopes extends Error {}

// Apps Script's exception when a service is called without a scope the user left unticked at the
// script's consent: «Exception: You do not have permission to call getProjectTriggers. Required
// permissions: (https://www.googleapis.com/auth/script.scriptapp)» — the same for UrlFetchApp's
// fetch/fetchAll and script.external_request. Recognized as narrowly as the text allows: the
// standard phrase together with the URL of one of the script's own two scopes (layout.ts).
export function missingScopes(error: unknown): boolean {
  if (error instanceof MissingScopes) return true;
  const message = (object(error) && typeof error.message === 'string' ? error.message : String(error)).toLowerCase();
  return message.includes('do not have permission to call') &&
    Object.values(SCRIPT_SCOPES).some(url => message.includes(url));
}

// Whether the script's consent gave every scope the manifest asks for (issue 29). Apps Script
// answers without a request: ScriptApp.getAuthorizationInfo(AuthMode.FULL, scopes) checks the
// given scopes, and its getAuthorizedScopes() names the authorized ones of the list asked about —
// the documented way for executions that start without a consent to every required scope
// (developers.google.com/apps-script: ScriptApp and AuthorizationInfo). null, which says nothing,
// is taken as unknown, and the services still fail with Apps Script's own exception.
export function scopesGranted(gas: AppsScript): boolean {
  const granted = gas.ScriptApp.getAuthorizationInfo(gas.ScriptApp.AuthMode.FULL,
    [SCRIPT_SCOPES.externalRequest, SCRIPT_SCOPES.scriptapp]).getAuthorizedScopes();
  return granted === null || Object.values(SCRIPT_SCOPES).every(url => granted.includes(url));
}

// What request() reads from a reply.
interface Reply { status: number; text(): Promise<string> }
interface Waiting { request: UrlFetchRequest; resolve(reply: Reply): void; reject(error: unknown): void }

// fetch over UrlFetchApp. A call only queues the request; flush() sends everything queued in one
// fetchAll, so the reads a tick makes side by side go out together. UrlFetchApp throws for the
// whole batch when a request does not reach its server; each of them fails like fetch does.
export function urlFetch(gas: AppsScript): { fetch: Fetch; flush(): boolean } {
  let queue: Waiting[] = [];
  const send = (url: string, { method = 'GET', headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string }) =>
    new Promise<Reply>((resolve, reject) => {
      // UrlFetchApp takes the body type as its own option, not as a header.
      const { 'content-type': contentType, ...rest } = headers;
      queue.push({ resolve, reject, request: { url, method: method.toLowerCase(), headers: rest, muteHttpExceptions: true,
        followRedirects: false, ...contentType ? { contentType } : {}, ...body === undefined ? {} : { payload: body } } });
    });
  const flush = (): boolean => {
    const batch = queue;
    queue = [];
    if (!batch.length) return false;
    let replies: HttpResponse[];
    try {
      replies = gas.UrlFetchApp.fetchAll(batch.map(w => w.request));
    } catch (error) {
      // A scope left unticked at the consent fails every request alike; that is the script's
      // own lack of a scope, which doPost answers as such, not a failure to reach the sites.
      if (missingScopes(error)) throw error;
      for (const waiting of batch) waiting.reject(new TypeError('fetch failed'));
      return true;
    }
    batch.forEach((waiting, i) => {
      const reply = replies[i];
      if (!reply) waiting.reject(new TypeError('fetch failed'));
      else waiting.resolve({ status: reply.getResponseCode(), text: async () => reply.getContentText() });
    });
    return true;
  };
  // request() passes only a string url, method, headers as a record and a string body, and reads
  // only the status and the text of the reply; Apps Script has no Request or Response to build.
  return { fetch: send as unknown as Fetch, flush };
}

// request() asks for a timeout signal; UrlFetchApp keeps its own deadline.
export const AbortSignal = { timeout: (): undefined => undefined };

// The worker decodes the claims of a JWT with Buffer.from(part, 'base64url'); nothing else of
// Buffer reaches the bundle.
export function base64UrlBuffer(gas: () => AppsScript) {
  return {
    from(text: string, encoding: string) {
      if (encoding !== 'base64url') throw new TypeError(`Buffer.from with ${encoding} is not available on Apps Script`);
      return {
        toString: () => {
          const { Utilities: utilities } = gas();
          return utilities.newBlob(utilities.base64DecodeWebSafe(text + '='.repeat((4 - text.length % 4) % 4))).getDataAsString();
        },
      };
    },
  };
}
