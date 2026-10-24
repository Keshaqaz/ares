// The language of the CLI: the one the user picked with `l` on the screen or with
// `aures language ru`, kept on this Mac in settings.json next to the watch files — or, until
// the first pick, the language of the system (ru* → ru, anything else → en).
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

export const LANGUAGES = ['en', 'ru'] as const;
export type Language = typeof LANGUAGES[number];
let current: Language = 'en';

export const isLanguage = (value: unknown): value is Language => LANGUAGES.some(code => code === value);
export const language = (): Language => current;
export const setLanguage = (value: unknown): void => { current = isLanguage(value) ? value : 'en'; };
// The text in the current language.
export const t = (en: string, ru: string): string => current === 'ru' ? ru : en;

// The language of a locale the system may name, e.g. ru-RU of AppleLanguages or ru_RU.UTF-8
// of LANG: ru* is ru, everything else en.
export const languageOfLocale = (locale: string | null): Language =>
  locale !== null && locale.toLowerCase().startsWith('ru') ? 'ru' : 'en';

// What the CLI starts in: the pick from settings.json, and without one the system's language.
// Only a pick is ever written to settings.json, never what the system gave.
export const startLanguage = (picked: unknown, system: string | null): Language =>
  isLanguage(picked) ? picked : languageOfLocale(system);

const DEFAULTS = '/usr/bin/defaults';
// spawn as the defaults call uses it: stdout piped, stderr ignored.
export type SpawnDefaults = (file: string, args: string[], options: { stdio: ['ignore', 'pipe', 'ignore'] }) =>
  ChildProcessByStdio<null, Readable, null>;
export interface SystemLanguageOptions { spawnImpl?: SpawnDefaults; env?: NodeJS.ProcessEnv }

// What the system names as its language: the first entry of `defaults read -g
// AppleLanguages`, or when that does not read, the locale of LC_ALL, LC_MESSAGES or LANG.
// null when nothing does. spawnImpl and env are injected, as the tests do.
export async function readSystemLanguage({ spawnImpl = spawn, env = process.env }: SystemLanguageOptions = {}):
  Promise<string | null> {
  const apple = await new Promise<string | null>(resolve => {
    let child: ReturnType<SpawnDefaults>;
    try { child = spawnImpl(DEFAULTS, ['read', '-g', 'AppleLanguages'], { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { resolve(null); return; }
    let stdout = '';
    child.once('error', () => resolve(null));
    // A non-zero exit is a Mac without the list; an empty one has no entry to take.
    child.once('close', code => resolve(code === 0 ? /"([^"]+)"/.exec(stdout)?.[1] ?? null : null));
    child.stdout.on('data', chunk => { stdout += chunk; });
  });
  return apple || env.LC_ALL || env.LC_MESSAGES || env.LANG || null;
}
