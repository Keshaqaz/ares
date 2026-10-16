import { readFile, readdir, mkdir, open, rename, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { prepareCiLogin } from './host-oauth.mjs';
import { sealAdmin, openAdmin, adminFingerprint, controlFingerprint } from './installer-admin.mjs';
import { encodeBundle, AuthFailure } from './auth-bundle.mjs';
import { StateFailure } from './state-store.mjs';

export async function programFiles(root) {
  const files = {};
  // Explicit allowlist excludes local credentials, outputs, node_modules and desktop state.
  for (const file of ['package.json', 'package-lock.json', 'runtime-lock.json', 'templates/private-auto-reset.yml', 'scripts/install-app-server.mjs', 'scripts/install-linux-prerequisites.sh']) {
    files[file] = await readFile(join(root, file), 'utf8');
  }
  for (const file of await readdir(join(root, 'src'))) {
    if (/\.(mjs|json)$/.test(file)) files[`src/${file}`] = await readFile(join(root, 'src', file), 'utf8');
  }
  return files;
}
// A detached group keeps ownership explicit. Signals terminate the group, and
// no CI home is imported/deleted while an owned helper can still write it.
async function settleLoginGroup(pid) {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch (e) { if (e.code === 'ESRCH') return; throw new AuthFailure('login_process_not_closed'); }
  for (let n = 0; n < 500; n++) {
    try { process.kill(-pid, 0); } catch (e) { if (e.code === 'ESRCH') return; throw e; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new AuthFailure('login_process_not_closed');
}
export async function executeLogin(plan, { spawnImpl = spawn, settleGroup = settleLoginGroup } = {}) {
  let child, exited = false, groupSettled = false;
  const stop = () => { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    await new Promise((resolve, reject) => {
      child = spawnImpl(plan.file, plan.args, { env: plan.env, stdio: 'inherit', detached: true });
      child.once('error', () => { exited = true; reject(new AuthFailure('login_failed')); });
      child.once('close', code => { exited = true; code === 0 ? resolve() : reject(new AuthFailure('login_failed')); });
    });
    await settleGroup(child.pid); groupSettled = true;
    return await plan.complete({ processExited: true });
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (exited || !child) {
      if (!groupSettled) await settleGroup(child?.pid);
      await plan.cleanup({ processExited: true });
    }
  }
}
export class Installer {
  constructor({ github, journalPath, platform = process.platform, login = executeLogin, prepare = prepareCiLogin, keychain = null, connect = null }) {
    if (platform !== 'darwin') throw new StateFailure('installer_requires_macos');
    Object.assign(this, { github, journalPath, login, prepare, keychain, connect });
    this.grantExpiresAt = undefined; // Installation token expiry checked at entry; travels with init and rotation.
    this.journal = { schema: 1, repository: github.repository, language: 'ru', pending: null };
  }
  async load() {
    try {
      const info = await lstat(this.journalPath);
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 128 * 1024) throw new StateFailure('installer_journal_invalid');
      const value = JSON.parse(await readFile(this.journalPath, 'utf8'));
      if (value.schema !== 1 || value.repository !== this.github.repository || !['ru', 'en'].includes(value.language)) throw new StateFailure('installer_journal_invalid');
      this.journal = value;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this.journal;
  }
  async save() {
    await mkdir(dirname(this.journalPath), { recursive: true, mode: 0o700 });
    const path = `${this.journalPath}.${randomUUID()}.tmp`, file = await open(path, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(this.journal)); await file.sync(); } finally { await file.close(); }
    await rename(path, this.journalPath);
    const dir = await open(dirname(this.journalPath), 'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
  async language(language) {
    if (!['ru', 'en'].includes(language)) throw new StateFailure('invalid_language');
    this.journal.language = language; await this.save();
  }
  async send(action, payload = {}, expectedVersion = null) {
    if (this.journal.pending) throw new StateFailure('resume_pending_command_first');
    const version = expectedVersion ?? (await this.github.status()).version;
    const command = sealAdmin(this.github.repository, this.github.token,
      { action, expectedVersion: version, commandId: randomUUID() }, payload);
    this.journal.pending = command; await this.save(); // Save exact ciphertext before dispatch.
    return this.resume();
  }
  async resume() {
    const c = this.journal.pending;
    if (!c) return { state: 'idle' };
    const s = await this.github.status().catch(error => { if (error.kind === 'storage_missing') return null; throw error; });
    const receipt = s?.commands.find(x => x.commandId === c.commandId);
    const op = s?.installation?.operation;
    const expected = c.action === 'control' ? controlFingerprint(this.github.repository, this.github.token, c) : adminFingerprint(c);
    if (receipt && receipt.fingerprint !== expected) throw new StateFailure('command_id_reused');
    if (receipt && (op?.commandId !== c.commandId || op.phase === 'done')) {
      this.journal.pending = null; await this.save();
      // A control has no admin operation; another command's problem is not its result.
      const problem = op?.commandId === c.commandId ? op.problem ?? null : null;
      return { state: 'accepted', problem, version: s.version, commandId: c.commandId, keychain: problem ? null : await this.settle(c) };
    }
    return this.github.dispatch(c);
  }
  // The Keychain follows confirmed commands, also one resumed in a later run (ticket 41): a
  // rotation switches to the new token and stores it, uninstall removes the entry. Rotate-grant
  // and uninstall stay pending on failure, so an accepted receipt means the job completed them.
  async settle(c) {
    if (c.action === 'rotate-grant') {
      try {
        const { newGrant, grantExpiresAt } = openAdmin(this.github.repository, this.github.token, c);
        if (this.connect) this.github = this.connect(newGrant);
        this.grantExpiresAt = grantExpiresAt ?? null;
        if (!this.keychain) return 'keychainNotUpdated'; // Hidden input this run: the new token is typed next time.
        await this.keychain.write(newGrant); return 'keychainUpdated';
      } catch { return 'keychainNotUpdated'; }
    }
    if (c.action !== 'uninstall' || !this.keychain) return null;
    try { await this.keychain.remove(); return 'keychainRemoved'; } catch { return 'keychainNotRemoved'; }
  }
  // Monitor actions (apply-now, global rules) travel as sealed CycleEngine control.
  control(action, fields = {}) { return this.send('control', { action, ...fields }); }
  async bootstrap(files) {
    const marker = await this.github.bootstrap(files, this.journal.language);
    if (!this.journal.pending) {
      try { return { state: 'existing', version: (await this.github.status()).version, marker }; }
      catch (error) { if (error.kind !== 'storage_missing') throw error; }
      return this.send('init', { language: this.journal.language, grantExpiresAt: this.grantExpiresAt }, 0);
    }
    return this.resume();
  }
  async reconnect(binary) {
    if (this.journal.pending) throw new StateFailure('resume_pending_command_first');
    const state = await this.github.status();
    if (!state.disabled) throw new StateFailure('pause_before_login');
    const plan = await this.prepare({ binary });
    const bundle = await this.login(plan);
    return this.send('seed', { bundle: encodeBundle(bundle) }, state.version);
  }
  async configureQuota(policy) {
    if (this.journal.pending) throw new StateFailure('resume_pending_command_first');
    const s = await this.github.status();
    if (!s.disabled) throw new StateFailure('pause_before_quota_setup');
    return this.send('configure-quota', { policy }, s.version);
  }
  rotateGrant(newGrant, grantExpiresAt) { return this.send('rotate-grant', { newGrant, grantExpiresAt }); }
  // Only the timer app IDs and slug are sent; its key goes to the Worker secret alone (ticket 42).
  async timer({ appId, appSlug, installationId }) {
    if (this.journal.pending) throw new StateFailure('resume_pending_command_first');
    const s = await this.github.status();
    if (!s.disabled) throw new StateFailure('pause_before_timer_setup');
    return this.send('timer', { appId, appSlug, installationId }, s.version);
  }
  async enable(evidence) {
    const s = await this.github.status();
    if (!s.installation?.quota?.verified) throw new StateFailure('quota_setup_check_required');
    if (!s.installation.timer?.confirmedAt) throw new StateFailure('timer_confirmation_required');
    return this.send('enable', { evidence }, s.version);
  }
  async upgrade(files) {
    if (this.journal.pending) throw new StateFailure('resume_pending_command_first');
    const s = await this.github.status();
    if (!s.disabled) throw new StateFailure('pause_before_upgrade');
    const programCommit = await this.github.uploadProgram(files);
    return this.send('upgrade', { programCommit, workflowTemplate: files['templates/private-auto-reset.yml'] }, s.version);
  }
}
