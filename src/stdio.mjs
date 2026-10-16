import { spawn } from 'node:child_process';
import { once } from 'node:events';

const METHODS = new Set([
  'initialize', 'account/read', 'account/login/start',
  'account/rateLimits/read', 'account/rateLimitResetCredit/consume',
]);

export class RpcFailure extends Error {
  constructor(kind, code = null) {
    super(kind);
    this.kind = kind;
    this.code = code;
  }
}

// JSONL stdio is the official App Server boundary; no thread or turn API is exposed.
export class StdioRpc {
  constructor(launch, { timeoutMs = 15_000, audit = () => {}, stopOnExternalRefresh = false } = {}) {
    this.launch = launch;
    this.timeoutMs = timeoutMs;
    this.audit = audit;
    this.stopOnExternalRefresh = stopOnExternalRefresh;
    this.pending = new Map();
    this.nextId = 1;
  }

  async start() {
    if (this.child) throw new RpcFailure('already_started');
    this.dead = false;
    this.closedKind = null;
    this.buffer = '';
    this.child = spawn(this.launch.file, this.launch.args, {
      env: this.launch.env, cwd: this.launch.cwd,
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    this.child.on('error', () => this.fail('spawn_failed'));
    this.child.on('exit', () => this.fail('process_exited'));
    this.child.stdin.on('error', () => this.fail('stdin_failed'));
    // Drain without logging: server errors can include bearer tokens or backend bodies.
    this.child.stderr.resume();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
    try {
      const initialized = await this.request('initialize', {
        clientInfo: { name: 'auto-reset-runtime', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      if (typeof initialized?.userAgent !== 'string' ||
          !/\/0\.160\.1(?:\s|$)/.test(initialized.userAgent)) {
        throw new RpcFailure('app_server_version_mismatch');
      }
      this.write({ method: 'initialized' });
      return initialized;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  write(message) {
    // Report the fixed kind that closed the transport, e.g. an external refresh between requests.
    if (this.dead || !this.child) throw new RpcFailure(this.closedKind ?? 'transport_closed');
    if (message.method) this.audit({ direction: 'send', method: message.method,
      paramKeys: Object.keys(message.params ?? {}).sort() });
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    if (!METHODS.has(method)) throw new RpcFailure('method_forbidden');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('rpc_timeout'), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  receive(chunk) {
    if (this.dead) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 1024 * 1024) return this.fail('oversized_rpc');
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); }
      catch { return this.fail('malformed_rpc'); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return this.fail('malformed_rpc');
      }
      if (typeof message.method === 'string') {
        this.audit({ direction: 'receive', method: message.method });
        if (message.method === 'configWarning') return this.fail('invalid_app_server_config');
        if (message.id !== undefined) {
          // External token refresh belongs to the auth adapter (15). Never invent a token.
          this.write({ id: message.id, error: { code: -32601, message: 'No server request handler configured' } });
          if (this.stopOnExternalRefresh && message.method === 'account/chatgptAuthTokens/refresh') {
            return this.fail('external_refresh_required');
          }
        }
        continue;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter || ('result' in message) === ('error' in message)) {
        return this.fail('malformed_rpc');
      }
      clearTimeout(waiter.timer);
      this.pending.delete(message.id);
      if ('error' in message) waiter.reject(new RpcFailure('rpc_error', message.error?.code));
      else waiter.resolve(message.result);
    }
  }

  fail(kind) {
    this.closedKind ??= kind;
    this.dead = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new RpcFailure(kind));
    }
    this.pending.clear();
    this.signal('SIGTERM');
  }

  signal(signal) {
    if (!this.child?.pid || this.child.exitCode !== null || this.child.signalCode !== null) return;
    try {
      if (process.platform === 'win32') this.child.kill(signal);
      else process.kill(-this.child.pid, signal);
    } catch (error) {
      // Some host sandboxes permit signalling the owned child but forbid process-group signals.
      if (error.code === 'EPERM') this.child.kill(signal);
      else if (error.code !== 'ESRCH') throw error;
    }
  }

  async close() {
    const child = this.child;
    if (!child) return;
    this.fail('transport_closed');
    child.stdin.destroy();
    if (child.exitCode !== null || child.signalCode !== null) { this.child = null; return; }
    const exited = once(child, 'close').catch(() => {});
    let timer;
    await Promise.race([exited, new Promise(resolve => {
      timer = setTimeout(() => { this.signal('SIGKILL'); resolve(); }, 1000);
    })]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) await exited;
    this.child = null;
  }
}
