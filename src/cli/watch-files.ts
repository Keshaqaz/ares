import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import type { Session } from '../chatgpt/session.ts';
import type { Language } from './language.ts';

// What the out-of-schedule check keeps on this Mac: the computer session and watch.json;
// settings.json with the language of the CLI and install.json with the worker's platform live
// next to them.
// `security -i` cuts its command line at 4096 bytes and runs the rest as another command,
// and a session (three JWTs) is over 4 KB of JSON, so it lives in a 0600 file, not in the
// Keychain (ADR-0005).
export const SUPPORT_DIR = join(homedir(), 'Library', 'Application Support', 'codex-auto-resets');
const SESSION = 'chatgpt-session.json', STATE = 'watch.json', SETTINGS = 'settings.json', INSTALL = 'install.json';
const SESSION_FIELDS = ['accessToken', 'refreshToken', 'accountId'] as const;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
// idToken is not checked: the Mac never reads it.
const isSession = (value: unknown): value is Session =>
  object(value) && SESSION_FIELDS.every(key => typeof value[key] === 'string' && value[key]);

// watch.json as the passes write it. Only its shape is checked when it is read: the passes
// and status check the fields they use.
export interface WatchState {
  // The computer session is lost; setup clears it with a new one.
  sessionLost?: boolean;
  // The exhausted weekly window worker runs were started for: the latest at, count of them (none: 1).
  dispatched?: { renewsAt: number; at: number; count?: number };
  // The weekly quota as the last pass read it; null fields for a plan without a weekly window.
  read?: { at: number; usedPercent: number | null; renewsAt: number | null };
  lastPass?: { at: number; outcome: string };
}

export type Platform = 'github' | 'google';
// Where the worker of this install lives (ADR-0007). On Google: its project as soon as it exists,
// then the deployment and the URL of its web app.
export interface GoogleWorker { scriptId: string; deploymentId?: string; url?: string }
// paused is written only while it holds: the worker's schedule is off, so it is woken by no
// check from this Mac; unpause drops the field.
export interface Install { platform: Platform; paused?: true; google?: GoogleWorker }
const isGoogleWorker = (value: unknown): value is GoogleWorker => object(value) && typeof value.scriptId === 'string' &&
  ['deploymentId', 'url'].every(key => value[key] === undefined || typeof value[key] === 'string');

export interface WatchFilesOptions { dir?: string }

export class WatchFiles {
  dir: string;
  constructor({ dir = SUPPORT_DIR }: WatchFilesOptions = {}) { this.dir = dir; }
  // null when the file is missing or does not parse.
  async read(name: string): Promise<unknown> {
    try { return JSON.parse(await readFile(join(this.dir, name), 'utf8')); } catch { return null; }
  }
  // Written aside and renamed, so a crash never leaves half a file.
  async write(name: string, value: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = join(this.dir, name), aside = `${file}.tmp`;
    await writeFile(aside, JSON.stringify(value), { mode: 0o600 });
    await rename(aside, file);
  }

  // The computer session, or null when there is none or it is not a session.
  async readSession(): Promise<Session | null> {
    const session = await this.read(SESSION);
    return isSession(session) ? session : null;
  }
  async writeSession(session: Session): Promise<void> { await this.write(SESSION, session); }
  // A broken watch.json counts as empty.
  async readState(): Promise<WatchState> {
    const state = await this.read(STATE);
    return object(state) ? state : {};
  }
  async writeState(state: WatchState): Promise<void> { await this.write(STATE, state); }
  // The language the user picked, or null.
  async readLanguage(): Promise<unknown> {
    const settings = await this.read(SETTINGS);
    return object(settings) ? settings.language ?? null : null;
  }
  async writeLanguage(language: Language): Promise<void> {
    const settings = await this.read(SETTINGS);
    await this.write(SETTINGS, { ...object(settings) ? settings : {}, language });
  }
  // null when there is no install record or it does not read.
  async readInstall(): Promise<Install | null> {
    const install = await this.read(INSTALL);
    if (!object(install) || (install.platform !== 'github' && install.platform !== 'google')) return null;
    return { platform: install.platform, ...install.paused === true ? { paused: true } : {},
      ...isGoogleWorker(install.google) ? { google: install.google } : {} };
  }
  async writeInstall(install: Install): Promise<void> { await this.write(INSTALL, install); }
  // The folder with everything in it, for uninstall.
  async removeAll(): Promise<void> { await rm(this.dir, { recursive: true, force: true }); }
}
