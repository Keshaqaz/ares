import { spawn } from 'node:child_process';
import { StateFailure } from './state-store.mjs';
import { GitHubBilling } from './github-billing.mjs';

// Installation token (ADR-0003, ticket 40): one fine-grained PAT serves the repo and billing.
// GitHub issues it only in the browser, so the installer prefills the form and then checks
// what was actually issued: the form fixes neither the repo nor the expiry (ticket 39).
const fail = kind => { throw new StateFailure(kind); };
// GitHub-Authentication-Token-Expiration, e.g. "2026-11-13 01:30:00 +0700" or "... UTC".
// An unknown format is null: the expiry is then unknown, not guessed.
export function tokenExpiration(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) (UTC|[+-]\d{4})$/.exec(value ?? '');
  if (!m) return null;
  const offset = m[7] === 'UTC' ? 0 : (m[7][0] === '-' ? -1 : 1) * (Number(m[7].slice(1, 3)) * 3600 + Number(m[7].slice(3)) * 60);
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 - offset;
  return Number.isSafeInteger(at) ? at : null;
}
export const TOKEN_PERMISSIONS = { contents: 'write', secrets: 'write', actions: 'write', actions_variables: 'write', workflows: 'write', plan: 'read' };
export const NOTICE_SECONDS = 14 * 86400;
const YEAR_SECONDS = 365 * 86400;

export function tokenFormUrl(repository) {
  const name = `auto-reset-${repository.split('/')[1]}`.slice(0, 40);
  const query = new URLSearchParams({ name, description: `Auto reset installation token for ${repository}`, expires_in: '366', ...TOKEN_PERMISSIONS });
  return `https://github.com/settings/personal-access-tokens/new?${query}`;
}
// macOS `open`; a failure leaves the printed link as the way to the form.
export function openUrl(url, { spawnImpl = spawn } = {}) {
  try {
    const child = spawnImpl('open', [url], { stdio: 'ignore', detached: true });
    child.once('error', () => {}); child.unref?.();
  } catch { /* The link is printed next to the step. */ }
}

// Read-only probes with the token itself. Workflows has no read access: install and Upgrade
// prove it by publishing the workflow. A missing Plan: read is reported, not thrown, so an
// installation upgraded with its old PAT can still reach `t`.
export async function verifyInstallationToken({ repository, token, fetchImpl = fetch, now = () => Math.floor(Date.now() / 1000) }) {
  if (typeof token !== 'string' || !token) fail('installation_token_required');
  const get = async (path, denied) => {
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${path}`, { redirect: 'manual',
        signal: AbortSignal.timeout(10_000), headers: { accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`, 'x-github-api-version': '2026-03-10', 'user-agent': 'auto-reset-installer' } });
    } catch { fail('installation_github_unreachable'); }
    if (response.status === 401) fail('installation_token_unauthorized');
    if ([403, 404].includes(response.status)) fail(denied);
    if (response.status !== 200) fail('installation_github_unavailable');
    return { headers: response.headers, body: await response.json().catch(() => null) };
  };
  const repo = await get(`/repos/${repository}`, 'installation_token_repository_denied');
  if (repo.body?.private !== true || repo.body.full_name?.toLowerCase() !== repository.toLowerCase()) fail('private_repository_required');
  if (!repo.body.default_branch) fail('initialize_repo_with_readme');
  const expiresAt = tokenExpiration(repo.headers.get('github-authentication-token-expiration'));
  if (expiresAt !== null && expiresAt <= now()) fail('installation_token_expired');
  for (const [path, denied] of [['/actions/secrets/public-key', 'installation_token_secrets_denied'],
    ['/actions/variables', 'installation_token_variables_denied'], ['/actions/workflows', 'installation_token_actions_denied'],
    [`/contents?ref=${encodeURIComponent(repo.body.default_branch)}`, 'installation_token_contents_denied']]) {
    await get(`/repos/${repository}${path}`, denied);
  }
  let plan = true;
  try { await new GitHubBilling({ owner: repository.split('/')[0], token, fetchImpl, now }).read(); }
  catch (error) { if (error.kind !== 'billing_unavailable') throw error; plan = false; }
  // "All repositories" is accepted with a warning (ADR-0003, 16 October): count what else it reaches.
  const listed = await get('/user/repos?visibility=private&per_page=100', 'installation_token_repository_denied');
  if (!Array.isArray(listed.body)) fail('installation_github_unavailable');
  const otherRepositories = listed.body.filter(r => r?.full_name?.toLowerCase() !== repository.toLowerCase()).length;
  return { expiresAt, plan, otherRepositories };
}
// The form asks for 366 days, but GitHub issued 30 (ticket 39): a shorter token is accepted with its date.
export const shortToken = (expiresAt, now) => Number.isSafeInteger(expiresAt) && expiresAt - now < YEAR_SECONDS;
export const tokenDue = (expiresAt, now) => Number.isSafeInteger(expiresAt) && expiresAt - now <= NOTICE_SECONDS;

const reminders = {
  ru: 'Токен установки истекает {date}. До этого выпустите новый по предзаполненной ссылке и замените его в установщике (k → 1); после истечения jobs остановятся.',
  en: 'The installation token expires {date}. Before then, issue a new one from the prefilled link and replace it in the installer (k → 1); jobs stop after expiry.',
};
// Rotation reminder two weeks ahead: installer start, `s` and Actions Summary.
export function tokenReminder(expiresAt, language, now) {
  if (!tokenDue(expiresAt, now)) return null;
  return reminders[language].replace('{date}', new Date(expiresAt * 1000).toISOString());
}
