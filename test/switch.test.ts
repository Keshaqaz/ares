// Переключение площадки на экране «Воркер» (issue 13, ADR-0007): the new worker is prepared
// without a schedule, the old one is quenched, then the new one gets its schedule. At every
// request and every frame at most one worker is active (switch-world checks it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { FILES } from '../src/worker/layout.ts';
import { readRules } from '../src/worker/state-file.ts';
import { askWorker } from '../src/cli/google.ts';
import { watch } from '../src/cli/watch.ts';
import { setup } from '../src/cli/setup.ts';
import { status } from '../src/cli/status.ts';
import { applyNow } from '../src/cli/apply-now.ts';
import { credit } from './support/fake-world.ts';
import { switchWorld, TO_SWITCH } from './support/switch-world.ts';
import type { SentRequest } from './support/switch-world.ts';

const MINUTE = 60_000, HOUR = 3600_000;
const ACCOUNTS = { chatgpt: 'fake@example.invalid' };
type World = Awaited<ReturnType<typeof switchWorld>>;

const doPost = (request: SentRequest, action: string): boolean =>
  request.method === 'POST' && request.url.pathname.startsWith('/macros/') && JSON.parse(request.body || '{}').action === action;
const switchSteps = (env: World): string[] => env.screen.steps.map(step => step.text).filter(text => text.startsWith('Переключение: '));

// The old worker as the switch must leave it when it does not get to the quench.
function stillActive(env: World, platform: 'github' | 'google') {
  const old = platform === 'github' ? env.github() : env.google();
  assert.ok(old.scheduled, 'the old worker keeps its schedule');
  assert.ok(old.live, 'the old worker keeps a live session');
  assert.deepEqual(env.world.auth.revoked, [], 'no session is revoked');
  assert.deepEqual(env.scheduled(), [platform], 'the new worker has no schedule');
}

test('GitHub → Google → GitHub: the rules move, the old worker is quenched, the new one scheduled, never two active', async () => {
  // Setup on GitHub with «перед истечением» switched off.
  const env = await switchWorld('github', { answers: ['1', ''] });
  const { world, mac, press, text } = env;
  const repo = env.github().repo;
  assert.ok(repo);
  const firstSession = env.github().session;

  await press(...TO_SWITCH);
  assert.match(text(), /\n▸ Переключиться на Google Apps Script\n/);
  await press('return');
  assert.equal(env.screen.busy, null);
  assert.deepEqual(env.breaches, []);

  // The old worker on GitHub: no schedule, its session revoked, the repository kept.
  assert.equal(repo.workflowState, 'disabled_manually');
  assert.ok(world.auth.revoked.includes(firstSession?.refreshToken ?? ''), 'the GitHub session is revoked');
  assert.ok(world.github.repo(), 'the repository stays for a switch back');
  assert.equal(repo.runs[0]?.display_title, 'Revoke session');
  // The new worker on Google: the rules moved, its own live session, a schedule, a trial run.
  const project = world.google.project();
  assert.ok(project?.gas);
  assert.deepEqual(JSON.parse(project.gas.properties.get('rules') ?? 'null'), { formatVersion: 1, beforeExpiry: false, weeklyAutoApply: false });
  assert.deepEqual(project.gas.triggers, [{ handler: 'tick', minutes: 5 }]);
  assert.ok(env.google().live);
  assert.deepEqual(env.active(), ['google']);
  assert.deepEqual((JSON.parse(project.gas.properties.get('journal') ?? '[]') as { kind: string }[]).map(e => e.kind), ['login', 'trial']);
  assert.deepEqual(world.spent(), [], 'the switch applies nothing');
  const install = await mac.files.readInstall();
  assert.deepEqual(install, { platform: 'google', google: { scriptId: project.scriptId, deploymentId: [...project.deployments.keys()][0],
    url: install?.google?.url }, accounts: { ...ACCOUNTS, google: 'owner@example.invalid' } });
  assert.match(text(), /\n● Google Apps Script · активен\n/);
  assert.match(text(), /\n▸ Проверить сейчас\n[\s\S]*\n {2}Переключиться на GitHub Actions\n/);
  assert.deepEqual(switchSteps(env), [
    'Переключение: Переключаемся на Google Apps Script. Esc отменяет до гашения старого воркера.',
    'Переключение: Входим в Google…',
    `Переключение: Воркер развёрнут, версия ${(await import('../package.json', { with: { type: 'json' } })).default.version}: ${install?.google?.url}`,
    'Переключение: Скрипту воркера разрешено работать.',
    'Переключение: Общие правила перенесены: перед истечением — выключено, когда кончится недельный лимит — выключено.',
    'Переключение: Вход в ChatGPT для нового воркера: своя сессия…',
    'Переключение: У нового воркера своя сессия ChatGPT.',
    'Переключение: Гасим старый воркер на GitHub Actions…',
    'Переключение: Отзываем сессию ChatGPT старого воркера…',
    'Переключение: Сессия старого воркера отозвана.',
    'Переключение: Расписание старого воркера снято: он погашен.',
    'Переключение: Новый воркер на Google Apps Script работает по расписанию.',
    'Переключение: Проверяем новый воркер: пробный запуск…',
    switchSteps(env)[13] ?? '',
    'Переключение: Воркер переключён на Google Apps Script. Старый на GitHub Actions погашен, его репозиторий сохранён для обратного переключения.',
  ]);
  assert.match(switchSteps(env)[13] ?? '', /^Переключение: Воркер работает\. Сбросов: 2, .* Сейчас применять нечего\.$/);
  // The check from this Mac goes on to the new worker, and the quenched one is not run by the cron.
  assert.equal(await world.github.schedule(), null);

  // The user changes the rules on Google, then switches back.
  const google = env.google().session;
  assert.equal((await askWorker({ fetch: world.fetch, url: install?.google?.url ?? '', secret: await env.secret() }, 'rules',
    { rules: { beforeExpiry: true, weeklyAutoApply: true } }))?.ok, true);
  const runs = repo.runs.length;
  await press('down', 'down', 'down', 'return');
  assert.equal(env.screen.busy, null);
  assert.deepEqual(env.breaches, []);

  // The quenched repository is reused with this version, the rules moved back, a new session.
  assert.equal(world.github.repos.size, 1, 'no second repository');
  assert.equal(world.github.repo(), repo);
  assert.deepEqual(readRules(world.github.text(repo, FILES.rules)), { formatVersion: 1, beforeExpiry: true, weeklyAutoApply: true });
  assert.equal(repo.workflowState, 'active');
  assert.ok(env.github().live, 'a new live session on GitHub');
  assert.notEqual(env.github().session?.refreshToken, firstSession?.refreshToken);
  assert.equal(repo.runs.length, runs + 1, 'the trial run only');
  assert.equal(repo.runs[0]?.display_title, 'Trial run');
  // Google is quenched: no trigger, its session revoked, the project kept.
  assert.deepEqual(project.gas.triggers, []);
  assert.ok(world.auth.revoked.includes(google?.refreshToken ?? ''), 'the Google session is revoked');
  assert.ok(world.google.projects.has(project.scriptId));
  assert.deepEqual(env.active(), ['github']);
  assert.deepEqual(await mac.files.readInstall(), { platform: 'github', google: install?.google,
    accounts: { ...ACCOUNTS, google: 'owner@example.invalid' } });
  assert.match(text(), /\n● GitHub Actions · активен\n/);
  assert.match(switchSteps(env).at(-2) ?? '', /^Переключение: Воркер работает\./);
  assert.equal(switchSteps(env).at(-1), 'Переключение: Воркер переключён на GitHub Actions. Старый на Google Apps Script погашен, его проект сохранён ' +
    'для обратного переключения.');
  assert.ok(switchSteps(env).includes('Переключение: Репозиторий воркера переиспользуется: https://github.com/octo-fake/codex-auto-resets-worker'));

  // And to Google once more: the quenched project and its deployment are reused, its web app keeps its URL.
  const versions = project.versions.length;
  await press('down', 'down', 'down', 'return');
  assert.deepEqual(env.breaches, []);
  assert.equal(world.google.projects.size, 1);
  assert.equal(project.versions.length, versions + 1, 'this version goes in');
  assert.equal((await mac.files.readInstall())?.google?.url, install?.google?.url);
  assert.deepEqual(env.active(), ['google']);
  assert.ok(switchSteps(env).some(step => step.startsWith('Переключение: Проект воркера переиспользуется')));
  assert.deepEqual(world.github.violations, []);
  assert.deepEqual(world.google.violations, []);
});

test('a pending application refuses the switch with the reason, and nothing changes', async () => {
  const env = await switchWorld('github');
  const { world, mac, press, text } = env;
  // The consume request is lost on every try of the run: the outcome is not known.
  world.chatgpt.credits.push(credit('reset-c', world.now + 2 * HOUR));
  world.chatgpt.lose = 'before';
  await world.github.schedule();
  world.chatgpt.lose = null;
  const repo = env.github().repo;
  assert.ok(repo);
  assert.equal(JSON.parse(world.github.text(repo, FILES.summary)).pending?.creditId, 'reset-c');
  const install = await mac.files.readInstall(), commits = repo.commits.length, requests = world.google.requests.length;

  await press(...TO_SWITCH, 'return');
  assert.equal(switchSteps(env).at(-1), 'Переключение: Переключение отклонено: исход применения reset-c (перед истечением) ещё неизвестен. ' +
    'Новый воркер с чистым состоянием мог бы потратить второй сброс. Старый воркер уточнит исход при следующем запуске, переключайте после этого.');
  assert.deepEqual(await mac.files.readInstall(), install);
  assert.equal(repo.commits.length, commits);
  assert.equal(world.google.requests.length, requests, 'nothing is prepared on Google');
  stillActive(env, 'github');
  assert.match(text(), /\n● GitHub Actions · активен\n/);

  // Once the next run settles it, the switch goes.
  await world.github.schedule();
  await press('return');
  assert.deepEqual(env.active(), ['google']);
  assert.deepEqual(env.breaches, []);
});

test('a pending application on Google refuses the switch too', async () => {
  const env = await switchWorld('google');
  const { world, mac, press } = env;
  world.chatgpt.credits.push(credit('reset-c', world.now + 20 * MINUTE));
  world.chatgpt.lose = 'after';
  env.google().gas?.tick();
  world.chatgpt.lose = null;
  const install = await mac.files.readInstall();

  await press(...TO_SWITCH, 'return');
  assert.match(switchSteps(env).at(-1) ?? '', /^Переключение: Переключение отклонено: исход применения reset-c \(перед истечением\) ещё неизвестен\./);
  assert.deepEqual(await mac.files.readInstall(), install);
  assert.equal(world.github.repo(), undefined, 'nothing is prepared on GitHub');
  stillActive(env, 'google');
});

test('a worker that does not publish pending is of an older version: the switch is refused with «aures upgrade»', async () => {
  const env = await switchWorld('github');
  const repo = env.github().repo;
  assert.ok(repo);
  const { pending: _pending, ...older } = JSON.parse(env.world.github.text(repo, FILES.summary));
  env.world.github.write(repo, FILES.summary, JSON.stringify(older));

  await env.press(...TO_SWITCH, 'return');
  assert.match(switchSteps(env).at(-1) ?? '', /он старой версии\. Обновите его \(`aures upgrade`\), дождитесь следующего запуска и повторите переключение\.$/);
  stillActive(env, 'github');
});

// The moments of the switch from GitHub to Google before the quench, by the request under way.
const GITHUB_TO_GOOGLE: [string, (request: SentRequest) => boolean][] = [
  ['the status of the old worker', r => r.url.pathname.endsWith('/summary.json')],
  ['the Google sign-in', r => r.url.host === 'oauth2.googleapis.com'],
  ['the deploy', r => r.url.host === 'script.googleapis.com' && r.method === 'POST'],
  ['the consent of the script', r => doPost(r, 'status')],
  ['the move of the rules', r => doPost(r, 'rules')],
  ['the ChatGPT sign-in', r => r.url.pathname === '/api/accounts/deviceauth/token'],
  ['the login of the new worker', r => doPost(r, 'login')],
];
// And from Google to GitHub.
const GOOGLE_TO_GITHUB: [string, (request: SentRequest) => boolean][] = [
  ['the status of the old worker', r => doPost(r, 'status')],
  ['the GitHub sign-in', r => r.url.pathname === '/login/oauth/access_token'],
  ['the repository', r => r.url.pathname === '/user/repos'],
  ['the code', r => r.method === 'PUT' && r.url.pathname.endsWith('/worker.mjs')],
  ['the move of the rules', r => r.method === 'PUT' && r.url.pathname.endsWith('/rules.json')],
  ['the ChatGPT sign-in', r => r.url.pathname === '/api/accounts/deviceauth/token'],
];

for (const [from, moments] of [['github', GITHUB_TO_GOOGLE], ['google', GOOGLE_TO_GITHUB]] as const) {
  for (const [moment, matches] of moments) {
    test(`Esc during ${moment} (${from} → ${from === 'github' ? 'google' : 'github'}) leaves the old worker active with its session`, async () => {
      const env = await switchWorld(from);
      const { mac, press, text } = env;
      const install = await mac.files.readInstall();
      let pressed = false;
      env.onRequest = request => {
        if (!pressed && env.screen.stopSwitch && matches(request)) {
          pressed = true;
          void env.screen.press({ name: 'escape', sequence: '\x1b' });
        }
      };
      await press(...TO_SWITCH, 'return');
      assert.ok(pressed, `the switch got to ${moment}`);
      assert.equal(env.screen.busy, null);
      assert.equal(switchSteps(env).at(-1), 'Переключение: отменено по Esc; воркер остался как был: активен, его сессия жива.');
      const after = await mac.files.readInstall();
      assert.equal(after?.platform, from);
      assert.equal(after?.switching, undefined);
      assert.deepEqual(after?.accounts?.chatgpt, install?.accounts?.chatgpt);
      stillActive(env, from);
      assert.deepEqual(env.breaches, []);
      assert.match(text(), new RegExp(`\\n● ${from === 'github' ? 'GitHub Actions' : 'Google Apps Script'} · активен\\n`));
      assert.ok(!switchSteps(env).some(step => /Гасим|Отзываем/.test(step)), 'the quench never began');
    });
  }
}

test('Esc after the quench began does not stop the switch', async () => {
  const env = await switchWorld('github');
  env.onRequest = request => {
    if (request.url.pathname.endsWith('/dispatches')) void env.screen.press({ name: 'escape', sequence: '\x1b' });
  };
  await env.press(...TO_SWITCH, 'return');
  assert.deepEqual(env.active(), ['google']);
  assert.ok(!switchSteps(env).some(step => step.includes('отменено')));
  assert.deepEqual(env.breaches, []);
});

test('a failure to turn the new schedule on leaves no active worker, and «Повторить переключение» completes the switch', async () => {
  const env = await switchWorld('github');
  const { world, mac, press, text } = env;
  let failing = true;
  env.onRequest = request => {
    if (failing && doPost(request, 'schedule') && JSON.parse(request.body).on === true) return Promise.reject(new TypeError('fetch failed'));
  };
  await press(...TO_SWITCH, 'return');
  assert.equal(env.screen.busy, null);
  assert.deepEqual(env.breaches, []);
  // The old worker is quenched, the new one has no schedule: no worker is active.
  assert.deepEqual(env.scheduled(), []);
  assert.equal(env.github().live, false, 'the old session is revoked');
  assert.deepEqual((await mac.files.readInstall())?.switching, { from: 'github', quenched: true });
  assert.equal((await mac.files.readInstall())?.platform, 'google');
  assert.match(switchSteps(env).at(-1) ?? '', /^Переключение: Расписание нового воркера не включилось: Google недоступен\. .* Переключение площадки не завершено: активного воркера нет/);
  assert.match(text(), /\n● Google Apps Script · активного воркера нет: переключение не завершено\n/);
  assert.match(text(), /\nДЕЙСТВИЯ\n─+\n▸ Повторить переключение\n\n/, 'the only action is to finish the switch');
  // Nothing wakes a worker meanwhile, and setup would not schedule one.
  const lines: string[] = [];
  await watch({ fetch: world.fetch, keychain: env.keychain, secretKeychain: env.secretKeychain, files: mac.files, log: line => lines.push(line),
    now: () => world.now });
  assert.deepEqual(lines, ['switching']);
  const told = await env.run(status);
  assert.ok(told.io.lines.includes('● активного воркера нет: переключение не завершено'), told.io.output());
  assert.match(told.io.output(), /! Переключение площадки не завершено: активного воркера нет, сбросы не применяются\. Откройте экран «Воркер» \(`aures`, затем Tab\) и выберите «Повторить переключение»\./);
  const repeated = await env.run(setup);
  assert.equal(repeated.code, 1);
  assert.match(repeated.io.output(), /Переключение площадки не завершено/);
  assert.deepEqual(env.scheduled(), []);

  failing = false;
  await press('return');
  assert.equal(env.screen.busy, null);
  assert.deepEqual(env.breaches, []);
  assert.deepEqual(env.active(), ['google']);
  assert.equal((await mac.files.readInstall())?.switching, undefined);
  assert.equal(switchSteps(env).at(-1), 'Переключение: Воркер переключён на Google Apps Script. Старый на GitHub Actions погашен, его репозиторий ' +
    'сохранён для обратного переключения.');
  assert.ok(!switchSteps(env).slice(-6).some(step => step.includes('Гасим')), 'the retry does not quench again');
  assert.match(text(), /\n● Google Apps Script · активен\n/);
});

test('a failure while quenching leaves no active worker, and the retry quenches the old one before the new schedule', async () => {
  const env = await switchWorld('google');
  const { mac, press } = env;
  let failing = true;
  env.onRequest = request => {
    if (failing && doPost(request, 'schedule') && JSON.parse(request.body).on === false) return Promise.reject(new TypeError('fetch failed'));
  };
  await press(...TO_SWITCH, 'return');
  assert.deepEqual(env.breaches, []);
  assert.deepEqual((await mac.files.readInstall())?.switching, { from: 'google' });
  assert.equal(env.github().scheduled, false, 'the new worker waits for the quench');
  assert.ok(env.google().scheduled, 'the old trigger is still there');
  assert.equal(env.google().live, false, 'but the old session is revoked: nothing is active');
  assert.deepEqual(env.active(), []);

  failing = false;
  await press('return');
  assert.deepEqual(env.breaches, []);
  assert.deepEqual(env.google().gas?.triggers, []);
  assert.deepEqual(env.active(), ['github']);
  assert.equal((await mac.files.readInstall())?.switching, undefined);
});

// The old worker on GitHub is left with an application whose outcome is not known: the consume
// request of its scheduled run is lost on every try.
async function pendingOnGitHub(env: World): Promise<void> {
  env.world.chatgpt.credits.push(credit('reset-c', env.world.now + 2 * HOUR));
  env.world.chatgpt.lose = 'before';
  await env.world.github.schedule();
  env.world.chatgpt.lose = null;
}
// Runs once, at the first request of the ChatGPT sign-in of the new worker: the old one keeps
// working while the user signs in.
const whileSigningIn = (env: World, happen: () => unknown) => {
  let done = false;
  env.onRequest = async request => {
    if (!done && request.url.pathname === '/api/accounts/deviceauth/token') {
      done = true;
      await happen();
    }
  };
};
// The switch from `from` as it ends when the old worker turns out busy right before the quench.
async function undone(env: World, from: 'github' | 'google', why: RegExp) {
  const to = from === 'github' ? 'Google Apps Script' : 'GitHub Actions', old = from === 'github' ? 'GitHub Actions' : 'Google Apps Script';
  assert.equal(env.screen.busy, null);
  assert.match(switchSteps(env).at(-1) ?? '', new RegExp(`^Переключение: Переключение отменено: ${why.source} Воркер на ${old} остаётся активным, ` +
    `у нового на ${to} расписания нет\\. Переключите снова после следующего запуска воркера\\.$`));
  assert.ok(!switchSteps(env).some(step => /Гасим|Отзываем/.test(step)), 'the quench never began');
  const install = await env.mac.files.readInstall();
  assert.equal(install?.platform, from, 'the record names the old platform active again');
  assert.equal(install?.switching, undefined);
  assert.deepEqual(install?.accounts?.chatgpt, ACCOUNTS.chatgpt);
  stillActive(env, from);
  assert.deepEqual(env.breaches, []);
  assert.match(env.text(), new RegExp(`\\n● ${old} · активен\\n`));
}

test('while a switch is unfinished, apply-now refuses on the command line and on the screen: the new worker spends nothing', async () => {
  // GitHub → Google stops right after the record says `switching`, before the quench: the old
  // worker still has its schedule and its session, the new one its session.
  const env = await switchWorld('github');
  const { world, mac, press, text } = env;
  let failing = true;
  env.onRequest = request => {
    const prepared = switchSteps(env).includes('Переключение: У нового воркера своя сессия ChatGPT.');
    if (failing && prepared && request.method === 'GET' && request.url.pathname.endsWith('/runs')) return Promise.reject(new TypeError('fetch failed'));
  };
  await press(...TO_SWITCH, 'return');
  failing = false;
  assert.deepEqual((await mac.files.readInstall())?.switching, { from: 'github' });
  assert.equal((await mac.files.readInstall())?.platform, 'google');
  assert.ok(env.github().scheduled && env.github().live, 'the old worker is not quenched');
  assert.ok(env.google().live, 'the new worker has its session');
  assert.deepEqual(env.breaches, []);

  const consumed = world.consumeCalls().length;
  const cli = await env.run(applyNow, { answers: ['1', 'y'] });
  assert.equal(cli.code, 1);
  assert.match(cli.io.output(), /Переключение площадки не завершено: активного воркера нет, сбросы не применяются\./);
  assert.ok(!cli.io.output().includes('Применяем'), 'refused before the user picks a reset');

  await press('tab', 'return', 'y');
  assert.match(text(), /Переключение площадки не завершено: активного воркера нет, сбросы не применяются\./);
  assert.deepEqual(world.spent(), [], 'no reset is spent');
  assert.equal(world.consumeCalls().length, consumed, 'no consume request at all');
  assert.ok(!(JSON.parse(env.google().gas?.properties.get('journal') ?? '[]') as { kind: string }[]).some(entry => entry.kind === 'apply_now'));

  // «Повторить переключение» reads the old worker again: a pending application appeared meanwhile,
  // so the switch is undone instead of the quench.
  await pendingOnGitHub(env);
  await press('tab', 'return');
  await undone(env, 'github', /исход применения reset-c \(перед истечением\) ещё неизвестен\./);
});

test('a pending application that appears while the new worker is prepared undoes the switch before the quench (GitHub → Google)', async () => {
  const env = await switchWorld('github');
  whileSigningIn(env, () => pendingOnGitHub(env));
  await env.press(...TO_SWITCH, 'return');
  await undone(env, 'github', /исход применения reset-c \(перед истечением\) ещё неизвестен\./);
  assert.ok(env.google().live, 'the new worker is left prepared, without a schedule');

  // Once the next run settles it, the switch goes.
  await env.world.github.schedule();
  env.onRequest = null;
  await env.press('down', 'down', 'down', 'return');
  assert.deepEqual(env.active(), ['google']);
  assert.equal((await env.mac.files.readInstall())?.switching, undefined);
  assert.deepEqual(env.breaches, []);
});

test('a pending application that appears while the new worker is prepared undoes the switch before the quench (Google → GitHub)', async () => {
  const env = await switchWorld('google');
  whileSigningIn(env, () => {
    env.world.chatgpt.credits.push(credit('reset-c', env.world.now + 20 * MINUTE));
    env.world.chatgpt.lose = 'after';
    env.google().gas?.tick();
    env.world.chatgpt.lose = null;
  });
  await env.press(...TO_SWITCH, 'return');
  await undone(env, 'google', /исход применения reset-c \(перед истечением\) ещё неизвестен\./);
});

test('a run of the old worker under way on GitHub undoes the switch before the quench', async () => {
  const env = await switchWorld('github');
  const repo = env.github().repo;
  assert.ok(repo);
  const [last] = repo.runs;
  assert.ok(last);
  // The cron started a run while the user signed in; it publishes its summary only at its end.
  whileSigningIn(env, () => repo.runs.unshift({ ...last, id: last.id + 1000, event: 'schedule', status: 'in_progress', conclusion: null,
    display_title: 'Scheduled check' }));
  await env.press(...TO_SWITCH, 'return');
  await undone(env, 'github', /идёт запуск старого воркера\./);
});
