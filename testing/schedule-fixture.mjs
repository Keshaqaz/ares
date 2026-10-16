import assert from 'node:assert/strict';
import { GitHubStorage } from '../src/github-storage.mjs';
import { GitHubScheduleWriter, TIMER_PLAN_PATH, readTimerPlan, renderTimerPlan } from '../src/github-schedule.mjs';

const WORKFLOW = '.github/workflows/auto-reset.yml';

// No actual repository or network: the production Contents transport/writer is exercised
// against a branch/CAS fixture. Two files on the default branch: the workflow (written only by
// Upgrade) and the timer plan (null = absent). fail modes apply to both. Full one-job runner
// wiring belongs to 17.
export function scheduleFixture({ token = 'synthetic-pat', plan = renderTimerPlan([]) } = {}) {
  const f = { branch: 'main', content: 'name: synthetic\n', sha: 'a'.repeat(40), plan, planSha: plan === null ? null : 'c'.repeat(40),
    requests: [], fail: null, serialized: true, beforePut: async () => {}, puts: 0, workflowPuts: 0, workflowDisabled: false };
  const storage = new GitHubStorage({ repository: 'synthetic/private', token,
    serialization: { assertOwner: async () => { if (!f.serialized) throw new Error('no owner'); } },
    fetchImpl: async (url, options) => {
      const u = new URL(url), path = u.pathname.slice('/repos/synthetic/private'.length);
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      f.requests.push({ path, method: options.method, ref: u.searchParams.get('ref') });
      if (f.fail === 'read') return new Response('synthetic-secret', { status: 403 });
      if (path === '') return Response.json({ full_name: 'synthetic/private', private: true, default_branch: f.branch });
      if (path === '/actions/workflows/auto-reset.yml/disable') {
        assert.equal(options.method, 'PUT'); f.workflowDisabled = true; return new Response(null, { status: 204 });
      }
      assert.ok([`/contents/${WORKFLOW}`, `/contents/${TIMER_PLAN_PATH}`].includes(path), path);
      const isPlan = path.endsWith(TIMER_PLAN_PATH), current = () => isPlan ? [f.plan, f.planSha] : [f.content, f.sha];
      if (options.method === 'GET') {
        const [content, sha] = current();
        assert.equal(u.searchParams.get('ref'), f.branch);
        if (content === null) return new Response('synthetic-secret', { status: 404 });
        return Response.json({ type: 'file', encoding: 'base64', sha, content: Buffer.from(content).toString('base64') });
      }
      assert.equal(options.method, 'PUT');
      const body = JSON.parse(options.body);
      assert.equal(body.branch, f.branch);
      await f.beforePut();
      const [content, sha] = current();
      if (f.fail === 'write') return new Response('synthetic-secret', { status: 403 });
      if (f.fail === 'conflict' || (body.sha ?? null) !== sha) return new Response(null, { status: content === null ? 422 : 409 });
      const next = Buffer.from(body.content, 'base64').toString('utf8');
      if (isPlan) { f.plan = next; f.puts++; f.planSha = f.puts.toString(16).padStart(40, 'b'); }
      else { f.content = next; f.workflowPuts++; f.sha = f.workflowPuts.toString(16).padStart(40, 'd'); }
      if (f.fail === 'lost-response') throw new Error('synthetic-secret');
      return Response.json({ content: { sha: isPlan ? f.planSha : f.sha } }, { status: sha === null ? 201 : 200 });
    } });
  f.writer = new GitHubScheduleWriter(storage);
  f.expressions = () => f.plan === null ? [] : readTimerPlan(f.plan);
  return f;
}
