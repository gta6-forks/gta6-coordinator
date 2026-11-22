// GitHubAppProvisioner against a simulated GitHub REST API. Locks in: every token with write permission covers
// exactly one repository; the participant token is contents:write on the work repo only; idempotent creation;
// archive on revoke; delete on cleanup; dispatch to the coordinator repo; retry on secondary rate limits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubAppProvisioner } from '../src/github/provisioner.js';
import { GitHubAppClient, hasWrite, importPrivateKey } from '../src/github/app-client.js';
import { b64urlDecode } from '../src/util.js';

async function pkcs8Pem() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const b64 = btoa(String.fromCharCode(...der)).match(/.{1,64}/g).join('\n');
  return { pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

function fakeGitHub({ existing = new Set(), rateLimitOnce = false } = {}) {
  const calls = [];
  const repos = new Map();
  const refs = new Map([['gta6-forks/Xbox2Windows:heads/main', 'f'.repeat(40)], ['gta6-forks/gta6-coordinator:heads/main', 'e'.repeat(40)]]);
  let limited = rateLimitOnce;
  let tok = 0;
  const reply = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, body, auth: init.headers.authorization });
    if (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(u.pathname)) {
      tok++;
      return reply(201, { token: `ghs_test_${tok}`, expires_at: '2026-11-21T13:00:00Z', repositories: body.repositories.map((n) => ({ name: n })) });
    }
    if (method === 'POST' && u.pathname === '/orgs/gta6-work/repos') {
      if (limited) {
        limited = false;
        return reply(403, { message: 'secondary rate limit' }, { 'retry-after': '1' });
      }
      if (existing.has(body.name) || repos.has(body.name)) return reply(422, { message: 'name already exists' });
      repos.set(body.name, body);
      return reply(201, { full_name: `gta6-work/${body.name}` });
    }
    const m = /^\/repos\/gta6-work\/([^/]+)$/.exec(u.pathname);
    if (m && method === 'GET') return repos.has(m[1]) || existing.has(m[1]) ? reply(200, { description: repos.get(m[1])?.description ?? 'someone else' }) : reply(404, {});
    if (m && method === 'PATCH') return reply(200, { archived: true });
    if (m && method === 'DELETE') return reply(204);
    if (/\/actions\/permissions$/.test(u.pathname)) return reply(204);
    if (/^\/repos\/gta6-forks\/[^/]+$/.test(u.pathname)) return reply(200, { default_branch: 'main' });
    const ref = /^\/repos\/(gta6-forks\/[^/]+)\/git\/ref\/(.+)$/.exec(u.pathname);
    if (ref) {
      const sha = refs.get(`${ref[1]}:${ref[2]}`);
      return sha ? reply(200, { object: { sha } }) : reply(404, {});
    }
    if (method === 'POST' && /\/git\/refs$/.test(u.pathname)) {
      refs.set(`${u.pathname.split('/').slice(2, 4).join('/')}:${body.ref.replace('refs/', '')}`, body.sha);
      return reply(201, {});
    }
    if (method === 'POST' && u.pathname === '/repos/gta6/coordinator/dispatches') return reply(204);
    return reply(500, { message: `unexpected ${method} ${u.pathname}` });
  };
  return { fetchImpl, calls, repos };
}

async function provisioner(gh) {
  const { pem } = await pkcs8Pem();
  const env = {
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: pem,
    GITHUB_APP_WORK_INSTALLATION_ID: '111',
    GITHUB_APP_FORKS_INSTALLATION_ID: '222',
    WORKSPACE_ORG: 'gta6-work',
    WORKSPACE_ANCHOR_REPO: '_anchor',
    COORDINATOR_REPO: 'gta6/coordinator',
  };
  return new GitHubAppProvisioner(env, { fetchImpl: gh.fetchImpl, sleep: async () => {} });
}

const workspace = { id: 'ws_0123456789abcdef', task_id: 'R0Y00/Xbox2Windows#77', task_branch: 'task/issue-77', integration_repo: 'gta6-forks/Xbox2Windows' };
const taskData = { id: 'R0Y00/Xbox2Windows#77', fork_repo: 'gta6-forks/Xbox2Windows' };

function tokenRequests(calls) {
  return calls.filter((c) => c.path.endsWith('/access_tokens')).map((c) => ({ inst: c.path.split('/')[3], ...c.body }));
}

test('provision creates one private repo without Actions and the fork task branch; every write token is single-repo', async () => {
  const gh = fakeGitHub();
  const p = await provisioner(gh);
  const out = await p.provision({ workspace, task: taskData });
  assert.equal(out.status, 'seeding');
  assert.equal(out.repo_full_name, 'gta6-work/w-0123456789abcdef');
  assert.equal(out.base_sha, 'f'.repeat(40));
  const created = gh.repos.get('w-0123456789abcdef');
  assert.equal(created.private, true);
  assert.equal(created.auto_init, false);
  assert.ok(gh.calls.some((c) => c.method === 'PUT' && c.path.endsWith('/actions/permissions') && c.body.enabled === false));
  assert.ok(gh.calls.some((c) => c.method === 'POST' && c.path.endsWith('/git/refs') && c.body.ref === 'refs/heads/task/issue-77'));
  const seed = gh.calls.find((c) => c.method === 'POST' && c.path.endsWith('/dispatches') && c.body.event_type === 'seed-workspace');
  assert.ok(seed, 'the work repository is seeded by the trusted Action');
  assert.equal(seed.body.client_payload.base_sha, 'f'.repeat(40));
  for (const t of tokenRequests(gh.calls)) {
    if (hasWrite(t.permissions)) assert.equal(t.repositories.length, 1, JSON.stringify(t));
  }
  const appCalls = gh.calls.filter((c) => c.path.endsWith('/access_tokens'));
  for (const c of appCalls) {
    const [, payload] = c.auth.replace('Bearer ', '').split('.');
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    assert.equal(claims.iss, '12345');
    assert.ok(claims.exp - claims.iat <= 600);
  }
});

test('participant credential: contents:write on the work repository only', async () => {
  const gh = fakeGitHub();
  const p = await provisioner(gh);
  const cred = await p.mintCredential({ workspace: { ...workspace, repo_full_name: 'gta6-work/w-0123456789abcdef' } });
  assert.equal(cred.username, 'x-access-token');
  const [req] = tokenRequests(gh.calls);
  assert.equal(req.inst, '111');
  assert.deepEqual(req.repositories, ['w-0123456789abcdef']);
  assert.deepEqual(req.permissions, { contents: 'write' });
});

test('creation is idempotent for the same workspace and refuses to adopt someone else\'s repo', async () => {
  const gh = fakeGitHub();
  const p = await provisioner(gh);
  await p.provision({ workspace, task: taskData });
  assert.equal((await p.provision({ workspace, task: taskData })).status, 'seeding');
  const other = fakeGitHub({ existing: new Set(['w-0123456789abcdef']) });
  const p2 = await provisioner(other);
  await assert.rejects(p2.provision({ workspace, task: taskData }), /not this workspace/);
});

test('secondary rate limit is retried; revoke archives; cleanup deletes; integrate dispatches to the coordinator repo', async () => {
  const gh = fakeGitHub({ rateLimitOnce: true });
  const p = await provisioner(gh);
  const out = await p.provision({ workspace, task: taskData });
  assert.equal(out.status, 'seeding');
  const ws = { ...workspace, repo_full_name: out.repo_full_name };
  assert.equal((await p.revoke({ workspace: ws })).status, 'archived');
  assert.ok(gh.calls.some((c) => c.method === 'PATCH' && c.body.archived === true));
  assert.equal((await p.integrate({ workspace: ws, head_sha: 'c'.repeat(40) })).status, 'dispatched');
  const dispatch = gh.calls.find((c) => c.path.endsWith('/dispatches') && c.body.event_type === 'integrate-workspace');
  assert.equal(dispatch.body.event_type, 'integrate-workspace');
  assert.equal(dispatch.body.client_payload.head_sha, 'c'.repeat(40));
  assert.ok(Object.keys(dispatch.body.client_payload).length <= 10, 'GitHub allows at most 10 top-level payload keys');
  assert.equal((await p.cleanup({ workspace: ws })).status, 'deleted');
  for (const t of tokenRequests(gh.calls)) if (hasWrite(t.permissions)) assert.equal(t.repositories.length, 1);
});

test('the client refuses multi-repository write tokens and PKCS#1 keys', async () => {
  const { pem } = await pkcs8Pem();
  const c = new GitHubAppClient({ appId: '1', privateKeyPem: pem, fetchImpl: async () => new Response('{}', { status: 201 }) });
  await assert.rejects(c.installationToken('1', { repositories: ['a', 'b'], permissions: { contents: 'write' } }), /only one repository/);
  await assert.rejects(c.installationToken('1', { repositories: ['a', 'b'] }), /only one repository/, 'no permissions = all installation permissions = write');
  await assert.rejects(c.installationToken('1', { repositories: [], permissions: { contents: 'read' } }), /name their repositories/);
  await assert.rejects(importPrivateKey('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'), /PKCS#8/);
});

test('missing task fork: provisioning reports it instead of creating anything', async () => {
  const gh = fakeGitHub();
  const p = await provisioner(gh);
  assert.equal((await p.provision({ workspace: { ...workspace, integration_repo: null }, task: { id: 'x', fork_repo: null } })).status, 'integration_repo_missing');
  assert.equal(gh.calls.length, 0);
});

test('planning tasks integrate into the coordinator repository', async () => {
  const gh = fakeGitHub();
  const p = await provisioner(gh);
  const out = await p.provision({ workspace: { ...workspace, task_branch: 'task/plan-bootstrap', integration_repo: 'gta6-forks/gta6-coordinator' }, task: { id: 'local:plan/bootstrap-issues', fork_repo: null } });
  assert.equal(out.status, 'seeding');
  assert.equal(out.integration_repo, 'gta6-forks/gta6-coordinator');
  assert.equal(out.base_sha, 'e'.repeat(40));
});
