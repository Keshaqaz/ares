// The fake world a CLI command runs in: ChatGPT, auth.openai.com and GitHub with an Actions
// runner, a Keychain and a user at the terminal.
import { fakeWorld, credit } from './fake-world.mjs';
import { withGitHub } from './fake-github.ts';
import { actionsRunner } from './actions-runner.mjs';
import { fakeMac } from './fake-mac.mjs';
import { setLanguage } from '../../src/cli/language.mjs';

const HOUR = 3600_000, DAY = 24 * HOUR;
export const WORKER_SOURCE = '// fake worker bundle\n';

// The user at the terminal: approves each device code as soon as it is shown and answers
// prompts from a script (an empty line is Enter). waits are the texts of the live line, null
// where it went away.
export function terminal(world, answers = [], { github = true } = {}) {
  const lines = [], asked = [], waits = [];
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
      if (!answers.length) throw new Error(`unexpected prompt: ${question}`);
      return answers.shift();
    },
  };
}

// The macOS Keychain entry with the GitHub token.
export function fakeKeychain() {
  const entries = new Map();
  return { entries, read: async () => entries.get('github') ?? null,
    write: async token => { entries.set('github', token); }, remove: async () => { entries.delete('github'); } };
}

// run(command, { answers, github, ...options }) runs one CLI command, e.g. setup, against
// the world and this Mac and resolves to { code, io }. The tests read the Russian texts unless
// they ask for another language.
export async function cliWorld({ node = false, workerSource = WORKER_SOURCE, language = 'ru' } = {}) {
  setLanguage(language);
  const world = fakeWorld();
  world.chatgpt.credits = [credit('reset-a', world.now + 5 * DAY), credit('reset-b', world.now + 2 * DAY + 3 * HOUR)];
  await withGitHub(world);
  world.github.runner = actionsRunner(world, { node });
  const keychain = fakeKeychain();
  const mac = await fakeMac();
  const run = (command, { answers = [], github, ...options } = {}) => {
    const io = terminal(world, answers, { github });
    const done = command({ fetch: world.fetch, keychain, io, now: () => world.now, sleep: async ms => world.advance(ms),
      random: () => 0.5, workerSource, timeZone: 'UTC', mac, ...options });
    return done.then(code => ({ code, io }));
  };
  return { world, keychain, mac, run };
}
