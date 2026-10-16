import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstallerGitHub } from './installer-github.mjs';
import { Installer, programFiles } from './installer.mjs';
import { TerminalUI, messages, promptQuotaSetup, promptTimerSetup, promptInstallationToken, acceptInstallationToken, loadInstallationToken, keepInstallationToken, timerNotice, timerRows, tokenRows } from './installer-ui.mjs';
import { registerTimerApp, findInstallation, verifyTimerAccess, deployTimerWorker, deleteTimerTokenSecret, deleteTimerWorker, appSettingsUrl } from './installer-timer.mjs';
import { verifyInstallationToken, openUrl, tokenReminder } from './installer-token.mjs';
import { Keychain } from './installer-keychain.mjs';
import { credentialRows, credentialProblem, tokensMenu, promptTokens, rotateInstallationToken, replaceTimerKey, putTimerKey } from './installer-tokens.mjs';
import { TIMER_GRACE_SECONDS } from '../schedule/schedule-planner.mjs';
import { runMonitor, renderMonitor, paint } from './monitor-ui.mjs';
import { runWizard, wizardDue } from './installer-wizard.mjs';
import { AuthFailure } from '../session/auth-bundle.mjs';
import { StateFailure } from '../core/state-store.mjs';

const ui = new TerminalUI();
let installer, w = messages.ru;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// A confirmed rotation or uninstall reports what happened to the Keychain entry (ticket 41).
const keychainNotice = (result, say) => {
  if (result.keychain) say(w[result.keychain].replace('{repository}', installer.github.repository));
  return result;
};
async function awaitReceipt(result, say = text => ui.text(text)) {
  if (result.state !== 'unconfirmed') { if (result.problem) say(`${w.stopped}: ${result.problem}`); return keychainNotice(result, say); }
  say(w.pending);
  for (let n = 0; n < 12; n++) {
    await pause(10_000);
    const c = installer.journal.pending, s = await installer.github.status().catch(() => null);
    if (s?.commands.some(x => x.commandId === c.commandId) && s.installation.operation?.phase === 'done') {
      const done = await installer.resume(); say(done.problem ? `${w.stopped}: ${done.problem}` : w.accepted); return keychainNotice(done, say);
    }
    if (n % 3 === 2) say(w.pending);
  }
  say(`${w.waiting} https://github.com/${installer.github.repository}/actions`);
  return result;
}
// Probe of the timer step: the empty dispatch woken by the Worker confirms it in state.
async function awaitProbe() {
  const probeAt = (await installer.github.status()).installation?.timer?.probeAt;
  if (!Number.isSafeInteger(probeAt)) return;
  ui.text(`${w.timerProbe}: ${new Date(probeAt * 1000).toISOString()}`);
  while (true) {
    await pause(30_000);
    const timer = (await installer.github.status().catch(() => null))?.installation?.timer;
    if (timer?.confirmedAt) { ui.text(w.timerConfirmed); return; }
    if (Date.now() / 1000 > probeAt + TIMER_GRACE_SECONDS || timer && timer.probeAt !== probeAt) { ui.text(w.timerMissed); return; }
  }
}
try {
  if (process.platform !== 'darwin') throw new StateFailure('installer_requires_macos');
  const pins = JSON.parse(await readFile(new URL('../runtime-lock.json', import.meta.url), 'utf8'));
  if (process.version !== `v${pins.node}`) throw new StateFailure('node_version_mismatch');
  const journalPath = resolve(process.env.AUTO_RESET_INSTALLER_JOURNAL ?? join(homedir(), '.config/auto-reset/installer.json'));
  let saved = null;
  try { saved = JSON.parse(await readFile(journalPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // The first screen is always language selection; stored choice is the default.
  const language = await ui.ask('Русский (ru) / English (en)', { defaultValue: saved?.language ?? 'ru' });
  if (!['ru', 'en'].includes(language)) throw new StateFailure('invalid_language');
  ui.language = language; w = messages[language]; ui.stage('1/6', w.title);
  const root = fileURLToPath(new URL('../..', import.meta.url));
  ui.text(language === 'ru' ? 'Создайте отдельный private repo с README в GitHub; Administration права не нужны.' :
    'Create a dedicated private repo with a README in GitHub; no Administration permission is needed.');
  const repository = await ui.ask(w.repository, { defaultValue: saved?.repository ?? '' });
  const verify = value => verifyInstallationToken({ repository, token: value });
  const tokenStep = () => promptInstallationToken(ui, { repository, open: url => openUrl(url), verify });
  // Entered once: later runs take it from the Keychain (ticket 41).
  const checked = await loadInstallationToken(ui, { keychain: new Keychain({ repository }), verify, prompt: tokenStep });
  const { token, expiresAt: tokenExpiresAt } = checked, connect = value => new InstallerGitHub({ repository, token: value });
  installer = new Installer({ github: connect(token), journalPath, connect });
  installer.grantExpiresAt = tokenExpiresAt;
  await installer.load(); await installer.language(language);
  const current = await installer.github.status().catch(error => { if (error.kind === 'storage_missing') return null; throw error; });
  acceptInstallationToken(ui, checked, { fresh: current === null });
  installer.keychain = checked.stored ? checked.keychain : await keepInstallationToken(ui, { keychain: checked.keychain, token, repository });
  if (current && current.settings.language !== language && !installer.journal.pending) await awaitReceipt(await installer.send('language', { language }));
  for (const notice of [tokenReminder(tokenExpiresAt, language, Math.floor(Date.now() / 1000)), timerNotice(current?.installation?.timer, language)]) {
    if (notice) ui.text(notice);
  }
  // Credentials as the `k` table sees them; the menu marks `k` with `!` while one needs attention.
  let tokenPlan = checked.plan;
  const credentials = s => credentialRows(s, { token: { expiresAt: installer.grantExpiresAt, plan: tokenPlan, keychain: !!installer.keychain },
    now: Math.floor(Date.now() / 1000), language });
  const rotateToken = async () => {
    const sent = await rotateInstallationToken(ui, { status: () => installer.github.status(), pending: !!installer.journal.pending, prompt: tokenStep,
      accept: next => acceptInstallationToken(ui, next, { fresh: true }),
      // Confirmed, it switches the session and the Keychain to the new token (Installer.settle).
      rotate: (value, expiresAt) => installer.rotateGrant(value, expiresAt) });
    const receipt = sent && await awaitReceipt(sent);
    if (receipt?.keychain === 'keychainUpdated' || receipt?.keychain === 'keychainNotUpdated') tokenPlan = true; // A fresh token has Plan: read.
    return receipt;
  };
  // Steps shared by the menu and the first-run wizard (ticket 44); false means declined.
  const install = async () => awaitReceipt(await installer.bootstrap(await programFiles(root)));
  const login = async () => awaitReceipt(await installer.reconnect(await ui.ask(w.binary)));
  const quotaSetup = async () => {
    const setup = await promptQuotaSetup(ui, repository);
    return setup ? awaitReceipt(await installer.configureQuota(setup.policy)) : false;
  };
  const quotaCheck = async () => {
    const receipt = await awaitReceipt(await installer.send('check-quota'));
    if (receipt.state === 'accepted' && !receipt.problem) ui.text(w.billingReady);
    return receipt;
  };
  const timerSetup = async () => {
    // A timer still on the token (ticket 38) moves to the app: its unused secret is deleted too.
    // Checked before the clicks too: an App created for a refused command would be left behind.
    if (installer.journal.pending) throw new StateFailure('resume_pending_command_first');
    const before = await installer.github.status();
    if (!before.disabled) throw new StateFailure('pause_before_timer_setup');
    const legacy = Number.isSafeInteger(before.installation?.timer?.expiresAt);
    const setup = await promptTimerSetup(ui, { repository, open: url => openUrl(url),
      register: () => registerTimerApp({ repository, open: url => openUrl(url), onListen: base => ui.text(`${base}/`) }),
      locate: app => findInstallation({ repository, appId: app.appId, key: app.key }),
      verify: app => verifyTimerAccess({ repository, appId: app.appId, installationId: app.installationId, key: app.key }),
      deploy: async app => {
        await deployTimerWorker({ repository, appId: app.appId, installationId: app.installationId, key: app.key, root });
        if (legacy) await deleteTimerTokenSecret({ root }).then(() => ui.text(w.timerTokenRemoved), () => ui.text(w.timerTokenLeft));
      } });
    if (!setup) return false;
    const sent = await installer.timer(setup).catch(error => {
      ui.text(w.timerAppLeft.replace('{url}', appSettingsUrl(setup.appSlug))); throw error;
    });
    const receipt = await awaitReceipt(sent);
    if (receipt.state === 'accepted' && !receipt.problem) await awaitProbe();
    return receipt;
  };
  const wizard = () => runWizard(ui, { status: () => installer.github.status().catch(error => { if (error.kind === 'storage_missing') return null; throw error; }),
    parts: { bootstrap: install, seed: login, recover: async () => awaitReceipt(await installer.send('recover')),
      check: async () => awaitReceipt(await installer.send('check')), configure: quotaSetup, verify: quotaCheck, setup: timerSetup, probe: awaitProbe } });
  // A command left unfinished by the previous run is settled first; then the wizard runs while
  // a step is left on a paused (or not yet created) installation.
  if (installer.journal.pending) {
    try { await awaitReceipt(await installer.resume()); } catch (error) { ui.text(`${w.stopped}: ${error.kind ?? 'installer_failed'}`); }
  }
  const first = await installer.github.status().catch(error => error.kind === 'storage_missing' ? null : undefined);
  if (first !== undefined && wizardDue(first, Math.floor(Date.now() / 1000))) await wizard();
  while (true) {
    const live = await installer.github.status().catch(() => null);
    ui.text(tokensMenu(w.menu, credentialProblem(credentials(live))));
    const action = await ui.ask('>'); if (action === '0') break;
    try {
      if (action === 'r') { await awaitReceipt(await installer.resume()); continue; }
      if (action === 'i') { await wizard(); continue; }
      if (action === 'm') {
        // Monitor: resets, global rules and apply now as sealed control; the receipt is awaited silently.
        const load = () => installer.github.status();
        if (!ui.tty) { for (const line of renderMonitor(await load(), { screen: 'monitor', focus: 'list', selected: -1 },
          { now: Math.floor(Date.now() / 1000), language, repository })) ui.text(paint(line, false)); continue; }
        await ui.takeover(({ input, output }) => runMonitor({ input, output, language, repository, load,
          refresh: () => installer.resume(),
          send: async ({ action: control, ...fields }) => awaitReceipt(await installer.control(control, fields), () => {}) }));
        continue;
      }
      if (action === 's') {
        const s = await installer.github.status();
        ui.table([['version', s.version], ['language', s.settings.language], ['weeklyAutoReset', s.settings.weeklyAutoReset], ['disabled', s.disabled],
          ['quota', s.installation?.quota?.verified ? 'verified' : 'setup/check required'], ['scheduler', s.scheduler?.mode], ['publication', s.scheduler?.publication], ['problem', s.scheduler?.reason],
          ...tokenRows(s, installer.grantExpiresAt), ...timerRows(s), ...s.cycles.map(c => [c.creditId, c.status, c.scheduledAt, c.deadline])]);
        for (const reminder of [tokenReminder(installer.grantExpiresAt ?? s.installation?.grant?.expiresAt, language, Math.floor(Date.now() / 1000)),
          timerNotice(s.installation?.timer, language)]) if (reminder) ui.text(reminder);
        continue;
      }
      let result;
      if (action === '1') { ui.stage('2/6', w.repository); await install(); continue; }
      else if (action === '2') { ui.stage('3/6', w.binary); await login(); continue; }
      else if (action === '3') result = await installer.send('recover');
      else if (action === '4') { ui.stage('4/6', w.title); result = await installer.send('check'); }
      else if (action === '5') {
        const s = await installer.github.status(), metadata = s.installation?.metadata;
        ui.text(w.policy); ui.table((metadata?.credits ?? []).map(c => [c.id, c.status, c.resetType, c.expiry.kind === 'at' ? new Date(c.expiry.unixSeconds * 1000).toISOString() : c.expiry.kind]));
        if (!['details'].includes(metadata?.kind)) ui.text(w.partial);
        const creditId = await ui.ask(w.credit), row = metadata?.credits.find(c => c.id === creditId);
        let selection = creditId ? { creditId } : {};
        if (row && row.expiry.kind !== 'at') selection.scheduledAt = Number(await ui.ask(w.start));
        else {
          selection.deltaSeconds = Number(await ui.ask(w.delta, { defaultValue: '60' })) * 60;
          if (selection.deltaSeconds < 300) selection.acknowledgeDelayRisk = await ui.ask(w.risk) === 'YES';
        }
        result = await installer.send('select', { selection });
      } else if (action === '6') {
        ui.stage('6/6', w.policy);
        if (await ui.ask(w.evidence) !== 'YES') continue;
        result = await installer.enable({ clientPath: true, persistence: true, costPolicy: true });
      } else if (action === 'c') { ui.stage('5/6', w.timerTitle); await timerSetup(); continue; }
      else if (action === 'w') {
        const choice = await ui.ask(w.weekly);
        if (!['YES', 'NO'].includes(choice)) throw new StateFailure('invalid_command');
        result = await installer.send('weekly-auto', { enabled: choice === 'YES' });
      } else if (action === 'q') { await quotaSetup(); continue; }
      else if (action === 'b') { await quotaCheck(); continue; }
      else if (action === 'k') {
        const s = await installer.github.status();
        const choice = await promptTokens(ui, credentials(s));
        if (choice === 'token') await rotateToken();
        else if (choice === 'timer') {
          const timer = s.installation?.timer;
          if (Number.isSafeInteger(timer?.expiresAt)) ui.text(timerNotice(timer, language)); // Still on the timer token: c moves it.
          else await replaceTimerKey(ui, { timer, open: url => openUrl(url),
            locate: app => findInstallation({ repository, appId: app.appId, key: app.key }),
            verify: app => verifyTimerAccess({ repository, ...app }),
            put: key => putTimerKey({ key, root }) });
        } else if (choice === 'session') { ui.stage('3/6', w.binary); await login(); }
        continue;
      } else if (action === '7') result = await installer.send('pause');
      else if (action === '8') {
        ui.text('Node 26.10.0 · App Server 0.160.1 · explicit program commit');
        const before = await installer.github.status();
        result = await installer.upgrade(await programFiles(root));
        if (before.installation && before.installation.grant === undefined) ui.text(w.upgraded); // State before ticket 40.
      } else if (action === '9') {
        if (await ui.ask(w.remove) !== 'DELETE') continue;
        const slug = (await installer.github.status()).installation?.timer?.appSlug; // Uninstall forgets the timer.
        result = await installer.send('uninstall'); ui.text(w.revoke);
        if (slug) ui.text(w.timerAppDelete.replace('{url}', appSettingsUrl(slug)));
        // The paused installation no longer needs the Worker; the timer app is deleted in GitHub.
        if (await ui.ask(w.timerDelete) === 'YES') await deleteTimerWorker({ root }).catch(error => ui.text(`${w.stopped}: ${error.kind}`));
      } else continue;
      await awaitReceipt(result);
    } catch (error) {
      const kind = error instanceof AuthFailure || error instanceof StateFailure ? error.kind : 'installer_failed';
      ui.text(`${w.stopped}: ${kind}`);
    }
  }
} catch (error) {
  ui.text(`${w.stopped}: ${error instanceof StateFailure || error instanceof AuthFailure ? error.kind : 'installer_failed'}`);
  process.exitCode = 1;
} finally { ui.close(); }
