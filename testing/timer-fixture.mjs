import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { TIMER_PLAN_PATH, renderTimerPlan } from '../src/managed-schedule.mjs';
import { tick } from '../worker/index.mjs';

// Synthetic timer app (ticket 42): the Worker holds the PKCS#8 key as one base64 line, exactly
// as the installer pipes it to TIMER_APP_KEY; GitHub checks the JWT with the public half.
export const TIMER_APP = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const TIMER_APP_KEY = TIMER_APP.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
export const INSTALLATION_TOKEN = 'synthetic-installation-token';
const base64 = text => Buffer.from(text).toString('base64').replace(/.{60}/g, '$&\n'); // GitHub wraps lines.
const segment = value => JSON.parse(Buffer.from(value, 'base64url').toString());

// Checks an app JWT like GitHub: RS256 by the public key, issuer, at most ten minutes of life.
export function checkAppJwt(authorization, { appId = 4242, now, publicKey = TIMER_APP.publicKey } = {}) {
  const [header, claims, signature] = authorization.replace(/^Bearer /, '').split('.');
  assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')), 'JWT signature');
  assert.deepEqual(segment(header), { alg: 'RS256', typ: 'JWT' });
  const c = segment(claims);
  assert.deepEqual(Object.keys(c).sort(), ['exp', 'iat', 'iss']);
  assert.equal(c.iss, String(appId));
  assert.ok(c.exp - c.iat <= 600 && c.iat <= now && c.exp > now, 'JWT lifetime');
  return c;
}

// No Cloudflare and no network: the production tick() against a fake GitHub. The token stage
// issues an installation token for the app JWT; the other stages accept only that token.
// fail[stage] answers token/plan/repository/runs/dispatch with a status (or 'network'); error
// bodies carry the key and the token to prove neither reaches the log. Each tick starts with an
// empty token cache unless the test keeps f.cache.
export function timerFixture({ expressions = [], content } = {}) {
  const f = { env: { TIMER_APP_KEY, TIMER_APP_ID: '4242', TIMER_INSTALLATION_ID: '2424', REPOSITORY: 'synthetic/private' },
    requests: [], dispatches: [], logs: [], fail: {}, cache: null, now: null, tokenTtl: 3600,
    content: content ?? renderTimerPlan(expressions), file: null, runs: 0, dispatchStatus: 200,
    repo: { full_name: 'Synthetic/Private', private: true, default_branch: 'main' } };
  f.fetchImpl = async (url, options) => {
    assert.equal(options.headers['x-github-api-version'], '2026-03-10');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    const u = new URL(url), method = options.method;
    assert.equal(u.origin, 'https://api.github.com');
    if (u.pathname.startsWith('/app/')) {
      f.requests.push({ stage: 'token', method, path: u.pathname, query: {} });
      assert.equal(method, 'POST');
      assert.equal(u.pathname, '/app/installations/2424/access_tokens');
      checkAppJwt(options.headers.authorization, { now: f.now });
      assert.deepEqual(JSON.parse(options.body), { repositories: ['private'], permissions: { actions: 'write', contents: 'read' } });
      if (f.fail.token === 'network') throw new Error(`synthetic network failure ${TIMER_APP_KEY}`);
      if (f.fail.token) return new Response(`secret-backend-detail ${TIMER_APP_KEY}`, { status: f.fail.token });
      return Response.json({ token: INSTALLATION_TOKEN, expires_at: new Date((f.now + f.tokenTtl) * 1000).toISOString(),
        permissions: { actions: 'write', contents: 'read', metadata: 'read' }, repository_selection: 'selected' }, { status: 201 });
    }
    assert.equal(options.headers.authorization, `Bearer ${INSTALLATION_TOKEN}`);
    assert.ok(u.pathname === '/repos/synthetic/private' || u.pathname.startsWith('/repos/synthetic/private/'));
    const path = u.pathname.slice('/repos/synthetic/private'.length);
    const stage = path === '' ? 'repository' : path.startsWith('/contents/') ? 'plan' :
      path.endsWith('/runs') ? 'runs' : path.endsWith('/dispatches') ? 'dispatch' : assert.fail(`Unexpected operation: ${method} ${path}`);
    f.requests.push({ stage, method, path, query: Object.fromEntries(u.searchParams) });
    if (f.fail[stage] === 'network') throw new Error(`synthetic network failure ${INSTALLATION_TOKEN}`);
    if (f.fail[stage]) return new Response(`secret-backend-detail ${INSTALLATION_TOKEN}`, { status: f.fail[stage] });
    if (stage === 'plan') {
      assert.equal(method, 'GET');
      assert.equal(path, `/contents/${TIMER_PLAN_PATH}`);
      assert.equal(u.searchParams.get('ref'), 'main');
      return Response.json(f.file ?? { type: 'file', path: TIMER_PLAN_PATH, encoding: 'base64',
        sha: 'a'.repeat(40), content: base64(f.content) });
    }
    if (stage === 'repository') { assert.equal(method, 'GET'); return Response.json(f.repo); }
    if (stage === 'runs') {
      assert.equal(method, 'GET');
      assert.equal(path, '/actions/workflows/auto-reset.yml/runs');
      return Response.json({ total_count: f.runs, workflow_runs: [] });
    }
    assert.equal(method, 'POST');
    assert.equal(path, '/actions/workflows/auto-reset.yml/dispatches');
    assert.equal(options.headers['content-type'], 'application/json');
    f.dispatches.push(JSON.parse(options.body));
    return f.dispatchStatus === 200 ? Response.json({ workflow_run_id: 4242, run_url: 'synthetic', html_url: 'synthetic' }) :
      new Response(null, { status: f.dispatchStatus });
  };
  // The Worker clock runs 33 s behind the nominal minute, as measured in E1.
  f.tick = async at => {
    const log = console.log, scheduled = typeof at === 'string' ? Date.parse(at) : at;
    f.now = Number.isFinite(scheduled) ? Math.floor(scheduled / 1000) + 33 : 0;
    console.log = line => f.logs.push(line);
    try { return await tick(scheduled, f.env, { fetchImpl: f.fetchImpl, now: () => f.now, cache: f.cache ?? new Map() }); }
    finally { console.log = log; }
  };
  return f;
}
