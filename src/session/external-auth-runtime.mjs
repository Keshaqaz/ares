import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AuthFailure } from './auth-bundle.mjs';
import { StdioRpc, RpcFailure } from '../account/stdio.mjs';
import { validateAccountRequest } from '../account/account.mjs';

const exec = promisify(execFile);
const pins = JSON.parse(await readFile(new URL('../../runtime-lock.json', import.meta.url), 'utf8'));
export async function assertPinnedBinary(binary) {
  if (process.version !== `v${pins.node}`) throw new AuthFailure('node_version_mismatch');
  try {
    const { stdout } = await exec(binary, ['--version'], { timeout: 5000,
      env: { PATH: process.env.PATH }, maxBuffer: 4096 });
    if (stdout.trim() !== `codex-cli ${pins.appServer.version}`) throw new Error();
  } catch { throw new AuthFailure('app_server_version_mismatch'); }
}

export class ExternalAuthRuntime {
  authMode = 'chatgptAuthTokens';
  constructor({ binary, timeoutMs = 15_000, audit = () => {}, syntheticBackend = null,
    networkGuard = null, observeLaunch = () => {} } = {}) {
    if (typeof binary !== 'string' || !binary.startsWith('/') ||
        syntheticBackend && !/^http:\/\/127\.0\.0\.1:\d+$/.test(syntheticBackend)) throw new AuthFailure('invalid_runtime_configuration');
    Object.assign(this, { binary, timeoutMs, audit, syntheticBackend, networkGuard, observeLaunch });
  }
  async open(tokens) {
    if (!tokens || Object.keys(tokens).some(key => !['accessToken', 'chatgptAccountId', 'chatgptPlanType'].includes(key)) ||
        typeof tokens.accessToken !== 'string' || !tokens.accessToken || typeof tokens.chatgptAccountId !== 'string' ||
        !tokens.chatgptAccountId) throw new AuthFailure('invalid_external_tokens');
    await assertPinnedBinary(this.binary);
    const root = await mkdtemp(join(tmpdir(), 'auto-reset-external-'));
    const home = join(root, 'home'), codexHome = join(root, 'codex');
    let rpc;
    try {
      await mkdir(home, { mode: 0o700 }); await mkdir(codexHome, { mode: 0o700 });
      // A pinned local catalog prevents startup metadata fetch. No inference route is used.
      await writeFile(join(codexHome, 'models.json'), await readFile(new URL('../account/account-only-model-catalog.json', import.meta.url)), { mode: 0o600 });
      const base = this.syntheticBackend ?? 'https://chatgpt.com';
      await writeFile(join(codexHome, 'config.toml'), `
chatgpt_base_url = ${JSON.stringify(base)}
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
model_catalog_json = ${JSON.stringify(join(codexHome, 'models.json'))}
model_provider = "account_only"
model = "synthetic-no-inference"
[features]
plugins = false
apps = false
remote_control = false
system_proxy_fallback = false
[model_providers.account_only]
name = "Account RPC only"
base_url = "http://127.0.0.1:1/forbidden-model"
wire_api = "responses"
requires_openai_auth = true
[analytics]
enabled = false
[feedback]
enabled = false
[otel]
exporter = "none"
`, { mode: 0o600 });
      const env = { HOME: home, CODEX_HOME: codexHome, TMPDIR: root, PATH: process.env.PATH,
        LANG: 'en_US.UTF-8', RUST_LOG: 'error' };
      if (this.syntheticBackend) {
        // A tripwire records any accidental child OAuth request on the synthetic backend.
        env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = `${base}/oauth/token`;
        env.CODEX_REVOKE_TOKEN_URL_OVERRIDE = `${base}/forbidden-revoke`;
        for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) env[key] = base;
        env.NO_PROXY = env.no_proxy = '127.0.0.1';
      }
      const args = ['app-server', '--listen', 'stdio://'];
      const guarded = this.networkGuard ? await this.networkGuard(this.binary, args) : { file: this.binary, args };
      const launch = { ...guarded, env, cwd: root };
      this.observeLaunch({ launch, root, home, codexHome });
      rpc = new StdioRpc(launch, { timeoutMs: this.timeoutMs, audit: this.audit, stopOnExternalRefresh: true });
      await rpc.start();
      const confirmed = await rpc.request('account/login/start', { type: this.authMode, ...tokens });
      if (confirmed?.type !== this.authMode) throw new AuthFailure('external_login_failed');
      let used = false;
      const handle = { closed: false, authMode: this.authMode, loginConfirmed: true,
        request: async (method, params) => {
          if (used || !['account/read', 'account/rateLimits/read', 'account/rateLimitResetCredit/consume'].includes(method)) {
            throw new AuthFailure('method_forbidden');
          }
          used = true;
          validateAccountRequest(method, params);
          try { return await rpc.request(method, params); }
          catch (error) { throw new AuthFailure(error instanceof RpcFailure ? error.kind : 'runtime_failed'); }
        },
        close: async () => {
          await rpc.close(); handle.closed = true;
          await rm(root, { recursive: true, force: true });
        } };
      return handle;
    } catch (error) {
      await rpc?.close();
      await rm(root, { recursive: true, force: true });
      throw new AuthFailure(error instanceof AuthFailure || error instanceof RpcFailure ? error.kind : 'runtime_failed');
    }
  }
}
