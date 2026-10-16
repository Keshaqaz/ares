import sodium from 'libsodium-wrappers';
import { GitHubStorage } from './github-storage.mjs';
import { migrateState, StateFailure } from './state-store.mjs';
import { renderPrivateWorkflow, WORKFLOW_PATH } from './private-workflow.mjs';
import { TIMER_PLAN_PATH, readTimerPlan, renderTimerPlan } from './github-schedule.mjs';

const fail = kind => { throw new StateFailure(kind); };
// Local transport has NO writer capability. Only bootstrap of a new repo may publish
// the initial code/workflow/PAT. All state/auth/schedule mutations are dispatched.
export class InstallerGitHub {
  constructor(options) {
    this.storage = new GitHubStorage({ ...options, serialization: { assertOwner: () => fail('local_writer_forbidden') } });
    this.repository = options.repository; this.token = options.token;
  }
  api(...args) { return this.storage.api(...args); }
  async repositoryInfo() {
    const repo = await this.api('');
    if (!repo.private || repo.full_name?.toLowerCase() !== this.repository.toLowerCase()) fail('private_repository_required');
    if (!repo.default_branch) fail('initialize_repo_with_readme');
    return repo;
  }
  async file(path, branch) {
    return this.api(`/contents/${path}?ref=${encodeURIComponent(branch)}`);
  }
  async status() {
    const file = await this.file('state.json', 'auto-reset-state');
    return migrateState(JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')));
  }
  async marker() {
    const repo = await this.repositoryInfo();
    try {
      const file = await this.file('.auto-reset-installation.json', repo.default_branch);
      const value = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
      if (value.schema !== 1 || !/^[a-f0-9]{40}$/.test(value.programCommit)) fail('invalid_installation_marker');
      return value;
    } catch (error) { if (error.kind === 'storage_missing') return null; throw error; }
  }
  async putSecret(name, value) {
    const key = await this.storage.publicKey(); await sodium.ready;
    const encrypted = sodium.crypto_box_seal(Buffer.from(value), Buffer.from(key.key, 'base64'));
    await this.api(`/actions/secrets/${name}`, { method: 'PUT', statuses: [201, 204],
      body: { key_id: key.key_id, encrypted_value: Buffer.from(encrypted).toString('base64') } });
  }
  async uploadProgram(files) {
    const repo = await this.repositoryInfo();
    const ref = await this.api(`/git/ref/heads/${encodeURIComponent(repo.default_branch)}`);
    const base = await this.api(`/git/commits/${ref.object.sha}`);
    const tree = await this.api('/git/trees', { method: 'POST', statuses: [201], body: {
      base_tree: base.tree.sha, tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })) } });
    const commit = await this.api('/git/commits', { method: 'POST', statuses: [201], body: {
      message: 'Pinned auto-reset program', tree: tree.sha, parents: [ref.object.sha] } });
    if (!/^[a-f0-9]{40}$/.test(commit.sha ?? '')) fail('invalid_program_commit');
    return commit.sha; // Immutable, unattached code; upgrade publication belongs to Actions writer.
  }
  async bootstrap(files, language) {
    const repo = await this.repositoryInfo(), existing = await this.marker();
    if (existing) return existing;
    // Require a new repo: never overwrite user code/workflows during bootstrap.
    const listing = await this.api(`/contents?ref=${encodeURIComponent(repo.default_branch)}`);
    if (!Array.isArray(listing) || listing.some(f => !['README.md', 'LICENSE', '.gitignore'].includes(f.name))) fail('dedicated_new_repository_required');
    const programCommit = await this.uploadProgram(files);
    const marker = { schema: 1, programCommit, language };
    const content = await renderPrivateWorkflow(programCommit);
    // Bootstrap is a single fast-forward commit; marker, trusted workflow and empty timer plan appear together.
    const base = await this.api(`/git/commits/${programCommit}`);
    const tree = await this.api('/git/trees', { method: 'POST', statuses: [201], body: { base_tree: base.tree.sha, tree: [
      { path: WORKFLOW_PATH, mode: '100644', type: 'blob', content },
      { path: '.auto-reset-installation.json', mode: '100644', type: 'blob', content: JSON.stringify(marker) },
      { path: TIMER_PLAN_PATH, mode: '100644', type: 'blob', content: renderTimerPlan([]) },
    ] } });
    const commit = await this.api('/git/commits', { method: 'POST', statuses: [201], body: {
      message: 'Disabled auto-reset bootstrap', tree: tree.sha, parents: [programCommit] } });
    // PAT precedes workflow visibility. No auth bundle or state is published locally.
    await this.putSecret('AUTO_RESET_GITHUB_TOKEN', this.token);
    let failure;
    try { await this.api(`/git/refs/heads/${encodeURIComponent(repo.default_branch)}`, { method: 'PATCH', body: { sha: commit.sha, force: false } }); }
    catch (error) { failure = error; }
    const confirmed = await this.marker();
    if (JSON.stringify(confirmed) !== JSON.stringify(marker)) throw failure ?? new StateFailure('bootstrap_unconfirmed');
    return marker;
  }
  async dispatch(command) {
    const repo = await this.repositoryInfo();
    await this.api(`/actions/workflows/auto-reset.yml/dispatches`, { method: 'POST', statuses: [200, 204],
      body: { ref: repo.default_branch, inputs: { command: JSON.stringify(command) } } });
    return { state: 'unconfirmed', commandId: command.commandId };
  }
  async scheduleStatus() {
    const repo = await this.repositoryInfo(), file = await this.file(TIMER_PLAN_PATH, repo.default_branch);
    return readTimerPlan(Buffer.from(file.content, 'base64').toString('utf8'));
  }
}
