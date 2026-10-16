import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tokenFormUrl, verifyInstallationToken, tokenReminder, openUrl, tokenExpiration, TOKEN_PERMISSIONS } from '../src/installer/installer-token.mjs';
import { TerminalUI, messages, promptInstallationToken, acceptInstallationToken, tokenRows } from '../src/installer/installer-ui.mjs';
import { Installer } from '../src/installer/installer.mjs';
import { sealAdmin, runInstallerAdmin } from '../src/installer/installer-admin.mjs';
import { renderInstallerReport } from '../src/installer/installer-report.mjs';
import { validateState } from '../src/core/state-store.mjs';
import { privateWorkflowFixture, PROGRAM_COMMIT } from './support/private-workflow-fixture.mjs';
import { syntheticGrant } from './support/auth-fixture.mjs';
import { makeBundle, encodeBundle, grantFingerprint } from '../src/session/auth-bundle.mjs';
import { hostBytes } from './support/host-auth-fixture.mjs';

const NOW = 1_800_000_000, DAY = 86400;
const header = at => new Date(at * 1000).toISOString().replace('T', ' ').replace(/\.000Z$/, ' UTC');

// Fake GitHub for the installation token check: every answer is gated on the token itself.
function fakeGitHub({ token = 'synthetic-installation-token', expiresAt = NOW + 366 * DAY, deny = null,
  billing = 200, owner = 'synthetic', others = [] } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const u = new URL(url), path = u.pathname + u.search; requests.push(path);
    if (options.headers.authorization !== `Bearer ${token}`) return new Response(null, { status: 401 });
    const date = { date: new Date(NOW * 1000).toUTCString() };
    if (deny && path.startsWith(deny)) return new Response(null, { status: 403 });
    if (path === '/repos/synthetic/private') return Response.json({ full_name: 'synthetic/private', private: true, default_branch: 'main' },
      { headers: expiresAt === null ? {} : { 'github-authentication-token-expiration': header(expiresAt) } });
    if (path.startsWith('/repos/synthetic/private/')) return Response.json({});
    if (path === '/user') return billing === 200 ? Response.json({ login: owner, plan: { name: 'free' } }, { headers: date }) : new Response(null, { status: billing });
    if (path.startsWith('/users/synthetic/settings/billing/usage/summary')) {
      const d = new Date(NOW * 1000);
      return Response.json({ user: 'synthetic', timePeriod: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }, usageItems: [] }, { headers: date });
    }
    if (path === '/user/repos?visibility=private&per_page=100') return Response.json([{ full_name: 'Synthetic/Private' }, ...others.map(full_name => ({ full_name }))]);
    throw new Error(`unexpected ${path}`);
  };
  return { fetchImpl, requests, check: (value = token) => verifyInstallationToken({ repository: 'synthetic/private', token: value, fetchImpl, now: () => NOW }) };
}

test('prefilled form carries the ticket 39 permission keys, 366 days and the installation name; repo is chosen by the user', () => {
  const url = new URL(tokenFormUrl('synthetic/private'));
  assert.equal(url.origin + url.pathname, 'https://github.com/settings/personal-access-tokens/new');
  assert.deepEqual(Object.fromEntries(url.searchParams), { name: 'auto-reset-private', description: 'Auto reset installation token for synthetic/private',
    expires_in: '366', contents: 'write', secrets: 'write', actions: 'write', actions_variables: 'write', workflows: 'write', plan: 'read' });
  assert.deepEqual(Object.keys(TOKEN_PERMISSIONS), ['contents', 'secrets', 'actions', 'actions_variables', 'workflows', 'plan']);
  assert.equal(new URL(tokenFormUrl(`synthetic/${'r'.repeat(100)}`)).searchParams.get('name').length, 40);
  const calls = [];
  openUrl('https://github.com/x', { spawnImpl: (file, args) => { calls.push([file, ...args]); return { once() {}, unref() {} }; } });
  openUrl('https://github.com/x', { spawnImpl: () => { throw new Error('no open'); } }); // The printed link remains.
  assert.deepEqual(calls, [['open', 'https://github.com/x']]);
});

for (const language of ['ru', 'en']) test(`${language} token step: blank input opens the form with a one-line step; the token is hidden`, async () => {
  const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', b => { text += b; }); const ui = new TerminalUI({ input, output }); ui.language = language;
  input.end('\nsynthetic-installation-token\n');
  const opened = [], g = fakeGitHub({ others: ['synthetic/other'] });
  const checked = await promptInstallationToken(ui, { repository: 'synthetic/private', open: url => opened.push(url), verify: g.check });
  ui.close();
  assert.deepEqual(opened, [tokenFormUrl('synthetic/private')]);
  assert.ok(text.includes(messages[language].pat) && text.includes(opened[0]));
  assert.ok(text.includes(messages[language].tokenBroad.replace('{count}', 1)));
  assert.ok(!text.includes('synthetic-installation-token'));
  assert.deepEqual(checked, { token: 'synthetic-installation-token', expiresAt: NOW + 366 * DAY, plan: true, otherRepositories: 1 });
});

test('token check on fake GitHub: private repo, read probes, Plan: read and expiry, all with the entered token', async () => {
  const g = fakeGitHub();
  assert.deepEqual(await g.check(), { expiresAt: NOW + 366 * DAY, plan: true, otherRepositories: 0 });
  assert.deepEqual(g.requests.slice(0, 5), ['/repos/synthetic/private', '/repos/synthetic/private/actions/secrets/public-key',
    '/repos/synthetic/private/actions/variables', '/repos/synthetic/private/actions/workflows', '/repos/synthetic/private/contents?ref=main']);
  assert.ok(g.requests.includes('/user') && g.requests.some(p => p.startsWith('/users/synthetic/settings/billing/usage/summary')));
  await assert.rejects(g.check('other-token'), /installation_token_unauthorized/);
  await assert.rejects(g.check(''), /installation_token_required/);
  for (const [deny, kind] of [['/repos/synthetic/private/actions/secrets', 'installation_token_secrets_denied'],
    ['/repos/synthetic/private/actions/variables', 'installation_token_variables_denied'],
    ['/repos/synthetic/private/actions/workflows', 'installation_token_actions_denied'],
    ['/repos/synthetic/private/contents', 'installation_token_contents_denied'],
    ['/repos/synthetic/private', 'installation_token_repository_denied']]) {
    await assert.rejects(fakeGitHub({ deny }).check(), error => error.kind === kind, kind);
  }
  await assert.rejects(fakeGitHub({ expiresAt: NOW }).check(), /installation_token_expired/);
  assert.equal((await fakeGitHub({ expiresAt: null }).check()).expiresAt, null); // "No expiration" sends no header.
  assert.equal((await fakeGitHub({ expiresAt: NOW + 30 * DAY }).check()).expiresAt, NOW + 30 * DAY);
  assert.equal((await fakeGitHub({ billing: 403 }).check()).plan, false);
  await assert.rejects(fakeGitHub({ owner: 'someone' }).check(), /billing_owner_mismatch/);
  assert.equal((await fakeGitHub({ others: ['synthetic/a', 'synthetic/b'] }).check()).otherRepositories, 2);
  const publicRepo = { ...fakeGitHub() }, inner = publicRepo.fetchImpl;
  await assert.rejects(verifyInstallationToken({ repository: 'synthetic/private', token: 'synthetic-installation-token', now: () => NOW,
    fetchImpl: async (url, o) => url.endsWith('/repos/synthetic/private') ? Response.json({ full_name: 'synthetic/private', private: false }) : inner(url, o) }),
  /private_repository_required/);
});

for (const language of ['ru', 'en']) test(`${language} acceptance: a new token needs Plan: read and shows a short expiry; an installed one is warned`, () => {
  const lines = [], ui = { language, text: line => lines.push(line) };
  assert.throws(() => acceptInstallationToken(ui, { plan: false, expiresAt: NOW + 366 * DAY }, { fresh: true, now: NOW }), /installation_token_plan_required/);
  acceptInstallationToken(ui, { plan: false, expiresAt: NOW + 30 * DAY }, { fresh: false, now: NOW });
  assert.deepEqual(lines, [messages[language].tokenPlan]); lines.length = 0;
  acceptInstallationToken(ui, { plan: true, expiresAt: NOW + 30 * DAY }, { fresh: true, now: NOW });
  assert.deepEqual(lines, [messages[language].tokenShort.replace('{date}', new Date((NOW + 30 * DAY) * 1000).toISOString())]);
  assert.match(lines[0], /366/); lines.length = 0;
  acceptInstallationToken(ui, { plan: true, expiresAt: NOW + 366 * DAY }, { fresh: true, now: NOW });
  acceptInstallationToken(ui, { plan: true, expiresAt: null }, { fresh: true, now: NOW });
  assert.deepEqual(lines, []);
});

for (const language of ['ru', 'en']) test(`${language} rotation reminder: two weeks ahead, at start, in s and in Actions Summary`, async t => {
  assert.equal(tokenReminder(NOW + 15 * DAY, language, NOW), null);
  assert.equal(tokenReminder(null, language, NOW), null);
  assert.equal(tokenReminder(undefined, language, NOW), null);
  const due = tokenReminder(NOW + 14 * DAY, language, NOW);
  assert.ok(due.includes(new Date((NOW + 14 * DAY) * 1000).toISOString()) && due.includes('(k → 1)'));
  assert.match(due, language === 'ru' ? /Токен установки истекает/ : /installation token expires/);
  assert.deepEqual(tokenRows({ installation: { grant: { expiresAt: NOW } } }), [['installationTokenExpires', new Date(NOW * 1000).toISOString()]]);
  assert.deepEqual(tokenRows({}, null), [['installationTokenExpires', '—']]);
  const f = await privateWorkflowFixture(t, { language });
  const expiresAt = f.clock + 10 * DAY;
  await f.actions.writer(() => f.github.storage.update(v => {
    v.installation = { programCommit: PROGRAM_COMMIT, seedSession: null, checkedSession: null, operation: null, grant: { expiresAt } };
  }));
  const reminder = tokenReminder(expiresAt, language, f.clock);
  const result = await f.actions.writer(() => f.job());
  assert.ok(result.summary.includes(reminder));
  const report = await f.actions.writer(() => renderInstallerReport(f.github.storage, { action: 'pause', commandId: 'x' }, { phase: 'done' }, () => f.clock));
  assert.ok(report.includes(reminder));
});

// Bootstrapped installation with a seeded session; `run` executes one sealed admin command as the job would.
async function installed() {
  const { installerGitHubFixture } = await import('./support/installer-github-fixture.mjs');
  const { GitHubStorage } = await import('../src/github/github-storage.mjs');
  const f = await installerGitHubFixture(), marker = await f.github.bootstrap({ 'src/demo.mjs': 'export {}' }, 'ru');
  f.store = new GitHubStorage({ repository: 'synthetic/private', token: syntheticGrant, fetchImpl: f.github.storage.fetch,
    serialization: f.actions.serialization });
  await f.actions.writer(() => f.store.initializeDisabled('ru', marker.programCommit));
  f.run = async (action, payload = {}, grant = syntheticGrant) => {
    const c = sealAdmin(f.store.repository, grant, { action, commandId: `token-${action}-${f.requests.length}`, expectedVersion: (await f.github.status()).version }, payload);
    return f.actions.writer(() => runInstallerAdmin({ storage: f.store, serialization: f.actions.serialization,
      command: c, grant, programCommit: marker.programCommit }));
  };
  await f.run('seed', { bundle: encodeBundle(makeBundle(hostBytes(1), { protocol: 2 })) });
  return f;
}

test('state keeps the installation token expiry; rotate-grant carries the new one and forgets an unknown one', async () => {
  const f = await installed();
  assert.equal((await f.github.status()).installation.grant, null); // A new installation is not a pre-40 one.
  await assert.rejects(f.run('rotate-grant', { newGrant: 'synthetic-next', grantExpiresAt: -1 }), /invalid_command/);
  await assert.rejects(f.run('rotate-grant', { newGrant: 'synthetic-next', grantExpiresAt: '2027-01-01' }), /invalid_command/);
  await f.run('rotate-grant', { newGrant: 'synthetic-next', grantExpiresAt: NOW + 30 * DAY });
  assert.deepEqual((await f.github.status()).installation.grant, { expiresAt: NOW + 30 * DAY });
  await f.run('rotate-grant', { newGrant: 'synthetic-third' }, 'synthetic-next');
  const s = await f.github.status();
  assert.deepEqual(s.installation.grant, { expiresAt: null });
  assert.equal(s.auth.grantFingerprint, grantFingerprint('synthetic-third'));
  s.installation.grant.token = 'synthetic-credential'; assert.throws(() => validateState(s), /invalid_state/);
  s.installation.grant = { expiresAt: -5 }; assert.throws(() => validateState(s), /invalid_state/);
});

test('init stores the expiry checked by the installer', async () => {
  const { installerGitHubFixture } = await import('./support/installer-github-fixture.mjs');
  const { GitHubStorage } = await import('../src/github/github-storage.mjs');
  const f = await installerGitHubFixture(), marker = await f.github.bootstrap({ 'src/demo.mjs': 'export {}' }, 'en');
  const store = new GitHubStorage({ repository: 'synthetic/private', token: syntheticGrant, fetchImpl: f.github.storage.fetch,
    serialization: f.actions.serialization });
  await f.actions.writer(() => runInstallerAdmin({ storage: store, serialization: f.actions.serialization, programCommit: marker.programCommit,
    grant: syntheticGrant, command: sealAdmin(store.repository, syntheticGrant, { action: 'init', commandId: 'init', expectedVersion: 0 },
      { language: 'en', grantExpiresAt: NOW + 30 * DAY }) }));
  assert.deepEqual((await f.github.status()).installation.grant, { expiresAt: NOW + 30 * DAY });
});

test('install sends the checked expiry with init; t sends it with the new token', async () => {
  const sent = [], installer = new Installer({ platform: 'darwin', journalPath: '/nonexistent/journal.json', github: {
    repository: 'synthetic/private', bootstrap: async () => ({}), status: async () => { throw Object.assign(new Error('missing'), { kind: 'storage_missing' }); } } });
  installer.send = async (action, payload) => { sent.push([action, payload]); return { state: 'unconfirmed' }; };
  installer.grantExpiresAt = NOW + 30 * DAY;
  await installer.bootstrap({});
  await installer.rotateGrant('synthetic-next', NOW + 366 * DAY);
  assert.deepEqual(sent, [['init', { language: 'ru', grantExpiresAt: NOW + 30 * DAY }],
    ['rotate-grant', { newGrant: 'synthetic-next', grantExpiresAt: NOW + 366 * DAY }]]);
});

test('an expired token is replaced by putting the new one into the Secret, then t with that same token', async () => {
  const f = await installed(); // Paused, as rotation requires.
  // The old token has expired: the user writes the new one into the Secret by hand (support.md).
  const next = 'synthetic-replacement-after-expiry'; f.secrets.set('AUTO_RESET_GITHUB_TOKEN', next); f.store.token = next;
  await f.run('rotate-grant', { newGrant: next, grantExpiresAt: NOW + 366 * DAY }, next);
  const s = await f.github.status();
  assert.equal(s.auth.grantFingerprint, grantFingerprint(next));
  assert.deepEqual(s.installation.grant, { expiresAt: NOW + 366 * DAY });
  assert.equal(f.secrets.get('AUTO_RESET_GITHUB_TOKEN'), next);
});

test('workflow and job pass no billing Secret: billing is read with AUTO_RESET_GITHUB_TOKEN', async () => {
  const root = new URL('../', import.meta.url);
  for (const file of ['templates/private-auto-reset.yml', 'src/workflow/private-cli.mjs', 'scripts/revoke-session.mjs']) {
    assert.ok(!(await readFile(new URL(file, root), 'utf8')).includes('AUTO_RESET_BILLING_TOKEN'), file);
  }
  const cli = await readFile(new URL('src/workflow/private-cli.mjs', root), 'utf8');
  assert.match(cli, /readGitHubQuota\(\{ storage, policy: env\.AUTO_RESET_BILLING_POLICY/);
  assert.match(cli, /code === 'stop_grant'/); // Expired token: a clear Summary line instead of a bare code.
});

test('token expiry header parses strictly', () => {
  assert.equal(tokenExpiration('2026-11-13 00:00:00 UTC'), Date.UTC(2026, 10, 13) / 1000);
  assert.equal(tokenExpiration('2026-11-13 00:00:00 -0130'), Date.UTC(2026, 10, 13, 1, 30) / 1000);
  assert.equal(tokenExpiration('2026-11-13 01:30:00 +0700'), Date.UTC(2026, 10, 12, 18, 30) / 1000);
  for (const value of [undefined, '', '2026-11-13T00:00:00Z', '2026-11-13 00:00 UTC']) assert.equal(tokenExpiration(value), null);
});
