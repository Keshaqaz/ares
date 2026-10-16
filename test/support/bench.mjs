import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fakeBackend, jwt, syntheticAccountId } from './fake-backend.mjs';
import { StdioRpc } from '../../src/account/stdio.mjs';
import { AccountAdapter } from '../../src/account/account.mjs';

const exec = promisify(execFile);
export const pins = JSON.parse(await readFile(new URL('../../src/runtime-lock.json', import.meta.url), 'utf8'));

export async function bench({ binary = process.env.AUTO_RESET_CODEX_BIN ?? 'codex', timeoutMs = 15_000, authMode = 'managed' } = {}) {
  if (!['managed', 'external'].includes(authMode)) throw new Error('invalid_fixture_auth_mode');
  if (process.version !== `v${pins.node}`) throw new Error('node_version_mismatch');
  const version = await exec(binary, ['--version'], { timeout: 5000 });
  if (version.stdout.trim() !== `codex-cli ${pins.appServer.version}`) throw new Error('codex_version_mismatch');
  const root = await mkdtemp(join(tmpdir(), 'auto-reset-013-'));
  const isolatedHome = join(root, 'home');
  const codexHome = join(root, 'codex');
  let backend;
  let rpc;
  try {
    await mkdir(isolatedHome, { mode: 0o700 });
    await mkdir(codexHome, { mode: 0o700 });
    backend = await fakeBackend();
    await writeFile(join(codexHome, 'models.json'), await readFile(new URL('../../src/account/account-only-model-catalog.json', import.meta.url)));
    if (authMode === 'managed') await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt', OPENAI_API_KEY: null,
      tokens: { access_token: jwt(), id_token: jwt(), refresh_token: 'synthetic-refresh-0', account_id: syntheticAccountId },
      last_refresh: new Date().toISOString(),
    }), { mode: 0o600 });
    await writeFile(join(codexHome, 'config.toml'), `
chatgpt_base_url = "${backend.url}"
cli_auth_credentials_store = "file"
check_for_update_on_startup = false
model_catalog_json = "${join(codexHome, 'models.json')}"
model_provider = "synthetic"
model = "synthetic-no-inference"
[features]
plugins = false
apps = false
remote_control = false
system_proxy_fallback = false
[model_providers.synthetic]
name = "Forbidden model endpoint"
base_url = "${backend.url}/forbidden-model"
wire_api = "responses"
requires_openai_auth = true
[analytics]
enabled = false
[feedback]
enabled = false
[otel]
exporter = "none"
`, { mode: 0o600 });
    const env = {
      PATH: process.env.PATH, HOME: isolatedHome, CODEX_HOME: codexHome,
      TMPDIR: root, LANG: 'en_US.UTF-8', RUST_LOG: 'error',
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${backend.url}/oauth/token`,
      CODEX_REVOKE_TOKEN_URL_OVERRIDE: `${backend.url}/forbidden-revoke`,
      HTTP_PROXY: backend.url, HTTPS_PROXY: backend.url, ALL_PROXY: backend.url,
      http_proxy: backend.url, https_proxy: backend.url, all_proxy: backend.url,
      NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1',
    };
    let file = binary;
    let args = ['app-server', '--listen', 'stdio://'];
    const guard = await syntheticNetworkGuard(backend.url);
    ({ file, args } = guard(binary, args));
    const networkGuard = process.platform === 'darwin' ? 'macOS sandbox: fixture port only' : 'Linux network namespace: loopback only';
    const audit = [];
    rpc = new StdioRpc({ file, args, env, cwd: root }, { timeoutMs, audit: entry => audit.push(entry) });
    await rpc.start();
    if (authMode === 'external') {
      const result = await rpc.request('account/login/start', {
        type: 'chatgptAuthTokens', accessToken: jwt(), chatgptAccountId: syntheticAccountId, chatgptPlanType: 'pro',
      });
      if (result?.type !== 'chatgptAuthTokens') throw new Error('external_fixture_login_failed');
    }
    const account = new AccountAdapter(rpc, { accountId: () => syntheticAccountId });
    return {
      account, rpc, backend, audit, networkGuard,
      authPath: join(codexHome, 'auth.json'),
      auth: async () => JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8')),
      close: async () => { await rpc.close(); await backend.close(); await rm(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rpc?.close();
    await backend?.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

// Shared OS guard for legacy and host-owned stock contract suites.
export async function syntheticNetworkGuard(url) {
  if (process.platform === 'darwin') {
    const port = new URL(url).port;
    const desktopAuth = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const policy = `(version 1)(allow default)(deny network*)` +
      `(allow network-outbound (remote ip "localhost:${port}"))` +
      `(deny file-read* (subpath ${JSON.stringify(desktopAuth)}) (subpath ${JSON.stringify(join(homedir(), '.codex'))}))`;
    return (binary, args) => ({ file: '/usr/bin/sandbox-exec', args: ['-p', policy, binary, ...args] });
  }
  if (process.platform === 'linux') {
    const routes = await readFile('/proc/net/route', 'utf8');
    const devices = await readFile('/proc/net/dev', 'utf8');
    if (routes.trim().split('\n').length > 1 || devices.split('\n').filter(line => line.includes(':')).some(line => !line.trim().startsWith('lo:'))) {
      throw new Error('network_namespace_required: use scripts/test-contract-linux.sh');
    }
    return (binary, args) => ({ file: binary, args });
  }
  throw new Error('no_supported_network_guard');
}
