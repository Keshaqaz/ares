import assert from 'node:assert/strict';
import sodium from 'libsodium-wrappers';
import { GitHubStorage } from '../src/github-storage.mjs';
import { initialState } from '../src/state-store.mjs';
import { makeBundle, readyAuth } from '../src/auth-bundle.mjs';
import { authBytes, syntheticGrant } from './auth-fixture.mjs';

export async function githubFixture({ initialBundle = null, initialDocument = null, event = async () => {}, fallback = null } = {}) {
  await sodium.ready;
  const key = sodium.crypto_box_keypair();
  const bundle = initialBundle ?? makeBundle(authBytes());
  const state = initialDocument ?? initialState();
  if (!initialDocument) state.auth = readyAuth(bundle, syntheticGrant);
  const w = { state, sha: 'a'.repeat(40), requests: [], fail: null, staleRead: false, serialized: true,
    repoPrivate: true, changed: false, key, bundle, secret: null };
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.authorization, `Bearer ${syntheticGrant}`);
    assert.equal(options.redirect, 'error');
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com');
    assert.ok(parsed.pathname === '/repos/synthetic/private' || parsed.pathname.startsWith('/repos/synthetic/private/'));
    const path = parsed.pathname.slice('/repos/synthetic/private'.length);
    w.requests.push({ path, method: options.method, query: parsed.search });
    if (w.fail === 'grant') return new Response('secret-backend-detail', { status: 403 });
    if (path === '') return Response.json({ full_name: 'synthetic/private', private: w.repoPrivate, default_branch: 'main' });
    if (path === '/actions/secrets/public-key') return Response.json({ key_id: 'synthetic-key', key: Buffer.from(key.publicKey).toString('base64') });
    if (path === '/actions/secrets/AUTO_RESET_AUTH_BUNDLE' && options.method === 'PUT') {
      if (w.fail === 'secret') return new Response(null, { status: 403 });
      const request = JSON.parse(options.body);
      assert.equal(request.key_id, 'synthetic-key');
      const plain = sodium.crypto_box_seal_open(Buffer.from(request.encrypted_value, 'base64'), key.publicKey, key.privateKey);
      w.secret = Buffer.from(plain).toString('utf8');
      await event('secret.put');
      assert.ok(!options.body.includes('authBase64') && !options.body.includes('synthetic-refresh'));
      if (w.fail === 'lost_secret') throw new Error('Bearer synthetic-secret-must-never-escape');
      return new Response(null, { status: w.createSecret ? 201 : 204 });
    }
    if (path === '/actions/secrets/AUTO_RESET_AUTH_BUNDLE' && options.method === 'DELETE') {
      w.secret = null; return new Response(null, { status: 204 });
    }
    if (path === '/actions/secrets/AUTO_RESET_BILLING_TOKEN' && options.method === 'DELETE') return new Response(null, { status: 204 });
    if (path === '/contents/state.json' && options.method === 'GET') {
      assert.equal(parsed.searchParams.get('ref'), 'auto-reset-state');
      if (w.fail === 'missing') return new Response(null, { status: 404 });
      const document = w.staleRead && w.changed ? state : w.state;
      return Response.json({ type: 'file', sha: w.sha, encoding: 'base64', content: Buffer.from(JSON.stringify(document)).toString('base64') });
    }
    if (path === '/contents/state.json' && options.method === 'PUT') {
      const put = JSON.parse(options.body);
      assert.equal(put.sha, w.sha);
      assert.equal(put.branch, 'auto-reset-state');
      const next = JSON.parse(Buffer.from(put.content, 'base64').toString('utf8'));
      assert.equal(next.version, w.state.version + 1);
      assert.ok(!JSON.stringify(next).includes('authBase64'));
      if (w.fail === 'conflict') return new Response(null, { status: 409 });
      w.state = next; w.changed = true; w.sha = 'b'.repeat(40);
      await event(`state.${next.auth.phase}`);
      if (w.fail === 'lost_state') throw new Error('synthetic-secret-must-never-escape');
      return Response.json({ content: { sha: w.sha } });
    }
    if (fallback) return fallback(url, options);
    assert.fail(`Unexpected operation: ${options.method} ${path}`);
  };
  w.serialization = { assertOwner: async () => { if (!w.serialized) throw new Error('synthetic-secret'); } };
  w.storage = new GitHubStorage({ repository: 'synthetic/private', token: syntheticGrant, fetchImpl,
    serialization: w.serialization });
  return w;
}
