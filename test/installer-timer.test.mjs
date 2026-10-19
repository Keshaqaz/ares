import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { privateWorkflowFixture, PROGRAM_COMMIT, confirmedTimer } from './support/private-workflow-fixture.mjs';
import { hostBytes, NOW } from './support/host-auth-fixture.mjs';
import { syntheticGrant } from './support/auth-fixture.mjs';
import { makeBundle, encodeBundle } from '../src/session/auth-bundle.mjs';
import { HostAuthSession } from '../src/session/host-auth-session.mjs';
import { runInstallerAdmin, sealAdmin } from '../src/installer/installer-admin.mjs';
import { renderInstallerReport } from '../src/installer/installer-report.mjs';
import { compileSlots, TIMER_GRACE_SECONDS, TIMER_PROBE_LEAD_SECONDS, timerProbeSlot } from '../src/schedule/schedule-planner.mjs';
import { CADENCE } from '../src/schedule/schedule-time.mjs';
import { TIMER_PLAN_PATH } from '../src/schedule/managed-schedule.mjs';
import { Installer } from '../src/installer/installer.mjs';
import { TerminalUI, messages, promptTimerSetup, timerNotice, timerRows } from '../src/installer/installer-ui.mjs';
import { WRANGLER, appManifest, appInstallUrl, appSettingsUrl, deleteTimerTokenSecret, deleteTimerWorker, deployTimerWorker,
  findInstallation, pkcs8Key, registerTimerApp, verifyTimerAccess } from '../src/installer/installer-timer.mjs';
import { importAppKey } from '../src/schedule/timer-app.mjs';
import { validateState } from '../src/core/state-store.mjs';
import { TIMER_APP, TIMER_APP_KEY, checkAppJwt } from './support/timer-fixture.mjs';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const DAY = 86400;
const evidence = { clientPath: true, costPolicy: true, persistence: true };
// What crosses the sealed envelope: the timer app IDs and slug, never its key.
const APP = { appId: 4242, appSlug: 'auto-reset-timer-synthetic', installationId: 2424 };
const PKCS1 = TIMER_APP.privateKey.export({ type: 'pkcs1', format: 'pem' });

// Paused, seeded and checked installation without a timer: the state ticket 38 starts from.
async function fixture(t) {
  const f = await privateWorkflowFixture(t); let sequence = 0;
  f.adminCommand = (action, payload = {}) => sealAdmin('synthetic/private', syntheticGrant,
    { action, commandId: `timer-${++sequence}`, expectedVersion: f.github.state.version }, payload);
  f.admin = (command, extra = {}) => f.actions.writer(() => runInstallerAdmin({ storage: f.github.storage,
    serialization: f.serialization, workflow: f.workflow, grant: syntheticGrant, snapshot: f.github.secret,
    command, programCommit: PROGRAM_COMMIT, pilotApproved: true, now: () => f.clock,
    sessionFactory: snapshot => new HostAuthSession({ store: f.github.storage, secrets: f.github.storage,
      serialization: f.serialization, oauth: f.oauth, vault: f.vault, runtime: f.external,
      snapshot, grant: syntheticGrant, owner: 'timer-test', now: () => f.clock }), ...extra }));
  f.enable = () => f.adminCommand('enable', { evidence, quotaReceipt: { observedAt: f.clock, quota: f.quota } });
  f.wake = (options = {}) => f.actions.writer(() => f.job({ event: 'workflow_dispatch', live: false, ...options }));
  await f.admin(f.adminCommand('pause'));
  await f.admin(f.adminCommand('seed', { bundle: encodeBundle(makeBundle(hostBytes(1), { protocol: 2 })) }));
  await f.admin(f.adminCommand('check'));
  return f;
}

test('timer step publishes one probe slot; only the empty dispatch woken in it confirms the timer and unlocks enable', async t => {
  const f = await fixture(t);
  await assert.rejects(f.admin(f.enable()), /timer_confirmation_required/);
  const before = f.calls().length, command = f.adminCommand('timer', APP);
  await f.admin(command);
  const probeAt = timerProbeSlot(NOW), timer = f.github.state.installation.timer;
  assert.deepEqual(timer, { ...APP, probeAt, confirmedAt: null });
  assert.ok(probeAt >= NOW + TIMER_PROBE_LEAD_SECONDS && probeAt < NOW + TIMER_PROBE_LEAD_SECONDS + CADENCE);
  // The Worker reads exactly this plan: the probe minute and nothing else while paused.
  assert.deepEqual(f.schedule.expressions(), compileSlots([probeAt], { discovery: false }));
  assert.equal(f.github.state.disabled, true);
  const report = await f.actions.writer(() => renderInstallerReport(f.github.storage, command, { phase: 'done' }, () => f.clock));
  assert.match(report, new RegExp(`Пробный слот: ${new Date(probeAt * 1000).toISOString()}`));
  await assert.rejects(f.admin(f.enable()), /timer_confirmation_required/);

  // An empty run before the slot (e.g. a manual one) wakes the installation but proves nothing.
  f.clock = probeAt - 60; await f.wake();
  assert.equal(f.github.state.installation.timer.confirmedAt, null);
  assert.equal(f.github.state.scheduler.wokenAt, probeAt - 60);
  assert.deepEqual(f.schedule.expressions(), compileSlots([probeAt], { discovery: false }));

  f.clock = probeAt + 37; await f.wake(); // E1: runs start 36–39 s after the minute.
  assert.equal(f.github.state.installation.timer.confirmedAt, probeAt + 37);
  assert.equal(f.github.state.scheduler.wokenAt, probeAt + 37);
  assert.deepEqual(f.schedule.expressions(), []); // The confirmed probe leaves the plan.
  assert.equal(f.calls().length, before); // Wake-only: no account access before enable.

  await f.admin(f.enable());
  assert.equal(f.github.state.disabled, false); assert.equal(f.github.state.scheduler.mode, 'active');
});

test('missed probe expires from the plan, a late wake does not confirm it, and a repeated step issues a new slot', async t => {
  const f = await fixture(t);
  await f.admin(f.adminCommand('timer', APP));
  const probeAt = f.github.state.installation.timer.probeAt;
  // The daily fallback after the slot republishes without the probe.
  f.clock = probeAt + CADENCE; await f.actions.writer(() => f.job({ event: 'schedule' }));
  assert.deepEqual(f.schedule.expressions(), []);
  f.clock = probeAt + TIMER_GRACE_SECONDS; await f.wake();
  assert.equal(f.github.state.installation.timer.confirmedAt, null);
  await assert.rejects(f.admin(f.enable()), /timer_confirmation_required/);
  await f.admin(f.adminCommand('timer', APP));
  assert.equal(f.github.state.installation.timer.probeAt, timerProbeSlot(f.clock));
  assert.deepEqual(f.schedule.expressions(), compileSlots([timerProbeSlot(f.clock)], { discovery: false }));
});

test('timer step requires pause and exactly the app IDs and slug; enable checks no expiry', async t => {
  const f = await fixture(t);
  // An installer before 42 sends a token expiry; a key, string IDs or a foreign slug never pass.
  for (const payload of [{}, { expiresAt: NOW + DAY }, { ...APP, expiresAt: NOW + DAY }, { ...APP, key: TIMER_APP_KEY },
    { ...APP, appId: '4242' }, { ...APP, installationId: 0 }, { ...APP, appSlug: 'Auto Reset' }, { ...APP, appSlug: '' },
    { appId: APP.appId, installationId: APP.installationId }]) {
    await assert.rejects(f.admin(f.adminCommand('timer', payload)), /invalid_command/, JSON.stringify(payload));
  }
  assert.equal(f.github.state.installation.timer, undefined); assert.deepEqual(f.schedule.expressions(), []);
  await f.actions.writer(() => f.github.storage.update(v => { v.installation.timer = confirmedTimer(f.clock); }));
  await f.admin(f.enable());
  await assert.rejects(f.admin(f.adminCommand('timer', APP)), /durable_disable_required/);
  assert.deepEqual(f.github.state.installation.timer, confirmedTimer(NOW));
  for (const timer of [{ ...confirmedTimer(NOW), expiresAt: NOW }, { ...confirmedTimer(NOW), key: 'x' }, { ...confirmedTimer(NOW), appId: 0 },
    { expiresAt: NOW, probeAt: null, confirmedAt: null, appId: 1 }]) {
    assert.throws(() => validateState({ ...f.github.state, installation: { ...f.github.state.installation, timer } }), /state|invalid/, JSON.stringify(timer));
  }
});

test('a timer still on the token (38) keeps working until c replaces it with the app and a new probe', async t => {
  const f = await fixture(t);
  // State written by ticket 38: a confirmed timer token that has already expired.
  const legacy = { expiresAt: NOW - DAY, probeAt: NOW - 1800, confirmedAt: NOW - 1760 };
  await f.actions.writer(() => f.github.storage.update(v => { v.installation.timer = legacy; }));
  assert.equal(timerNotice(legacy, 'ru'), messages.ru.timerLegacy.replace('{date}', new Date(legacy.expiresAt * 1000).toISOString()));
  assert.match(timerNotice(legacy, 'en'), /old timer token.*7 Pause → c → 6/);
  assert.equal(timerRows({ installation: { timer: legacy } })[2][1], `timer token until ${new Date(legacy.expiresAt * 1000).toISOString()} (c)`);
  await f.admin(f.enable()); // No expiry gate any more: a dead token shows up as external_timer_stale.
  await f.admin(f.adminCommand('pause'));
  await f.admin(f.adminCommand('timer', APP));
  assert.deepEqual(f.github.state.installation.timer, { ...APP, probeAt: timerProbeSlot(NOW), confirmedAt: null });
  assert.equal(timerNotice(f.github.state.installation.timer, 'ru'), null);
  await assert.rejects(f.admin(f.enable()), /timer_confirmation_required/);
  f.clock = timerProbeSlot(NOW) + 37; await f.wake();
  await f.admin(f.enable());
  assert.equal(f.github.state.disabled, false);
});

test('pause abandons a pending probe so cleanup confirms an empty plan; uninstall forgets the timer', async t => {
  const f = await fixture(t);
  await f.admin(f.adminCommand('timer', APP));
  assert.equal(f.schedule.expressions().length, 1);
  await f.admin(f.adminCommand('pause'));
  assert.deepEqual(f.schedule.expressions(), []);
  assert.deepEqual(f.github.state.installation.timer, { ...APP, probeAt: null, confirmedAt: null });
  f.clock = timerProbeSlot(NOW) + 37; await f.wake(); // The Worker no longer sees it; a stray wake cannot confirm.
  assert.equal(f.github.state.installation.timer.confirmedAt, null);
  await f.admin(f.adminCommand('timer', APP));
  const api = f.github.storage.api.bind(f.github.storage); // As in installer.test: the PAT Secret DELETE is not simulated.
  f.github.storage.api = (path, opts) => path === '/actions/secrets/AUTO_RESET_GITHUB_TOKEN' ? Promise.resolve(null) : api(path, opts);
  await f.admin(f.adminCommand('uninstall'));
  assert.equal(f.github.state.installation.timer, null);
  assert.deepEqual(f.schedule.expressions(), []); assert.equal(f.schedule.workflowDisabled, true);
});

test('an empty dispatch before pilot approval never reads the account, even on an enabled installation', async t => {
  const f = await fixture(t);
  await f.actions.writer(() => f.github.storage.update(v => { v.installation.timer = confirmedTimer(f.clock); }));
  await f.admin(f.adminCommand('select', { selection: { creditId: 'selected-017', deltaSeconds: 3600 } }));
  await f.admin(f.enable()); f.rpc.state.outcome = 'reset';
  const before = f.calls().length;
  await f.wake();
  assert.equal(f.calls().length, before); assert.deepEqual(f.github.state.requests, []);
  assert.equal(f.github.state.scheduler.wokenAt, f.clock);
  await f.wake({ live: true });
  assert.ok(f.calls().length > before); // The same wake with approval runs the due attempt.
});

test('local installer sends only the app IDs and slug, requires pause and refuses enable before a confirmed timer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'installer-timer-')); t.after(() => rm(root, { recursive: true, force: true }));
  const state = { version: 2, disabled: false, commands: [], installation: { quota: { verified: true } } }; let dispatched = null;
  const installer = new Installer({ platform: 'darwin', journalPath: join(root, 'journal.json'),
    github: { repository: 'synthetic/private', token: syntheticGrant, status: async () => state,
      dispatch: async c => { dispatched = c; return { state: 'unconfirmed' }; } } });
  await assert.rejects(installer.timer({ ...APP, key: TIMER_APP_KEY }), /pause_before_timer_setup/);
  state.disabled = true; await installer.timer({ ...APP, key: TIMER_APP_KEY });
  assert.equal(dispatched.action, 'timer'); assert.equal(dispatched.expectedVersion, 2);
  const journal = await readFile(installer.journalPath, 'utf8');
  assert.ok(!journal.includes(TIMER_APP_KEY) && !journal.includes(TIMER_APP_KEY.slice(0, 40)));
  installer.journal.pending = null; dispatched = null;
  await assert.rejects(installer.enable(evidence), /timer_confirmation_required/);
  // A confirmed timer token past its date no longer blocks enable locally.
  state.installation.timer = { expiresAt: NOW - DAY, probeAt: NOW - 600, confirmedAt: NOW - 560 };
  await installer.enable(evidence); assert.equal(dispatched.action, 'enable');
});

test('timer app manifest: own account, two permissions, webhook placeholder off, loopback redirect', () => {
  const m = appManifest({ repository: 'synthetic/private', redirectUrl: 'http://127.0.0.1:5555/callback', suffix: 'abc123' });
  assert.deepEqual(m, { name: 'auto-reset-timer-abc123', url: 'https://github.com/synthetic/private', public: false,
    description: 'External timer of synthetic/private: starts the auto-reset workflow and reads the window plan.',
    hook_attributes: { url: 'https://example.invalid/auto-reset-timer', active: false },
    redirect_url: 'http://127.0.0.1:5555/callback', default_permissions: { actions: 'write', contents: 'read' }, default_events: [] });
  assert.ok(m.name.length <= 34); // GitHub App names are limited to 34 characters.
  assert.match(appManifest({ repository: 'synthetic/private', redirectUrl: 'x' }).name, /^auto-reset-timer-[0-9a-f]{6}$/);
  assert.equal(appInstallUrl('auto-reset-timer-abc123'), 'https://github.com/apps/auto-reset-timer-abc123/installations/new');
  assert.equal(appSettingsUrl('auto-reset-timer-abc123'), 'https://github.com/settings/apps/auto-reset-timer-abc123/advanced');
});

// Fake GitHub for the code exchange: 201 like ticket 39, with the PKCS#1 pem and the secrets we drop.
const exchangeFetch = ({ status = 201, owner = 'Synthetic', body = {} } = {}) => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, method: options.method, authorization: options.headers.authorization, redirect: options.redirect });
    return status === 201 ? Response.json({ id: 4242, slug: 'auto-reset-timer-abc123', name: 'auto-reset-timer-abc123', pem: PKCS1,
      client_id: 'Iv1.synthetic', client_secret: 'synthetic-client-secret', webhook_secret: 'synthetic-webhook-secret',
      owner: { login: owner, type: 'User' }, permissions: { actions: 'write', contents: 'read', metadata: 'read' }, events: [], ...body }, { status })
      : new Response(null, { status });
  };
  return { fetchImpl, seen };
};
// Plays the browser: loads the local page, reads the form GitHub would receive, then follows the redirect.
async function browse(base) {
  const page = await (await fetch(`${base}/`)).text();
  const action = /action="([^"]+)"/.exec(page)[1].replaceAll('&amp;', '&');
  const manifest = JSON.parse(/name="manifest" value="([^"]+)"/.exec(page)[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
  return { page, action, manifest, state: new URL(action).searchParams.get('state') };
}

test('manifest flow on loopback: random port, state check, one code exchange, key converted in memory', async () => {
  const github = exchangeFetch(); let opened = null, listened = null;
  const pending = registerTimerApp({ repository: 'synthetic/private', fetchImpl: github.fetchImpl, open: url => { opened = url; }, onListen: base => { listened = base; } });
  while (!opened) await new Promise(resolve => setTimeout(resolve, 5));
  const base = opened.slice(0, -1);
  assert.match(opened, /^http:\/\/127\.0\.0\.1:\d+\/$/); assert.equal(listened, base);
  const form = await browse(base);
  assert.match(form.page, /document\.forms\[0\]\.submit\(\)/); // Auto-submit: the user only clicks Create.
  assert.equal(new URL(form.action).origin + new URL(form.action).pathname, 'https://github.com/settings/apps/new');
  assert.match(form.state, /^[0-9a-f]{32}$/);
  assert.equal(form.manifest.redirect_url, `${base}/callback`);
  assert.deepEqual(form.manifest.default_permissions, { actions: 'write', contents: 'read' });
  assert.deepEqual(form.manifest.hook_attributes, { url: 'https://example.invalid/auto-reset-timer', active: false });
  // A foreign state, a malformed code, another path or method never reach the exchange.
  for (const [path, method] of [[`/callback?code=abc&state=${'0'.repeat(32)}`, 'GET'], [`/callback?code=a%2Fb&state=${form.state}`, 'GET'],
    [`/other?code=abc&state=${form.state}`, 'GET'], [`/callback?code=abc&state=${form.state}`, 'POST']]) {
    assert.ok([400, 405].includes((await fetch(`${base}${path}`, { method })).status), path);
  }
  assert.equal(github.seen.length, 0);
  const done = await fetch(`${base}/callback?code=synthetic-code&state=${form.state}`);
  assert.equal(done.status, 200); assert.match(await done.text(), /Return to the terminal/);
  const app = await pending;
  assert.deepEqual(github.seen, [{ url: 'https://api.github.com/app-manifests/synthetic-code/conversions', method: 'POST', authorization: undefined, redirect: 'manual' }]);
  assert.deepEqual(Object.keys(app).sort(), ['appId', 'key', 'slug']);
  assert.deepEqual([app.appId, app.slug], [4242, 'auto-reset-timer-abc123']);
  assert.match(app.key, /^[A-Za-z0-9+/]+=*$/); // One base64 line of PKCS#8 DER; the client and webhook secrets are dropped.
  assert.ok(!JSON.stringify(app).includes('synthetic-client-secret') && !JSON.stringify(app).includes('BEGIN'));
  await assert.rejects(fetch(`${base}/`)); // The server is closed after the exchange.
});

test('manifest flow fails closed: another account, failed exchange, timeout', async () => {
  const run = async (github, timeoutMs = 60_000) => {
    let opened = null;
    const pending = registerTimerApp({ repository: 'synthetic/private', fetchImpl: github.fetchImpl, timeoutMs, open: url => { opened = url; } });
    pending.catch(() => {});
    while (!opened) await new Promise(resolve => setTimeout(resolve, 5));
    return { pending, base: opened.slice(0, -1) };
  };
  // The browser was signed in as someone else: the App exists there and is reported for deletion.
  const other = await run(exchangeFetch({ owner: 'someone-else' }));
  await fetch(`${other.base}/callback?code=c&state=${(await browse(other.base)).state}`);
  await assert.rejects(other.pending, error => error.kind === 'timer_app_owner_mismatch' && error.app.slug === 'auto-reset-timer-abc123' && !error.app.key);
  for (const [github, slug] of [[exchangeFetch({ status: 422 }), null], [exchangeFetch({ body: { pem: 'not a key' } }), 'auto-reset-timer-abc123'],
    [exchangeFetch({ body: { slug: 'Bad Slug' } }), null]]) {
    const failed = await run(github);
    await fetch(`${failed.base}/callback?code=c&state=${(await browse(failed.base)).state}`);
    await assert.rejects(failed.pending, error => error.kind === 'timer_app_exchange_failed' && (error.app?.slug ?? null) === slug);
  }
  // A second redirect racing the first exchange is refused: one code, one exchange.
  let release; const slow = exchangeFetch(), gate = new Promise(resolve => { release = resolve; });
  const raced = await run({ fetchImpl: async (...args) => { await gate; return slow.fetchImpl(...args); } });
  const raceState = (await browse(raced.base)).state;
  const first = fetch(`${raced.base}/callback?code=c1&state=${raceState}`);
  await new Promise(resolve => setTimeout(resolve, 20));
  const second = await fetch(`${raced.base}/callback?code=c2&state=${raceState}`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  release(); assert.equal(second?.status, 400); assert.equal((await first).status, 200); await raced.pending;
  assert.deepEqual(slow.seen.map(x => x.url), ['https://api.github.com/app-manifests/c1/conversions']);
  const offline = await run({ fetchImpl: async () => { throw new Error('offline'); } });
  await fetch(`${offline.base}/callback?code=c&state=${(await browse(offline.base)).state}`);
  await assert.rejects(offline.pending, /timer_github_unreachable/);
  await assert.rejects((await run(exchangeFetch(), 30)).pending, /timer_app_timeout/);
});

test('PKCS#1 key from GitHub becomes PKCS#8 that WebCrypto imports and that signs for the same public key', async () => {
  const key = pkcs8Key(PKCS1);
  assert.equal(key, TIMER_APP_KEY);
  const der = Buffer.from(key, 'base64');
  assert.equal(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }).asymmetricKeyType, 'rsa');
  assert.deepEqual(createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ type: 'spki', format: 'der' }),
    TIMER_APP.publicKey.export({ type: 'spki', format: 'der' }));
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await importAppKey(key), new TextEncoder().encode('probe'));
  assert.ok(verify('sha256', Buffer.from('probe'), TIMER_APP.publicKey, Buffer.from(signature)));
  assert.deepEqual(Buffer.from(signature), sign('sha256', Buffer.from('probe'), TIMER_APP.privateKey)); // PKCS#1 v1.5 is deterministic.
  const armor = label => `${'-'.repeat(5)}${label} RSA PRIVATE KEY${'-'.repeat(5)}`; // No literal armor: release secret scan.
  assert.throws(() => pkcs8Key(`${armor('BEGIN')}\nAAAA\n${armor('END')}\n`));
  await assert.rejects(importAppKey(PKCS1), /key_invalid/);
});

// Fake GitHub for the installation: JWT routes are checked by the public key, token routes by the token.
const appFetch = ({ installation = {}, status = {}, repo = {}, token = 'synthetic-installation-token' } = {}) => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    const u = new URL(url), path = u.pathname + u.search, stage = path === '/repos/synthetic/private/installation' ? 'installation' :
      path.startsWith('/app/') ? 'token' : path === '/installation/token' ? 'revoke' : path.includes('.auto-reset-installation.json') ? 'marker' :
        path.includes('/contents/') ? 'plan' : 'repo';
    seen.push({ stage, method: options.method, path, body: options.body && JSON.parse(options.body) });
    if (['installation', 'token'].includes(stage)) checkAppJwt(options.headers.authorization, { now: NOW });
    else assert.equal(options.headers.authorization, `Bearer ${token}`);
    if (status[stage]) return new Response(null, { status: status[stage] });
    if (stage === 'installation') return Response.json({ id: 2424, app_id: 4242, repository_selection: 'selected', account: { login: 'synthetic' }, ...installation });
    if (stage === 'token') return Response.json({ token, expires_at: new Date((NOW + 3600) * 1000).toISOString() }, { status: 201 });
    if (stage === 'revoke') return new Response(null, { status: 204 });
    if (stage === 'marker') return Response.json({ type: 'file', path: '.auto-reset-installation.json' });
    if (stage === 'plan') return Response.json({ type: 'file', path: TIMER_PLAN_PATH });
    return Response.json({ private: true, full_name: 'Synthetic/Private', default_branch: 'main', ...repo });
  };
  return { fetchImpl, seen };
};
const appArgs = { repository: 'synthetic/private', appId: 4242, installationId: 2424, key: TIMER_APP_KEY, now: () => NOW };

test('installation ID is found with the app JWT; installation on all repos is reported, not refused', async () => {
  const ok = appFetch();
  assert.deepEqual(await findInstallation({ ...appArgs, fetchImpl: ok.fetchImpl }), { installationId: 2424, selection: 'selected' });
  assert.deepEqual(ok.seen.map(x => [x.stage, x.method]), [['installation', 'GET']]);
  assert.deepEqual(await findInstallation({ ...appArgs, fetchImpl: appFetch({ installation: { repository_selection: 'all' } }).fetchImpl }),
    { installationId: 2424, selection: 'all' });
  for (const [options, error] of [[{ status: { installation: 404 } }, /timer_app_not_installed/], [{ installation: { app_id: 1 } }, /timer_app_not_installed/],
    [{ status: { installation: 401 } }, /timer_app_unauthorized/], [{ status: { installation: 502 } }, /timer_github_unavailable/]]) {
    await assert.rejects(findInstallation({ ...appArgs, fetchImpl: appFetch(options).fetchImpl }), error);
  }
  await assert.rejects(findInstallation({ ...appArgs, key: PKCS1, fetchImpl: ok.fetchImpl }), /key_invalid/);
});

test('timer access is checked like the Worker reads: narrow token, repo and plan, then the token is revoked', async () => {
  const ok = appFetch();
  await verifyTimerAccess({ ...appArgs, fetchImpl: ok.fetchImpl });
  assert.deepEqual(ok.seen.map(x => [x.stage, x.method ?? 'GET']), [['token', 'POST'], ['repo', 'GET'], ['plan', 'GET'], ['revoke', 'DELETE']]);
  assert.equal(ok.seen[0].path, '/app/installations/2424/access_tokens');
  assert.deepEqual(ok.seen[0].body, { repositories: ['private'], permissions: { actions: 'write', contents: 'read' } });
  assert.equal(ok.seen[2].path, `/repos/synthetic/private/contents/${TIMER_PLAN_PATH}?ref=main`);
  // An Upgrade from a pin before 37 has no plan yet: Contents read is proven by the marker.
  const absent = appFetch({ status: { plan: 404 } });
  await verifyTimerAccess({ ...appArgs, fetchImpl: absent.fetchImpl });
  assert.deepEqual(absent.seen.map(x => x.stage), ['token', 'repo', 'plan', 'marker', 'revoke']);
  for (const [options, error, revoked] of [[{ status: { token: 422 } }, /timer_app_permissions_denied/, false],
    [{ status: { token: 404 } }, /timer_app_not_installed/, false], [{ status: { token: 401 } }, /timer_app_unauthorized/, false],
    [{ status: { repo: 404 } }, /timer_app_repository_denied/, true], [{ status: { plan: 403 } }, /timer_app_contents_denied/, true],
    [{ status: { plan: 404, marker: 404 } }, /timer_app_contents_denied/, true], [{ repo: { private: false } }, /private_repository_required/, true],
    [{ repo: { full_name: 'other/private' } }, /private_repository_required/, true], [{ repo: { default_branch: 'master' } }, /timer_requires_main_branch/, true],
    [{ status: { repo: 301 } }, /timer_github_unavailable/, true]]) {
    const f = appFetch(options);
    await assert.rejects(verifyTimerAccess({ ...appArgs, fetchImpl: f.fetchImpl }), error);
    assert.equal(f.seen.at(-1).stage === 'revoke', revoked, String(error)); // A token once issued is always revoked.
  }
  await assert.rejects(verifyTimerAccess({ ...appArgs, fetchImpl: async () => { throw new Error('offline'); } }), /timer_github_unreachable/);
});

const fakeSpawn = (codes = []) => {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter(), call = { file, args, options, input: null };
    if (options.stdio[0] === 'pipe') { child.stdin = new PassThrough(); child.stdin.on('data', b => { call.input = (call.input ?? '') + b; }); }
    calls.push(call); queueMicrotask(() => child.emit('close', codes.shift() ?? 0)); return child;
  };
  return { calls, spawnImpl };
};

test('Wrangler deploy pins the version, passes repo and app IDs as vars and the key only through stdin', async () => {
  const w = fakeSpawn();
  await deployTimerWorker({ repository: 'synthetic/private', appId: 4242, installationId: 2424, key: TIMER_APP_KEY, root: '/program', spawnImpl: w.spawnImpl });
  assert.deepEqual(w.calls.map(c => [c.file, ...c.args]), [
    ['npx', '--yes', WRANGLER, 'deploy', '--var', 'REPOSITORY:synthetic/private', '--var', 'TIMER_APP_ID:4242',
      '--var', 'TIMER_INSTALLATION_ID:2424', '--config', 'src/worker/wrangler.toml'],
    ['npx', '--yes', WRANGLER, 'secret', 'put', 'TIMER_APP_KEY', '--config', 'src/worker/wrangler.toml']]);
  assert.equal(WRANGLER, 'wrangler@4.139.0');
  assert.ok(w.calls.every(c => c.options.cwd === '/program' && c.options.env === undefined));
  assert.equal(w.calls[0].options.stdio[0], 'inherit'); assert.equal(w.calls[1].input, TIMER_APP_KEY);
  assert.ok(!JSON.stringify(w.calls.map(c => [c.args, c.options])).includes(TIMER_APP_KEY.slice(0, 40)));
  const failed = fakeSpawn([1]);
  await assert.rejects(deployTimerWorker({ ...APP, repository: 'synthetic/private', key: 'k', root: '/p', spawnImpl: failed.spawnImpl }), /timer_wrangler_failed/);
  assert.equal(failed.calls.length, 1); // No key for a Worker that did not deploy.
  await assert.rejects(deployTimerWorker({ ...APP, repository: 'bad repo', key: 'k', root: '/p', spawnImpl: failed.spawnImpl }), /repository_invalid/);
  await assert.rejects(deployTimerWorker({ ...APP, appId: '4242', repository: 'synthetic/private', key: 'k', root: '/p', spawnImpl: failed.spawnImpl }), /invalid_command/);
  const migrated = fakeSpawn(); await deleteTimerTokenSecret({ root: '/program', spawnImpl: migrated.spawnImpl });
  assert.deepEqual(migrated.calls[0].args, ['--yes', WRANGLER, 'secret', 'delete', 'TIMER_TOKEN', '--config', 'src/worker/wrangler.toml']);
  assert.equal(migrated.calls[0].options.stdio[0], 'inherit'); // Wrangler asks the user to confirm.
  const removed = fakeSpawn(); await deleteTimerWorker({ root: '/program', spawnImpl: removed.spawnImpl });
  assert.deepEqual(removed.calls[0].args, ['--yes', WRANGLER, 'delete', '--config', 'src/worker/wrangler.toml']);
});

// The step with fakes for GitHub and Wrangler; answers are typed lines.
const timerStep = async (language, answers, { locate = [{ installationId: 2424, selection: 'selected' }], deploy = [], register = null } = {}) => {
  const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', b => { text += b; }); const ui = new TerminalUI({ input, output }); ui.language = language;
  input.end(answers.map(x => `${x}\n`).join(''));
  const calls = [], app = { appId: 4242, slug: 'auto-reset-timer-abc123', key: TIMER_APP_KEY };
  const step = promptTimerSetup(ui, { repository: 'synthetic/private', open: url => calls.push(['open', url]),
    register: async () => { calls.push(['register']); if (register) throw register; return app; },
    locate: async value => { calls.push(['locate', value.key === TIMER_APP_KEY]); const next = locate.shift(); if (next instanceof Error) throw next; return next; },
    verify: async value => { calls.push(['verify', value.installationId, value.key === TIMER_APP_KEY]); },
    deploy: async value => { calls.push(['deploy', value.installationId, value.key === TIMER_APP_KEY]); const next = deploy.shift(); if (next) throw next; } });
  try { return { setup: await step, text, calls }; }
  catch (error) { return { error, text, calls }; }
  finally { ui.close(); }
};
const failure = kind => Object.assign(new Error(kind), { kind });
const APP_RESULT = { appId: 4242, appSlug: 'auto-reset-timer-abc123', installationId: 2424 };

for (const language of ['ru', 'en']) test(`${language} timer screen: Create and Install, no token, key never shown`, async () => {
  const { setup, text, calls } = await timerStep(language, ['YES', 'YES']);
  assert.deepEqual(setup, APP_RESULT);
  assert.deepEqual(calls, [['register'], ['open', 'https://github.com/apps/auto-reset-timer-abc123/installations/new'],
    ['locate', true], ['verify', 2424, true], ['deploy', 2424, true]]);
  assert.ok(!text.includes(TIMER_APP_KEY.slice(0, 40)));
  for (const fragment of ['Cloudflare', 'Create GitHub App', 'Install', 'Only select repositories → synthetic/private', 'Actions: write',
    'Contents: read', 'TIMER_APP_KEY', WRANGLER.slice(9), appInstallUrl('auto-reset-timer-abc123')]) assert.ok(text.includes(fragment), fragment);
  assert.ok(text.includes(language === 'ru' ? 'сторонний сервис' : 'third-party service'));
  assert.ok(!/fine-grained|TIMER_TOKEN|366/i.test(text)); // No timer token any more.
});

test('timer screen: declined step does nothing; install is awaited; all repos warn; Wrangler is retried; leftovers get a delete link', async () => {
  const declined = await timerStep('ru', ['NO']);
  assert.deepEqual([declined.setup, declined.calls], [null, []]);
  // Not installed yet: the user is asked again, nothing is deployed before the installation is found.
  const late = await timerStep('ru', ['YES', 'YES', 'YES'], { locate: [failure('timer_app_not_installed'), { installationId: 2424, selection: 'all' }] });
  assert.deepEqual(late.setup, APP_RESULT);
  assert.ok(late.text.includes(messages.ru.timerNotInstalled) && late.text.includes(messages.ru.timerBroad));
  assert.equal(late.calls.filter(c => c[0] === 'locate').length, 2);
  const retried = await timerStep('en', ['YES', 'YES', 'YES'], { deploy: [failure('timer_wrangler_failed')] });
  assert.deepEqual(retried.setup, APP_RESULT); assert.equal(retried.calls.filter(c => c[0] === 'deploy').length, 2);
  const link = messages.en.timerAppLeft.replace('{url}', appSettingsUrl('auto-reset-timer-abc123'));
  for (const [answers, options, kind] of [[['YES', 'YES', 'NO'], { deploy: [failure('timer_wrangler_failed')] }, 'timer_wrangler_failed'],
    [['YES', 'NO'], {}, 'timer_app_not_installed'], [['YES', 'YES'], { locate: [failure('timer_app_unauthorized')] }, 'timer_app_unauthorized']]) {
    const stopped = await timerStep('en', answers, options);
    assert.equal(stopped.error.kind, kind); assert.ok(stopped.text.includes(link), kind);
  }
  // Registered under another account: the App is named for deletion; a timeout leaves nothing.
  const foreign = await timerStep('en', ['YES'], { register: Object.assign(failure('timer_app_owner_mismatch'), { app: { slug: 'auto-reset-timer-abc123' } }) });
  assert.ok(foreign.text.includes(link));
  const timeout = await timerStep('en', ['YES'], { register: failure('timer_app_timeout') });
  assert.equal(timeout.error.kind, 'timer_app_timeout'); assert.ok(!timeout.text.includes('Delete GitHub App'));
});

test('status shows the timer app and the last external wake; the timer token reminder is gone', () => {
  const s = { scheduler: { wokenAt: NOW }, installation: { timer: confirmedTimer(NOW) } };
  assert.deepEqual(timerRows(s), [['timer', `confirmed ${new Date((NOW - 1760) * 1000).toISOString()}`],
    ['lastExternalWake', new Date(NOW * 1000).toISOString()], ['timerApp', 'auto-reset-timer-synthetic (installation 2424)']]);
  assert.deepEqual(timerRows({ installation: {} }).map(r => r[1]), ['setup required (c)', '—', '—']);
  assert.equal(timerRows({ installation: { timer: { ...APP, probeAt: NOW, confirmedAt: null } } })[0][1], `probe ${new Date(NOW * 1000).toISOString()}`);
  assert.equal(timerNotice(confirmedTimer(NOW), 'ru'), null);
  assert.equal(timerNotice(undefined, 'en'), null);
  for (const language of ['ru', 'en']) assert.ok(!('timerRotate' in messages[language]));
});

test('installer texts agree with ADR-0002 and ADR-0003 in both languages', async () => {
  const adr2 = await readFile(new URL('../docs/adr/0002-external-timer.md', import.meta.url), 'utf8');
  for (const fragment of ['Worker secret', '2-57/5 * * * *']) assert.ok(adr2.includes(fragment), fragment);
  const adr3 = await readFile(new URL('../docs/adr/0003-single-token-timer-app.md', import.meta.url), 'utf8');
  for (const fragment of ['`actions: write`, `contents: read`', '`active: false`', 'PKCS#8', 'RS256, WebCrypto', '«Only select repositories»']) assert.ok(adr3.includes(fragment), fragment);
  for (const language of ['ru', 'en']) {
    const w = messages[language];
    assert.match(w.menu, /c (Внешний таймер|External timer)/);
    // ADR-0003: the prefilled form carries the permissions, the step itself is one line.
    assert.ok(!w.pat.includes('\n') && w.pat.includes('Generate') && !/Contents|Secrets|Variables/.test(w.pat));
    assert.match(w.policy, /Cloudflare/); assert.match(w.remove, /DELETE$/);
    assert.ok(w.timerSteps.join(' ').includes('Actions: write') && w.timerSteps.join(' ').includes('Contents: read'));
    assert.ok(!/Workflows|Secrets|Variables|PAT/.test(w.timerSteps.join(' '))); // The timer app is not the installation token.
    assert.match(w.timerAppDelete, /Delete GitHub App/);
  }
});
