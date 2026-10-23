// A worker installed by setup on one platform, its screen opened on «Воркер», and a watch over
// both platforms for the switch of platform (ADR-0007): after every request the CLI makes and
// after every change of the screen it checks that at most one worker is active, and that a
// worker the install record names active is the only one with a schedule.
import assert from 'node:assert/strict';
import { setup } from '../../src/cli/setup.ts';
import { openScreen } from '../../src/cli/screen.ts';
import type { Screen } from '../../src/cli/screen.ts';
import { FILES, STATE_KEY_SECRET } from '../../src/worker/layout.ts';
import { openState } from '../../src/worker/state-file.ts';
import type { Platform } from '../../src/cli/watch-files.ts';
import type { Fetch } from '../../src/chatgpt/http.ts';
import { cliWorld } from './cli-world.ts';

// A request the CLI makes: its URL, method and body.
export interface SentRequest { url: URL; method: string; body: string }
// Sees each request before it goes out; what it returns, or rejects with, is the answer instead.
type Answer = Response | null | undefined | void;
export type OnRequest = (request: SentRequest) => Answer | Promise<Answer>;

export async function switchWorld(platform: Platform, { answers = [''] }: { answers?: string[] } = {}) {
  const env = await cliWorld();
  const { world, mac, secretKeychain } = env;
  const { code, io } = await env.run(setup, { answers: [platform === 'github' ? '1' : '2', ...answers] });
  assert.equal(code, 0, io.output());

  // What each platform has now: a schedule, and a session that is not revoked.
  const live = (refreshToken: string | undefined) => Boolean(refreshToken) && !world.auth.revoked.includes(refreshToken ?? '');
  const github = () => {
    const repo = world.github.repo();
    // The cron runs an enabled workflow that has one; a workflow without it is only dispatched.
    const scheduled = Boolean(repo?.workflowState === 'active' && /^ {2}schedule:$/m.test(repo.files.get(FILES.workflow)?.text ?? ''));
    const state = repo?.files.get(FILES.state)?.text, key = repo && world.github.secret(repo, STATE_KEY_SECRET);
    let session = null;
    // Between the new key and the new state (prepareGitHub) the worker could not open its state either.
    try { session = state && key ? openState(state, key).session : null; } catch { /* no session the worker can use */ }
    return { repo, scheduled, session, live: live(session?.refreshToken) };
  };
  const google = () => {
    const gas = world.google.project()?.gas ?? null;
    const scheduled = Boolean(gas?.triggers.length);
    const state = gas?.properties.get('state');
    const session = state ? (JSON.parse(state) as { session: { refreshToken: string } }).session : null;
    return { gas, scheduled, session, live: live(session?.refreshToken) };
  };
  const scheduled = (): Platform[] => (['github', 'google'] as const).filter(p => (p === 'github' ? github() : google()).scheduled);
  // Active: run by a schedule with a session that can apply a reset.
  const active = (): Platform[] => (['github', 'google'] as const).filter(p => {
    const now = p === 'github' ? github() : google();
    return now.scheduled && now.live;
  });

  // Every breach of the invariant, with the moment it was seen at.
  const breaches: string[] = [];
  const check = async (moment: string) => {
    if (active().length > 1) breaches.push(`${moment}: two active workers`);
    if (scheduled().length > 1) breaches.push(`${moment}: two schedules`);
    const install = await mac.files.readInstall(), others = scheduled().filter(p => p !== install?.platform);
    if (install && !install.switching && !install.paused && others.length) {
      breaches.push(`${moment}: the record names ${install.platform} active, ${others.join(', ')} scheduled`);
    }
  };

  let screen: Screen | undefined;
  // Called with each request before it goes out; a test presses Esc or breaks a request there.
  let onRequest: OnRequest | null = null;
  const fetch: Fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const request = { url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : '' };
    const broken = await onRequest?.(request);
    const response = broken ?? await world.fetch(input, init);
    await check(`${request.method} ${url.host}${url.pathname}`);
    return response;
  };
  // The user approves every device code the screen shows as soon as the CLI waits.
  const sleep = async (ms: number) => {
    for (const note of screen?.notes ?? []) {
      for (const [found] of note.text.matchAll(/FAKE-\d+/g)) world.approve(found);
      for (const [found] of note.text.matchAll(/GHFK-\d+/g)) world.github.approve(found);
    }
    world.advance(ms);
  };
  const reopen = async () => {
    await env.run(async options => { screen = await openScreen({ ...options, fetch, sleep }); return 0; });
    assert.ok(screen);
    const shown = screen;
    shown.changed = () => { void check(`frame: ${shown.busy ?? ''}`); };
    return shown;
  };
  const opened = await reopen();
  const press = async (...names: string[]) => {
    for (const name of names) await (screen ?? opened).press({ name, sequence: name });
    // What a cancelled switch left running stops at its next step.
    await new Promise(resolve => setImmediate(resolve));
  };
  const text = () => (screen ?? opened).frame().join('\n');
  // The doPost secret of this Mac, for a test that talks to the worker on Google itself.
  const secret = async () => await secretKeychain.read() ?? '';
  return { ...env, github, google, scheduled, active, breaches, check, fetch, sleep, press, text, secret, reopen,
    get screen() { return screen ?? opened; },
    get onRequest(): OnRequest | null { return onRequest; },
    set onRequest(hook: OnRequest | null) { onRequest = hook; } };
}
// The keys from the first action of the screen «Воркер» down to «Переключиться на …»: Проверить
// сейчас, Починить, Пауза, Переключиться.
export const TO_SWITCH = ['tab', 'down', 'down', 'down'];
