import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { timerFixture, TIMER_APP, TIMER_APP_KEY, INSTALLATION_TOKEN, checkAppJwt } from '../testing/timer-fixture.mjs';
import { compileSlots, windowSlots, DISCOVERY_CRON } from '../src/schedule-planner.mjs';
import { TIMER_PLAN_PATH, renderTimerPlan } from '../src/managed-schedule.mjs';
import { firstSlot } from '../src/schedule-time.mjs';
import worker, { tick } from '../worker/index.mjs';
import { appJwt, importAppKey } from '../src/timer-app.mjs';

const utc = value => Date.parse(value) / 1000;
// Δ = 1 hour window 10:20–11:20 UTC: planner slots 10:22…11:17 plus discovery.
const WINDOW = { start: utc('2026-10-14T10:20:00Z'), end: utc('2026-10-14T11:20:00Z') };
const PLAN = compileSlots(windowSlots([WINDOW]));
const stages = f => f.requests.map(r => r.stage);
const logged = f => {
  assert.equal(f.logs.length, 1);
  const text = f.logs[0];
  assert.ok(![INSTALLATION_TOKEN, TIMER_APP_KEY, 'secret-backend-detail', 'expressions'].some(x => text.includes(x)));
  return JSON.parse(text).autoResetTimer;
};

test('matching minute sends one empty workflow_dispatch on main to auto-reset.yml', async () => {
  const f = timerFixture({ expressions: PLAN });
  const record = await f.tick('2026-10-14T10:22:00Z');
  // The app JWT buys a narrow installation token first (signature checked by the fake GitHub).
  assert.deepEqual(stages(f), ['token', 'plan', 'repository', 'runs', 'dispatch']);
  assert.deepEqual(f.dispatches, [{ ref: 'main' }]);
  assert.ok(!('inputs' in f.dispatches[0]));
  assert.deepEqual(f.requests[3].query, { created: '2026-10-14T10:22:00Z..2026-10-14T10:26:59Z', per_page: '1' });
  assert.deepEqual(record, { slot: '2026-10-14T10:22:00Z', outcome: 'dispatched', problem: null, status: 200, runId: 4242, token: 'issued', subrequests: 5 });
  assert.deepEqual(logged(f), record);
});

test('non-matching minute reads only the plan and dispatches nothing', async () => {
  const f = timerFixture({ expressions: PLAN });
  for (const at of ['2026-10-14T09:57:00Z', '2026-10-14T10:23:00Z', '2026-10-15T10:22:00Z']) {
    f.requests.length = 0; f.logs.length = 0;
    const record = await f.tick(at);
    assert.equal(record.outcome, 'idle');
    assert.equal(record.subrequests, 2);
    assert.deepEqual(stages(f), ['token', 'plan']);
    assert.deepEqual(logged(f), record);
  }
  assert.deepEqual(f.dispatches, []);
});

test('window boundaries follow the planner grid and the nominal scheduledTime', async () => {
  const f = timerFixture({ expressions: PLAN });
  assert.equal(firstSlot(WINDOW.start), utc('2026-10-14T10:22:00Z'));
  const cases = [['2026-10-14T10:17:00Z', 'idle'], ['2026-10-14T10:22:00Z', 'dispatched'],
    ['2026-10-14T11:17:00Z', 'dispatched'], ['2026-10-14T11:22:00Z', 'idle'],
    // Cloudflare passes the nominal minute; sub-minute offsets keep the same slot.
    [Date.parse('2026-10-14T10:47:59.999Z'), 'dispatched'],
    // Discovery is part of the published plan and is woken the same way.
    ['2026-10-14T12:02:00Z', 'dispatched'], ['2026-10-14T13:02:00Z', 'idle']];
  for (const [at, outcome] of cases) assert.equal((await f.tick(at)).outcome, outcome, String(at));
  assert.equal(f.dispatches.length, 4);
  assert.ok(PLAN.includes(DISCOVERY_CRON));
});

test('empty plan dispatches nothing', async () => {
  const f = timerFixture({ expressions: [] });
  for (const at of ['2026-10-14T10:22:00Z', '2026-10-14T12:02:00Z']) assert.equal((await f.tick(at)).outcome, 'idle');
  assert.deepEqual(stages(f), ['token', 'plan', 'token', 'plan']);
  assert.deepEqual(f.dispatches, []);
});

test('damaged or foreign plan fails closed with a fixed kind', async () => {
  const valid = renderTimerPlan(PLAN), workflow = await readFile(new URL('../templates/private-auto-reset.yml', import.meta.url), 'utf8');
  assert.equal(timerFixture({ expressions: PLAN }).content, valid);
  const contents = [
    workflow, valid.trimEnd(), `${JSON.stringify({ schema: 1, expressions: PLAN }, null, 1)}\n`,
    valid.replace(`"${DISCOVERY_CRON}"`, '"*/5 * * * *"'),
    valid.replace(`"${DISCOVERY_CRON}"`, '"2 24 * * *"'),
    valid.replace('"schema":1', '"schema":2'),
    valid.replace('}', ',"extra":true}'),
    `${JSON.stringify({ schema: 1, expressions: [DISCOVERY_CRON, DISCOVERY_CRON] })}\n`,
    `${JSON.stringify({ schema: 1, expressions: DISCOVERY_CRON })}\n`, 'null\n',
  ];
  const files = [{ type: 'dir', path: TIMER_PLAN_PATH },
    { type: 'file', path: '.github/workflows/auto-reset.yml', encoding: 'base64', content: Buffer.from(valid).toString('base64') },
    { type: 'file', path: TIMER_PLAN_PATH, encoding: 'none', content: '' },
    { type: 'file', path: TIMER_PLAN_PATH, encoding: 'base64', content: '%%%' },
    { type: 'file', path: TIMER_PLAN_PATH, encoding: 'base64', content: Buffer.from([0xff, 0xfe]).toString('base64') }];
  const fixtures = [...contents.map(content => timerFixture({ content })),
    ...files.map(file => Object.assign(timerFixture({ expressions: PLAN }), { file }))];
  for (const f of fixtures) {
    const record = await f.tick('2026-10-14T10:22:00Z');
    assert.equal(record.outcome, 'failed');
    assert.equal(record.problem, 'plan_invalid');
    assert.deepEqual(stages(f), ['token', 'plan']);
    assert.deepEqual(f.dispatches, []);
    assert.deepEqual(logged(f), record);
  }
});

test('a run already created in the slot is not duplicated', async () => {
  const f = timerFixture({ expressions: PLAN });
  f.runs = 1;
  const record = await f.tick('2026-10-14T10:22:00Z');
  assert.equal(record.outcome, 'duplicate');
  assert.deepEqual(stages(f), ['token', 'plan', 'repository', 'runs']);
  assert.deepEqual(f.dispatches, []);
  f.runs = 0;
  assert.equal((await f.tick('2026-10-14T10:22:00Z')).outcome, 'dispatched');
  assert.equal(f.dispatches.length, 1);
});

test('GitHub 401/403/404/5xx and network errors at every stage fail closed without leaking', async () => {
  const kinds = { 401: 'github_unauthorized', 403: 'github_forbidden', 404: 'github_not_found', 500: 'github_unavailable',
    502: 'github_unavailable', 503: 'github_unavailable', 301: 'github_unexpected', 422: 'github_unexpected', network: 'github_unreachable' };
  // The token request names the app side: bad key or deleted App, removed installation, lost permission.
  const tokenKinds = { ...kinds, 401: 'app_unauthorized', 403: 'app_forbidden', 404: 'installation_not_found', 422: 'app_permissions_denied' };
  const order = ['token', 'plan', 'repository', 'runs', 'dispatch'];
  for (const [i, stage] of order.entries()) {
    for (const [status, kind] of Object.entries(stage === 'token' ? tokenKinds : kinds)) {
      const f = timerFixture({ expressions: PLAN });
      f.fail[stage] = status === 'network' ? status : Number(status);
      const record = await f.tick('2026-10-14T10:22:00Z');
      assert.equal(record.outcome, 'failed', `${stage} ${status}`);
      assert.equal(record.problem, kind);
      assert.deepEqual(stages(f), order.slice(0, i + 1));
      assert.equal(f.dispatches.length, 0);
      assert.deepEqual(logged(f), record);
    }
  }
});

test('wrong repository or default branch dispatches nothing', async () => {
  for (const [repo, problem] of [[{ default_branch: 'master' }, 'branch_mismatch'], [{ private: false }, 'repository_mismatch'],
    [{ full_name: 'synthetic/other' }, 'repository_mismatch'], [{ full_name: undefined }, 'repository_mismatch']]) {
    const f = timerFixture({ expressions: PLAN });
    Object.assign(f.repo, repo);
    const record = await f.tick('2026-10-14T10:22:00Z');
    assert.deepEqual([record.outcome, record.problem], ['failed', problem]);
    assert.deepEqual(stages(f), ['token', 'plan', 'repository']);
    assert.deepEqual(f.dispatches, []);
  }
});

test('unexpected runs answer fails closed; dispatch without run ID is reported, not repeated', async () => {
  const f = timerFixture({ expressions: PLAN });
  f.runs = null;
  assert.deepEqual([(await f.tick('2026-10-14T10:22:00Z')).problem, f.dispatches.length], ['github_unexpected', 0]);
  f.runs = 0; f.dispatchStatus = 204;
  const record = await f.tick('2026-10-14T10:22:00Z');
  assert.deepEqual([record.outcome, record.problem, record.runId, record.subrequests], ['dispatched', 'run_id_missing', null, 5]);
  assert.equal(f.dispatches.length, 1);
});

test('missing or invalid key, app IDs, repository or clock make no request', async () => {
  const env = { TIMER_APP_KEY, TIMER_APP_ID: '4242', TIMER_INSTALLATION_ID: '2424', REPOSITORY: 'synthetic/private' };
  const pkcs1 = TIMER_APP.privateKey.export({ type: 'pkcs1', format: 'pem' });
  for (const [change, problem] of [[{ TIMER_APP_KEY: undefined }, 'key_missing'], [{ TIMER_APP_KEY: '' }, 'key_missing'],
    [{ REPOSITORY: '' }, 'repository_invalid'], [{ REPOSITORY: 'synthetic/private/../x' }, 'repository_invalid'],
    [{ REPOSITORY: 'https://evil.example/x' }, 'repository_invalid'],
    [{ TIMER_APP_ID: '' }, 'app_invalid'], [{ TIMER_APP_ID: '0' }, 'app_invalid'], [{ TIMER_INSTALLATION_ID: '24x' }, 'app_invalid'],
    [{ TIMER_INSTALLATION_ID: '99999999999999999999' }, 'app_invalid'],
    // GitHub's PKCS#1 PEM must be converted first; a damaged key never reaches GitHub.
    [{ TIMER_APP_KEY: pkcs1 }, 'key_invalid'], [{ TIMER_APP_KEY: 'bm90IGEga2V5' }, 'key_invalid']]) {
    const f = timerFixture({ expressions: PLAN });
    f.env = { ...env, ...change };
    const record = await f.tick('2026-10-14T10:22:00Z');
    assert.deepEqual([record.outcome, record.problem, record.subrequests], ['failed', problem, 0], problem);
    assert.deepEqual(f.requests, []);
    assert.ok(![TIMER_APP_KEY, pkcs1].some(x => f.logs[0].includes(x)));
  }
  const f = timerFixture({ expressions: PLAN });
  assert.deepEqual([(await f.tick(Number.NaN)).problem, f.requests.length], ['clock_invalid', 0]);
});

test('a key pasted as PKCS#8 PEM works like the base64 line the installer writes', async () => {
  const f = timerFixture({ expressions: PLAN });
  f.env.TIMER_APP_KEY = TIMER_APP.privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal((await f.tick('2026-10-14T10:22:00Z')).outcome, 'dispatched');
});

test('app JWT is RS256 over WebCrypto, verifiable by the public key, with GitHub claims', async () => {
  const key = await importAppKey(TIMER_APP_KEY), now = Date.parse('2026-10-14T10:22:33Z') / 1000;
  const jwt = await appJwt({ appId: 4242, key, now });
  assert.deepEqual(checkAppJwt(`Bearer ${jwt}`, { now }), { iat: now - 60, exp: now + 540, iss: '4242' });
  const other = createPrivateKey(TIMER_APP.privateKey.export({ type: 'pkcs1', format: 'pem' })); // Same key, another encoding.
  assert.equal(other.asymmetricKeyType, 'rsa');
  const stranger = (await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
  assert.throws(() => checkAppJwt(`Bearer ${jwt}`, { now, publicKey: stranger }), /JWT signature/);
});

test('installation token is cached for its life, renewed five minutes early and dropped when rejected', async () => {
  const f = timerFixture({ expressions: PLAN });
  f.cache = new Map();
  const first = await f.tick('2026-10-14T09:57:00Z');
  assert.deepEqual([first.outcome, first.token, first.subrequests], ['idle', 'issued', 2]);
  // Later ticks within the hour cost one subrequest and send the same token.
  for (const at of ['2026-10-14T10:02:00Z', '2026-10-14T10:22:00Z', '2026-10-14T10:47:00Z']) {
    const record = await f.tick(at);
    assert.equal(record.token, 'cached', at);
  }
  assert.equal(stages(f).filter(x => x === 'token').length, 1);
  assert.equal(f.dispatches.length, 2);
  // Issued at 09:57:33 for an hour: from 10:52:33 on it is renewed.
  assert.equal((await f.tick('2026-10-14T10:52:00Z')).token, 'issued');
  assert.equal(stages(f).filter(x => x === 'token').length, 2);
  // A cached token GitHub rejects (revoked, App narrowed) is not reused for the rest of its hour.
  f.fail.plan = 401;
  assert.deepEqual([(await f.tick('2026-10-14T10:57:00Z')).problem, f.cache.size], ['github_unauthorized', 0]);
  delete f.fail.plan;
  assert.equal((await f.tick('2026-10-14T11:02:00Z')).token, 'issued');
  // A failure that says nothing about the token keeps it.
  f.fail.plan = 503; await f.tick('2026-10-14T11:07:00Z');
  assert.equal(f.cache.size, 1);
  // Each app and installation has its own entry: another installation asks for its own token.
  f.env.TIMER_INSTALLATION_ID = '2425'; delete f.fail.plan;
  await f.tick('2026-10-14T11:12:00Z');
  assert.deepEqual(f.requests.at(-1), { stage: 'token', method: 'POST', path: '/app/installations/2425/access_tokens', query: {} });
});

test('scheduled handler uses controller.scheduledTime', async () => {
  const f = timerFixture({ expressions: PLAN });
  const fetch = globalThis.fetch, log = console.log;
  globalThis.fetch = f.fetchImpl; console.log = line => f.logs.push(line); f.now = Math.floor(Date.now() / 1000);
  try { await worker.scheduled({ scheduledTime: Date.parse('2026-10-14T10:22:00Z'), cron: '2-57/5 * * * *' }, f.env); }
  finally { globalThis.fetch = fetch; console.log = log; }
  assert.deepEqual(f.dispatches, [{ ref: 'main' }]);
  assert.deepEqual(Object.keys(worker), ['scheduled']);
  assert.equal(typeof tick, 'function');
});

test('wrangler config pins the planner grid, has no secrets and the deploy guide pins Wrangler', async () => {
  const toml = await readFile(new URL('../worker/wrangler.toml', import.meta.url), 'utf8');
  assert.deepEqual([...toml.matchAll(/^crons = (.+)$/gm)].map(m => JSON.parse(m[1])), [['2-57/5 * * * *']]);
  const minutes = Array.from({ length: 60 }, (_, m) => m).filter(m => firstSlot(m * 60) === m * 60);
  assert.deepEqual(minutes, Array.from({ length: 12 }, (_, i) => 2 + 5 * i));
  assert.match(toml, /^main = "index\.mjs"$/m);
  assert.match(toml, /^workers_dev = false$/m);
  for (const name of ['REPOSITORY', 'TIMER_APP_ID', 'TIMER_INSTALLATION_ID']) assert.match(toml, new RegExp(`^${name} = ""$`, 'm'));
  assert.ok(!/TOKEN|github_pat_|ghp_/.test(toml));
  const guide = await readFile(new URL('../worker/README.md', import.meta.url), 'utf8');
  const versions = [...guide.matchAll(/wrangler@([^\s`]+)/g)].map(m => m[1]);
  assert.ok(versions.length >= 2);
  assert.deepEqual([...new Set(versions)], ['4.139.0']);
  assert.match(guide, /secret put TIMER_APP_KEY/);
});

test('Worker bundle imports only dependency-free repository modules', async () => {
  const seen = new Set(), queue = [new URL('../worker/index.mjs', import.meta.url)];
  while (queue.length) {
    const url = queue.pop();
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const source = await readFile(url, 'utf8');
    for (const [, specifier] of source.matchAll(/^(?:import|export)\b[^'"\n]*?from\s+'([^']+)'/gm)) {
      assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), `${url.pathname}: ${specifier}`);
      queue.push(new URL(specifier, url));
    }
    assert.ok(!/\bBuffer\b|\bprocess\.|import\(/.test(source), url.pathname);
  }
  assert.deepEqual([...seen].map(href => href.split('/').slice(-2).join('/')).sort(),
    ['src/managed-schedule.mjs', 'src/schedule-time.mjs', 'src/state-failure.mjs', 'src/timer-app.mjs', 'worker/index.mjs']);
});
