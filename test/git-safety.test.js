// Decided: participants never write to main forks/upstream; they only get repo-scoped credentials for their own
// isolated work repository, through /api/git/credential (never through MCP tool output). These tests lock that in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingGitWriteAdapter } from '../src/github/write-adapter.js';
import { handleRpc, TOOLS } from '../src/mcp/server.js';
import { assertNoSecrets, findSecretLikeFields } from '../src/util.js';
import { anon, google, setup } from './helpers.js';

const call = (ctx, token, name, args = {}) =>
  handleRpc(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, `Bearer ${token}`);

test('anonymous participants are denied main-repository write access, for every kind', async () => {
  const { ctx } = await setup();
  const a = await anon(ctx);
  for (const kind of ['branch', 'push', 'deploy_key']) {
    const res = await call(ctx, a.token, 'request_git_access', { task_id: 'R0Y00/Xbox2Windows#77', kind });
    assert.equal(res.result.structuredContent.status, 'denied');
    assert.equal(res.result.structuredContent.reason, 'anonymous_write_forbidden');
    assert.equal(res.result.structuredContent.credentials_issued, false);
  }
  const adapter = new PendingGitWriteAdapter();
  assert.equal((await adapter.createIssueBranch({ participant: a.participant, task: { id: 'x' } })).status, 'denied');
});

test('nobody gets write access to main forks or upstream through MCP (Google included)', async () => {
  const { ctx } = await setup();
  const g = await google(ctx);
  const res = await call(ctx, g.token, 'request_git_access', { task_id: 'R0Y00/Xbox2Windows#77', kind: 'push' });
  const out = res.result.structuredContent;
  assert.equal(out.status, 'denied');
  assert.equal(out.reason, 'main_repository_write_forbidden');
  assert.equal(out.credentials_issued, false);
  assert.equal(out.adapter.writes_enabled, false);
  assert.deepEqual(findSecretLikeFields(out), []);
});

test('the adapter ignores write tokens present in the environment', async () => {
  const { ctx } = await setup({ env: { TOKEN_PEPPER: 'p', GITHUB_TOKEN: 'ghp_fake_write_token', GITHUB_WRITE_TOKEN: 'ghp_fake2' } });
  const g = await google(ctx);
  for (const kind of ['branch', 'push', 'deploy_key']) {
    const res = await call(ctx, g.token, 'request_git_access', { task_id: 'R0Y00/Xbox2Windows#77', kind });
    const text = JSON.stringify(res);
    assert.ok(!text.includes('ghp_'), 'no token leaks');
  }
  const adapter = new PendingGitWriteAdapter();
  for (const m of ['requestMerge', 'applyPlanning']) {
    const out = await adapter[m]({ review: { id: 'r', pr_url: 'u', commit_sha: 'c' }, proposal: { id: 'p', operations: [] } });
    assert.equal(out.status, 'pending_decision');
    assert.equal(out.credentials_issued, false);
  }
});

test('MCP responses are scanned for secret-like fields before leaving the server', () => {
  assert.throws(() => assertNoSecrets({ ok: 1, nested: { deploy_key: '-----BEGIN' } }), /secret-like/);
  assert.throws(() => assertNoSecrets({ token: 'abc' }), /secret-like/);
  assert.doesNotThrow(() => assertNoSecrets({ credentials_issued: false, token_prefix: 'g6a_' }));
});

test('no MCP tool exposes a way to push, create branches or obtain deploy keys', () => {
  const names = TOOLS.map((t) => t.name);
  for (const n of names) assert.ok(!/push|deploy|credential|merge/.test(n), n);
  assert.ok(names.includes('request_git_access'));
});
