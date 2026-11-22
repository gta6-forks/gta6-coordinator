// Isolated work repositories: one per reservation, credential only for that repo, only while the reservation
// is active; integration by the trusted job; revocation and cleanup on every exit path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { claim, release } from '../src/services/scheduler.js';
import { submitCompletion } from '../src/services/review.js';
import { getWorkspace, integrationResult, issueGitCredential, reconcileWorkspaces } from '../src/services/workspace.js';
import { getTask, syncCatalog } from '../src/services/catalog.js';
import { verifySignature } from '../src/github/webhooks.js';
import { handleRpc } from '../src/mcp/server.js';
import { findSecretLikeFields } from '../src/util.js';
import { redact, scanChanges } from '../tools/integrate-workspace.mjs';
import { anon, baseEnv, clock, completion, createNodeStore, google, HOUR, task } from './helpers.js';

class FakeProvisioner {
  constructor() {
    this.calls = [];
    this.seq = 0;
  }
  describe() {
    return { name: 'fake', enabled: true, validated: true };
  }
  async provision({ workspace }) {
    this.calls.push(['provision', workspace.id]);
    return { status: 'ready', repo_full_name: `gta6-work/w-${workspace.id.slice(3)}`, base_sha: 'b'.repeat(40) };
  }
  async mintCredential({ workspace }) {
    this.calls.push(['mint', workspace.repo_full_name]);
    this.seq++;
    return { username: 'x-access-token', password: `ghs_fake_${this.seq}`, expires_at: '2026-11-21T13:00:00Z', repositories: [workspace.repo_full_name] };
  }
  async revoke({ workspace }) {
    this.calls.push(['revoke', workspace.repo_full_name]);
    return { status: 'archived' };
  }
  async integrate({ workspace, head_sha }) {
    this.calls.push(['integrate', workspace.repo_full_name, head_sha]);
    return { status: 'dispatched' };
  }
  async cleanup({ workspace }) {
    this.calls.push(['cleanup', workspace.repo_full_name]);
    return { status: 'deleted' };
  }
}

const forked = (id) => task(id, { fork_repo: `gta6-forks/${id.split('/')[1].split('#')[0]}` });

async function world({ provisioner = new FakeProvisioner(), env = baseEnv() } = {}) {
  const now = clock();
  const store = createNodeStore();
  const app = createApp({ store, env, now, provisioner });
  syncCatalog(app.ctx, [forked('R0Y00/Xbox2Windows#77'), forked('R0Y00/Xbox2Windows#78')], { version: 1, milestones: [] });
  return { app, ctx: app.ctx, now, provisioner };
}

const head = 'c'.repeat(40);
const wsCompletion = (workspace_id) => {
  const c = completion({ commit_sha: head, workspace_id });
  delete c.pr_url;
  return c;
};

test('default deployment: provisioning is disabled until validated, and no credential can be minted', async () => {
  const now = clock();
  const app = createApp({ store: createNodeStore(), env: baseEnv(), now });
  syncCatalog(app.ctx, [forked('R0Y00/Xbox2Windows#77')], null);
  const a = await anon(app.ctx);
  const r = claim(app.ctx, a.participant, {});
  const ws = await getWorkspace(app.ctx, a.participant, { reservation_id: r.reservation.id });
  assert.equal(ws.state, 'requested');
  assert.equal(ws.repo, null);
  assert.equal(ws.provisioner.enabled, false);
  await assert.rejects(issueGitCredential(app.ctx, a.participant, { repo: 'any/repo' }), /no active work repository/);
});

test('one work repository per reservation (idempotent), credential only for that repository', async () => {
  const { ctx, provisioner } = await world();
  const a = await anon(ctx);
  const b = await anon(ctx);
  const ra = claim(ctx, a.participant, { task_id: 'R0Y00/Xbox2Windows#77' });
  const rb = claim(ctx, b.participant, { task_id: 'R0Y00/Xbox2Windows#78' });
  const wa = await getWorkspace(ctx, a.participant, { reservation_id: ra.reservation.id });
  const again = await getWorkspace(ctx, a.participant, { reservation_id: ra.reservation.id });
  assert.equal(again.repo, wa.repo);
  assert.equal(provisioner.calls.filter((c) => c[0] === 'provision').length, 1);
  assert.equal(wa.state, 'ready');
  assert.match(wa.clone_url, /^https:\/\/github\.com\/gta6-work\/w-[0-9a-f]+\.git$/);
  assert.match(wa.write_scope, /not branch-scoped/);
  const wb = await getWorkspace(ctx, b.participant, { reservation_id: rb.reservation.id });

  const cred = await issueGitCredential(ctx, a.participant, { repo: wa.repo });
  assert.equal(cred.username, 'x-access-token');
  assert.deepEqual(cred.repositories, [wa.repo]);
  await assert.rejects(issueGitCredential(ctx, a.participant, { repo: wb.repo }), /no active work repository/);
  await assert.rejects(issueGitCredential(ctx, a.participant, { repo: 'gta6-forks/Xbox2Windows' }), /no active work repository/);
  await assert.rejects(issueGitCredential(ctx, b.participant, { repo: wa.repo }), /no active work repository/);
});

test('MCP tool output never carries the credential; only the credential endpoint does', async () => {
  const { ctx } = await world();
  const a = await anon(ctx);
  const r = claim(ctx, a.participant, {});
  const res = await handleRpc(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_workspace', arguments: { reservation_id: r.reservation.id } } }, `Bearer ${a.token}`);
  assert.equal(res.result.isError, false);
  assert.deepEqual(findSecretLikeFields(res.result.structuredContent), []);
  assert.ok(!JSON.stringify(res).includes('ghs_'));
});

test('release and expiry revoke write access; the repo is archived and kept for audit, not deleted', async () => {
  const { ctx, now, provisioner } = await world({ env: baseEnv({ WORKSPACE_RETENTION_DAYS: '1' }) });
  const a = await anon(ctx);
  const b = await anon(ctx);
  const ra = claim(ctx, a.participant, { task_id: 'R0Y00/Xbox2Windows#77' });
  const wa = await getWorkspace(ctx, a.participant, { reservation_id: ra.reservation.id });
  const rb = claim(ctx, b.participant, { task_id: 'R0Y00/Xbox2Windows#78' });
  const wb = await getWorkspace(ctx, b.participant, { reservation_id: rb.reservation.id });

  release(ctx, a.participant, ra.reservation.id, 'desisti');
  await reconcileWorkspaces(ctx);
  await assert.rejects(issueGitCredential(ctx, a.participant, { repo: wa.repo }), /no active work repository/);
  assert.ok(provisioner.calls.some((c) => c[0] === 'revoke' && c[1] === wa.repo));

  now.advance(24 * HOUR);
  await assert.rejects(issueGitCredential(ctx, b.participant, { repo: wb.repo }), /no active work repository/);
  await reconcileWorkspaces(ctx);
  assert.ok(provisioner.calls.some((c) => c[0] === 'revoke' && c[1] === wb.repo));

  now.advance(30 * 24 * HOUR);
  await reconcileWorkspaces(ctx);
  assert.ok(!provisioner.calls.some((c) => c[0] === 'cleanup'), 'expired/released work is preserved');
  assert.equal(ctx.store.one("SELECT COUNT(*) AS n FROM workspaces WHERE state = 'revoked' AND delete_after IS NULL").n, 2);

  const c = await anon(ctx);
  const rc = claim(ctx, c.participant, { task_id: 'R0Y00/Xbox2Windows#78' });
  const wc = await getWorkspace(ctx, c.participant, { reservation_id: rc.reservation.id });
  assert.notEqual(wc.repo, wb.repo, 'redistributed to a NEW isolated repository');
});

test('an integration that finishes after the 24h deadline is rejected and the task is redistributed', async () => {
  const { ctx, now } = await world();
  const a = await anon(ctx);
  const r = claim(ctx, a.participant, { task_id: 'R0Y00/Xbox2Windows#77' });
  const ws = await getWorkspace(ctx, a.participant, { reservation_id: r.reservation.id });
  now.advance(23 * HOUR);
  submitCompletion(ctx, a.participant, { reservation_id: r.reservation.id, completion: wsCompletion(ws.workspace_id) });
  now.advance(HOUR);
  const late = integrationResult(ctx, { workspace_id: ws.workspace_id, outcome: 'integrated', commit_sha: head, pr_url: 'https://github.com/gta6-forks/Xbox2Windows/pull/5' });
  assert.equal(late.status, 'rejected_late');
  assert.equal(getTask(ctx.store, 'R0Y00/Xbox2Windows#77').status, 'open');
  assert.throws(() => submitCompletion(ctx, a.participant, { reservation_id: r.reservation.id, completion: wsCompletion(ws.workspace_id) }), /deadline passed/);
  const b = await anon(ctx);
  assert.equal(claim(ctx, b.participant, {}).task.id, 'R0Y00/Xbox2Windows#77');
});

test('completion from a work repository: integrate, keep access until integrated, then verify the same commit', async () => {
  const { ctx, provisioner } = await world();
  const a = await anon(ctx);
  const r = claim(ctx, a.participant, { task_id: 'R0Y00/Xbox2Windows#77' });
  const ws = await getWorkspace(ctx, a.participant, { reservation_id: r.reservation.id });
  const done = submitCompletion(ctx, a.participant, { reservation_id: r.reservation.id, completion: wsCompletion(ws.workspace_id) });
  assert.equal(done.status, 'integrating');
  assert.throws(() => claim(ctx, a.participant, {}), /one task at a time/);

  assert.throws(() => integrationResult(ctx, { workspace_id: ws.workspace_id, outcome: 'integrated', commit_sha: 'd'.repeat(40), pr_url: 'https://github.com/gta6-forks/Xbox2Windows/pull/5' }), /rewrite/);

  const ok = integrationResult(ctx, { workspace_id: ws.workspace_id, outcome: 'integrated', commit_sha: head, pr_url: 'https://github.com/gta6-forks/Xbox2Windows/pull/5' });
  assert.equal(ok.status, 'verifying');
  assert.equal(ok.verification_tasks.length, 2);
  const vt = getTask(ctx.store, ok.verification_tasks[0]);
  assert.equal(vt.data.review.commit_sha, head);
  assert.equal(vt.data.url, 'https://github.com/gta6-forks/Xbox2Windows/pull/5');
  await reconcileWorkspaces(ctx);
  assert.ok(provisioner.calls.some((c) => c[0] === 'revoke' && c[1] === ws.repo));
  await assert.rejects(issueGitCredential(ctx, a.participant, { repo: ws.repo }), /no active work repository/);
  assert.equal(claim(ctx, a.participant, {}).status, 'reserved', 'continuous mode resumes after integration');

  const verifier = await google(ctx);
  const rv = claim(ctx, verifier.participant, { task_id: ok.verification_tasks[0] });
  await assert.rejects(getWorkspace(ctx, verifier.participant, { reservation_id: rv.reservation.id }), /verifiers check out/);
});

test('integration conflict hands the workspace back; resubmission works; duplicate callbacks are ignored', async () => {
  const { ctx } = await world();
  const a = await anon(ctx);
  const r = claim(ctx, a.participant, {});
  const ws = await getWorkspace(ctx, a.participant, { reservation_id: r.reservation.id });
  submitCompletion(ctx, a.participant, { reservation_id: r.reservation.id, completion: wsCompletion(ws.workspace_id) });
  const fail = integrationResult(ctx, { workspace_id: ws.workspace_id, outcome: 'conflict', detail: 'task branch moved; pull base and merge' });
  assert.equal(fail.status, 'integration_failed');
  assert.ok((await issueGitCredential(ctx, a.participant, { repo: ws.repo })).password);
  assert.equal(integrationResult(ctx, { workspace_id: ws.workspace_id, outcome: 'conflict' }).status, 'ignored');
  const again = submitCompletion(ctx, a.participant, { reservation_id: r.reservation.id, completion: wsCompletion(ws.workspace_id) });
  assert.equal(again.status, 'integrating');
});

test('forbidden content found by the integrator revokes access at once and queues deletion', async () => {
  const { ctx, provisioner } = await world();
  const a = await anon(ctx);
  const r = claim(ctx, a.participant, {});
  const ws = await getWorkspace(ctx, a.participant, { reservation_id: r.reservation.id });
  submitCompletion(ctx, a.participant, { reservation_id: r.reservation.id, completion: wsCompletion(ws.workspace_id) });
  assert.equal(integrationResult(ctx, { workspace_id: ws.workspace_id, outcome: 'forbidden_content', detail: 'textures.rpf' }).status, 'revoked_for_forbidden_content');
  await assert.rejects(issueGitCredential(ctx, a.participant, { repo: ws.repo }), /no active work repository/);
  await reconcileWorkspaces(ctx);
  await reconcileWorkspaces(ctx);
  assert.ok(provisioner.calls.some((c) => c[0] === 'cleanup' && c[1] === ws.repo));
  assert.equal(getTask(ctx.store, 'R0Y00/Xbox2Windows#77').status, 'open');
});

test('credential endpoint over HTTP validates host/path and requires the coordinator token', async () => {
  const { app, ctx } = await world();
  const a = await anon(ctx);
  const r = claim(ctx, a.participant, {});
  const ws = await getWorkspace(ctx, a.participant, { reservation_id: r.reservation.id });
  const post = (body, token = a.token) =>
    app.handle(new Request('https://c.example/api/git/credential', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  assert.equal((await post({ host: 'github.com', path: `${ws.repo}.git` })).status, 200);
  assert.equal((await post({ host: 'gitlab.com', path: `${ws.repo}.git` })).status, 400);
  assert.equal((await post({ host: 'github.com', path: 'x' })).status, 400);
  assert.equal((await post({ host: 'github.com', path: `${ws.repo}.git` }, 'g6a_invalidinvalidinvalidinvalid')).status, 401);
});

test('integration callback and GitHub webhooks need their secrets; merged PR closes the task', async () => {
  const env = baseEnv({ INTEGRATION_CALLBACK_SECRET: 'cb-secret', GITHUB_WEBHOOK_SECRET: 'wh-secret', GITHUB_APP_FORKS_INSTALLATION_ID: '42' });
  const { app, ctx } = await world({ env });
  const a = await anon(ctx);
  const r = claim(ctx, a.participant, {});
  const ws = await getWorkspace(ctx, a.participant, { reservation_id: r.reservation.id });
  submitCompletion(ctx, a.participant, { reservation_id: r.reservation.id, completion: wsCompletion(ws.workspace_id) });
  const cb = (secret, body) => app.handle(new Request('https://c.example/api/integration', { method: 'POST', headers: { 'x-coordinator-secret': secret }, body: JSON.stringify(body) }));
  const body = { workspace_id: ws.workspace_id, outcome: 'integrated', commit_sha: head, pr_url: 'https://github.com/gta6-forks/Xbox2Windows/pull/9' };
  assert.equal((await cb('nope', body)).status, 401);
  assert.equal((await cb('cb-secret', body)).status, 200);

  ctx.store.exec("UPDATE reviews SET state = 'ready_to_merge' WHERE workspace_id = ?", ws.workspace_id);
  const signed = async (p) => { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('wh-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(p)))].map((b) => b.toString(16).padStart(2, '0')).join(''); };
  const foreign = JSON.stringify({ installation: { id: 999 }, action: 'closed', pull_request: { merged: true, html_url: body.pr_url, head: { sha: head } } });
  const fres = await app.handle(new Request('https://c.example/api/github/webhook', { method: 'POST', headers: { 'x-hub-signature-256': `sha256=${await signed(foreign)}`, 'x-github-event': 'pull_request', 'x-github-delivery': 'd-0' }, body: foreign }));
  assert.equal((await fres.json()).reason, 'unknown_installation', 'events from installations that are not ours are ignored');
  const payload = JSON.stringify({ installation: { id: 42 }, action: 'closed', pull_request: { merged: true, html_url: body.pr_url, head: { sha: head } } });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('wh-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const hook = (signature) =>
    app.handle(new Request('https://c.example/api/github/webhook', { method: 'POST', headers: { 'x-hub-signature-256': signature, 'x-github-event': 'pull_request', 'x-github-delivery': 'd-1' }, body: payload }));
  assert.equal((await hook('sha256=deadbeef')).status, 401);
  const res = await hook(`sha256=${sig}`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'merged');
  assert.equal(getTask(ctx.store, 'R0Y00/Xbox2Windows#77').status, 'done');
  assert.equal((await (await hook(`sha256=${sig}`)).json()).status, 'duplicate_delivery');
  assert.equal(await verifySignature('wh-secret', new Headers({ 'x-hub-signature-256': `sha256=${sig}` }), payload), true);
});

test('integrator content scan blocks game data, workflow edits and large files', () => {
  assert.deepEqual(scanChanges([{ path: 'src/pe_map.cpp', size: 1000 }]), []);
  assert.equal(scanChanges([{ path: 'dump/common.rpf', size: 10 }]).length, 1);
  assert.equal(scanChanges([{ path: '.github/workflows/x.yml', size: 10 }]).length, 1);
  assert.equal(scanChanges([{ path: 'big.bin', size: 6 * 1024 * 1024 }]).length, 1);
  assert.equal(scanChanges([{ path: 'game-files/a.txt', size: 1 }]).length, 1);
  const leaked = redact('git -c http.extraheader=AUTHORIZATION: basic eC1hY2Nlc3M6Z2hzXzE= failed; token ghs_abcDEF123');
  assert.ok(!/eC1hY2Nl|ghs_abc/.test(leaked), 'integrator errors never carry tokens');
});

test('seeding: no credential until the trusted Action seeds the work repo with the task branch', async () => {
  class SeedingProvisioner extends FakeProvisioner {
    async provision({ workspace }) {
      this.calls.push(['provision', workspace.id]);
      return { status: 'seeding', repo_full_name: `gta6-work/w-${workspace.id.slice(3)}`, base_sha: 'b'.repeat(40) };
    }
  }
  const { ctx, provisioner } = await world({ provisioner: new SeedingProvisioner() });
  const a = await anon(ctx);
  const r = claim(ctx, a.participant, {});
  const ws = await getWorkspace(ctx, a.participant, { reservation_id: r.reservation.id });
  assert.equal(ws.state, 'requested');
  assert.ok(ws.repo);
  await assert.rejects(issueGitCredential(ctx, a.participant, { repo: ws.repo }));
  const again = await getWorkspace(ctx, a.participant, { reservation_id: r.reservation.id });
  assert.equal(again.workspace_id, ws.workspace_id);
  assert.equal(provisioner.calls.filter((c) => c[0] === 'provision').length, 1, 'no re-provisioning while seeding');
  assert.throws(() => integrationResult(ctx, { workspace_id: ws.workspace_id, outcome: 'seeded', commit_sha: 'c'.repeat(40) }), /base/);
  assert.equal(integrationResult(ctx, { workspace_id: ws.workspace_id, outcome: 'seeded', commit_sha: 'b'.repeat(40) }).status, 'ready');
  const cred = await issueGitCredential(ctx, a.participant, { repo: ws.repo });
  assert.equal(cred.username, 'x-access-token');
});
