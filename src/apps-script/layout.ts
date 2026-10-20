// The worker's script project on Apps Script: its manifest, the bundle and the doPost secret
// in a file of its own. The worker writes only its Script Properties.

// Before-expiry window on Apps Script: the tick comes every TICK_MINUTES (ADR-0007).
export const BEFORE_EXPIRY_MS = 3600_000;
export const TICK_MINUTES = 5;
// The global function the schedule calls.
export const TICK_FUNCTION = 'tick';

// The project in the user's Drive and its files: updateContent replaces them all; the CLI finds
// the project by the link to it on SCRIPT_HOME.
export const SCRIPT_HOME = 'https://script.google.com/home';
export const PROJECT_TITLE = 'aures-worker';
export const PROJECT_FILES = { manifest: 'appsscript', worker: 'worker', secret: 'secret' } as const;

// The global the secret file declares.
export const SECRET_GLOBAL = 'AURES_SECRET';

export const MANIFEST = {
  timeZone: 'Etc/UTC',
  runtimeVersion: 'V8',
  exceptionLogging: 'STACKDRIVER',
  oauthScopes: ['https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/script.scriptapp'],
  webapp: { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' },
};

export const secretSource = (secret: string): string => `var ${SECRET_GLOBAL} = ${JSON.stringify(secret)};\n`;
// The secret back from the file secretSource wrote; null for another text.
export const secretOf = (source: string): string | null => {
  const match = /^\s*var (\w+) = ("[^"\\]*");?\s*$/.exec(source);
  return match?.[1] === SECRET_GLOBAL && match[2] ? JSON.parse(match[2]) as string : null;
};
