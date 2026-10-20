// The fake world a CLI command runs in: ChatGPT, auth.openai.com, GitHub with an Actions
// runner, Google with Apps Script, a Keychain and a user at the terminal.
import { fakeWorld, credit } from './fake-world.ts';
import { withGitHub } from './fake-github.ts';
import { actionsRunner } from './actions-runner.ts';
import { withGoogle } from './fake-google.ts';
import { bundle } from './fake-apps-script.ts';
import type { FakeGoogle } from './fake-google.ts';
import { fakeMac } from './fake-mac.ts';
import type { FakeWorld } from './fake-world.ts';
import type { FakeGitHub, Approval } from './fake-github.ts';
import type { FakeMac } from './fake-mac.ts';
import { setLanguage } from '../../src/cli/language.ts';
import type { Language } from '../../src/cli/language.ts';
import type { CommandOptions, Io } from '../../src/cli/common.ts';
import { GITHUB_TOKEN_ACCOUNT, GOOGLE_TOKEN_ACCOUNT, WORKER_SECRET_ACCOUNT } from '../../src/cli/keychain.ts';
import type { Keychain } from '../../src/cli/keychain.ts';
import type { Migration } from '../../src/worker/state-file.ts';

const HOUR = 3600_000, DAY = 24 * HOUR;
export const WORKER_SOURCE = '// fake worker bundle\n';

// The user at the terminal: approves each device code as soon as it is shown and answers
// prompts from a script (an empty line is Enter). waits are the texts of the live line, null
// where it went away.
export interface Terminal extends Io {
  lines: string[];
  asked: string[];
  waits: (string | null)[];
  output(): string;
}
export type CliFakeWorld = FakeWorld & { github: FakeGitHub; google: FakeGoogle };

export function terminal(world: CliFakeWorld, answers: string[] = [], { github = true }: { github?: Approval } = {}): Terminal {
  const lines: string[] = [], asked: string[] = [], waits: (string | null)[] = [];
  return {
    lines, asked, waits,
    wait: text => { waits.push(text); },
    output: () => lines.join('\n'),
    print: line => {
      lines.push(line);
      for (const [code] of line.matchAll(/GHFK-\d+/g)) world.github.approve(code, github);
      for (const [code] of line.matchAll(/FAKE-\d+/g)) world.approve(code);
    },
    prompt: async question => {
      asked.push(question);
      lines.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`unexpected prompt: ${question}`);
      return answer;
    },
  };
}

// One entry of the macOS Keychain, by its account; entries are all of them, by account.
export interface FakeKeychain extends Keychain { entries: Map<string, string> }
export function fakeKeychain(account = GITHUB_TOKEN_ACCOUNT, entries = new Map<string, string>()): FakeKeychain {
  return { entries, read: async () => entries.get(account) ?? null,
    write: async token => { entries.set(account, token); }, remove: async () => { entries.delete(account); } };
}

// What run hands a command, enough for any of them; a test overrides some for one command.
export interface WorldOptions extends CommandOptions {
  workerSource: string;
  appsScriptSource: string;
  googleKeychain: Keychain;
  secretKeychain: Keychain;
  open: (url: string) => Promise<void>;
  random: () => number;
  rulesMigrations?: Migration[];
}
export type RunOptions = Partial<WorldOptions> & { answers?: string[]; github?: Approval };
export interface CliWorld {
  world: CliFakeWorld;
  keychain: FakeKeychain;
  // The Google refresh token and the worker's doPost secret, in the same Keychain.
  googleKeychain: FakeKeychain;
  secretKeychain: FakeKeychain;
  mac: FakeMac;
  run(command: (options: WorldOptions) => Promise<number>, options?: RunOptions): Promise<{ code: number; io: Terminal }>;
}

// run(command, { answers, github, ...options }) runs one CLI command, e.g. setup, against
// the world and this Mac and resolves to { code, io }. The tests read the Russian texts unless
// they ask for another language.
export async function cliWorld({ node = false, workerSource = WORKER_SOURCE, language = 'ru' }:
  { node?: boolean; workerSource?: string; language?: Language } = {}): Promise<CliWorld> {
  setLanguage(language);
  const base = fakeWorld();
  base.chatgpt.credits = [credit('reset-a', base.now + 5 * DAY), credit('reset-b', base.now + 2 * DAY + 3 * HOUR)];
  const world = Object.assign(base, { github: await withGitHub(base), google: withGoogle(base) });
  world.github.runner = actionsRunner(world, { node });
  const keychain = fakeKeychain();
  const googleKeychain = fakeKeychain(GOOGLE_TOKEN_ACCOUNT, keychain.entries),
    secretKeychain = fakeKeychain(WORKER_SECRET_ACCOUNT, keychain.entries);
  const mac = await fakeMac();
  const appsScriptSource = await bundle();
  const run: CliWorld['run'] = (command, { answers = [], github, ...options } = {}) => {
    const io = terminal(world, answers, { github });
    const done = command({ fetch: world.fetch, keychain, io, now: () => world.now, sleep: async ms => world.advance(ms),
      random: () => 0.5, workerSource, appsScriptSource, googleKeychain, secretKeychain, open: world.google.open, timeZone: 'UTC', mac,
      ...options });
    return done.then(code => ({ code, io }));
  };
  return { world, keychain, googleKeychain, secretKeychain, mac, run };
}
