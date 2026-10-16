import sodium from 'libsodium-wrappers';
import { InstallerGitHub } from '../../src/installer/installer-github.mjs';
import { syntheticGrant } from './auth-fixture.mjs';
import { FakeActions } from './private-workflow-fixture.mjs';
// Bootstrap-only Git tree/branch fixture; account/OAuth/consume use the shared 17 fixture.
export async function installerGitHubFixture() {
  await sodium.ready;
  const key = sodium.crypto_box_keypair(), actions = new FakeActions();
  let sequence = 1;
  const sha = () => (++sequence).toString(16).padStart(40, '0');
  const trees = new Map(), commits = new Map(), refs = new Map(), secrets = new Map();
  const tree = sha(), initial = sha(); trees.set(tree, { 'README.md': 'Private installation' });
  commits.set(initial, { sha: initial, tree: { sha: tree } }); refs.set('main', initial);
  const f = { trees, commits, refs, secrets, actions, requests: [], fail: null };
  const fetchImpl = async (url, options) => {
    const u = new URL(url), path = u.pathname.slice('/repos/synthetic/private'.length), method = options.method;
    f.requests.push({ path, method }); const body = options.body ? JSON.parse(options.body) : null;
    if (path === '') return Response.json({ full_name: 'synthetic/private', private: true, default_branch: 'main' });
    if (path === '/actions/secrets/public-key') return Response.json({ key_id: 'test', key: Buffer.from(key.publicKey).toString('base64') });
    if (path.startsWith('/actions/secrets/')) {
      const name = path.split('/').at(-1);
      if (method === 'PUT') {
        secrets.set(name, Buffer.from(sodium.crypto_box_seal_open(Buffer.from(body.encrypted_value, 'base64'), key.publicKey, key.privateKey)).toString());
        return new Response(null, { status: 204 });
      }
      if (method === 'DELETE') { secrets.delete(name); return new Response(null, { status: 204 }); }
    }
    if (path === '/git/trees' && method === 'POST') {
      const next = { ...trees.get(body.base_tree) }; for (const row of body.tree) next[row.path] = row.content;
      const id = sha(); trees.set(id, next); return Response.json({ sha: id }, { status: 201 });
    }
    if (path === '/git/commits' && method === 'POST') {
      const id = sha(), commit = { sha: id, tree: { sha: body.tree }, parents: body.parents };
      commits.set(id, commit); return Response.json(commit, { status: 201 });
    }
    if (path.startsWith('/git/commits/')) return Response.json(commits.get(path.split('/').at(-1)));
    if (path === '/git/refs' && method === 'POST') {
      refs.set(body.ref.slice('refs/heads/'.length), body.sha); return Response.json({ object: { sha: body.sha } }, { status: 201 });
    }
    if (path.startsWith('/git/ref')) {
      const branch = decodeURIComponent(path.split('/heads/')[1]);
      if (method === 'PATCH') { refs.set(branch, body.sha); if (f.fail === 'lost-bootstrap') throw new Error('lost'); }
      return refs.has(branch) ? Response.json({ object: { sha: refs.get(branch) } }) : new Response(null, { status: 404 });
    }
    if (path === '/contents' || path.startsWith('/contents/')) {
      const branch = u.searchParams.get('ref') ?? body?.branch, id = refs.get(branch), commit = commits.get(id);
      const files = trees.get(commit?.tree.sha);
      if (path === '/contents') return Response.json(Object.keys(files).map(name => ({ name })));
      const name = path.slice('/contents/'.length);
      if (method === 'PUT') {
        const next = { ...files, [name]: Buffer.from(body.content, 'base64').toString() }, tree = sha(), id = sha();
        trees.set(tree, next); commits.set(id, { sha: id, tree: { sha: tree } }); refs.set(branch, id);
        return Response.json({ content: { sha: id } }, { status: body.sha ? 200 : 201 });
      }
      if (!files?.[name]) return new Response(null, { status: 404 });
      return Response.json({ type: 'file', sha: id, encoding: 'base64', content: Buffer.from(files[name]).toString('base64') });
    }
    if (path === '/actions/workflows/auto-reset.yml/dispatches') { f.dispatched = body; return new Response(null, { status: 204 }); }
    throw new Error('unexpected_fake_api');
  };
  f.github = new InstallerGitHub({ repository: 'synthetic/private', token: syntheticGrant, fetchImpl });
  return f;
}
