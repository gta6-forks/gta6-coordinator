// End-to-end through the public Worker: static assets fallback, anonymous sign-up, MCP over HTTP,
// forwarding to the Durable Object, internal routes not reachable, Google flow disabled until configured.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { createApp } from '../src/app.js';
import { baseEnv, clock, createNodeStore, FakeKV } from './helpers.js';

function fakeNamespace(app) {
  return {
    idFromName: (n) => n,
    get: () => ({ fetch: (req) => app.handle(req) }),
  };
}

async function makeEnv(extra = {}) {
  const env = { ...baseEnv(), PUBLIC_BASE_URL: 'https://coord.example', OAUTH_KV: new FakeKV(), ...extra };
  const app = createApp({ store: createNodeStore(), env, now: clock() });
  await app.ensureSeeded();
  env.COORDINATOR = fakeNamespace(app);
  env.ASSETS = { fetch: async () => new Response('<!doctype html>landing', { headers: { 'content-type': 'text/html' } }) };
  return env;
}

const rpc = (env, token, method, params = {}, id = 1) =>
  worker.fetch(
    new Request('https://coord.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }),
    env,
  ).then((r) => r.json());

test('full anonymous flow over HTTP: sign up, initialize, list tools, set profile, claim, release', async () => {
  const env = await makeEnv();
  const signup = await worker.fetch(new Request('https://coord.example/auth/anonymous', { method: 'POST', body: '{}' }), env);
  assert.equal(signup.status, 200);
  const { token, mcp_url } = await signup.json();
  assert.equal(mcp_url, 'https://coord.example/mcp');

  const init = await rpc(env, null, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);

  const tools = await rpc(env, null, 'tools/list');
  assert.ok(tools.result.tools.find((t) => t.name === 'claim_next_task'));
  assert.ok(!tools.result.tools.find((t) => t.name === 'renew_reservation'), 'no renewal tool');

  const unauth = await rpc(env, null, 'tools/call', { name: 'whoami', arguments: {} });
  assert.equal(unauth.error.code, -32001);

  const call = (name, args) => rpc(env, token, 'tools/call', { name, arguments: args }).then((r) => r.result);
  assert.equal((await call('set_profile', { os: ['windows'], gpu_vendor: 'nvidia', has_own_game_copy: false })).isError, false);
  const claimed = (await call('claim_next_task', { idempotency_key: 'http-flow-0001' })).structuredContent;
  assert.equal(claimed.status, 'reserved');
  assert.equal(claimed.task.id, 'R0Y00/Xbox2Windows#77');
  const again = (await call('claim_next_task', {})).structuredContent;
  assert.equal(again.error.code, 'active_reservation_exists');
  assert.equal((await call('release_reservation', { reservation_id: claimed.reservation.id, reason: 'teste' })).structuredContent.status, 'released');
  const who = (await call('whoami', {})).structuredContent;
  assert.equal(who.participant.kind, 'anonymous');
  assert.ok(!JSON.stringify(who).includes(token));
});

test('notifications get 202 and unknown methods a JSON-RPC error', async () => {
  const env = await makeEnv();
  const res = await worker.fetch(
    new Request('https://coord.example/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) }),
    env,
  );
  assert.equal(res.status, 202);
  assert.equal((await rpc(env, null, 'nope')).error.code, -32601);
  const get = await worker.fetch(new Request('https://coord.example/mcp'), env);
  assert.equal(get.status, 405);
});

test('browser requests from foreign origins are refused (DNS-rebinding / CSRF guard)', async () => {
  const env = await makeEnv();
  const res = await worker.fetch(
    new Request('https://coord.example/mcp', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }),
    env,
  );
  assert.equal(res.status, 403);
  const ok = await worker.fetch(
    new Request('https://coord.example/auth/anonymous', { method: 'POST', headers: { origin: 'https://coord.example' }, body: '{}' }),
    env,
  );
  assert.equal(ok.status, 200);
});

test('internal Durable Object routes are not reachable from the public Worker', async () => {
  const env = await makeEnv();
  for (const p of ['/internal/anonymous', '/internal/google-login', '/internal/sync']) {
    const res = await worker.fetch(new Request(`https://coord.example${p}`, { method: 'POST', body: '{"claims":{"sub":"x","email_verified":true}}' }), env);
    assert.equal(res.status, 404, p);
  }
});

test('Google login reports not configured until the owner sets the OAuth client secrets', async () => {
  const env = await makeEnv();
  const cfg = await (await worker.fetch(new Request('https://coord.example/api/config'), env)).json();
  assert.equal(cfg.google_login, false);
  assert.equal(cfg.github_write, 'pending_decision');
  const start = await worker.fetch(new Request('https://coord.example/auth/google/start'), env);
  assert.equal(start.status, 503);

  const configured = await makeEnv({ GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'placeholder' });
  const redirect = await worker.fetch(new Request('https://coord.example/auth/google/start'), configured);
  assert.equal(redirect.status, 302);
  const loc = new URL(redirect.headers.get('location'));
  assert.equal(loc.hostname, 'accounts.google.com');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://coord.example/auth/google/callback');
});

test('public task catalog and health; landing is served from static assets', async () => {
  const env = await makeEnv();
  const tasks = await (await worker.fetch(new Request('https://coord.example/api/tasks'), env)).json();
  assert.ok(tasks.tasks.length >= 12);
  assert.equal(tasks.reservation_policy.ttlMs, 24 * 3600_000);
  assert.ok(!JSON.stringify(tasks).includes('@'), 'no emails in the public catalog');
  const health = await (await worker.fetch(new Request('https://coord.example/health'), env)).json();
  assert.equal(health.git_write.writes_enabled, false);
  const landing = await worker.fetch(new Request('https://coord.example/'), env);
  assert.match(await landing.text(), /landing/);
});

test('CI webhook needs the shared secret', async () => {
  const env = await makeEnv({ CI_WEBHOOK_SECRET: 's3cret-value' });
  const body = JSON.stringify({ commit_sha: 'a'.repeat(40), conclusion: 'success' });
  const bad = await worker.fetch(new Request('https://coord.example/api/ci', { method: 'POST', headers: { 'x-coordinator-secret': 'nope' }, body }), env);
  assert.equal(bad.status, 401);
  const good = await worker.fetch(new Request('https://coord.example/api/ci', { method: 'POST', headers: { 'x-coordinator-secret': 's3cret-value' }, body }), env);
  assert.equal(good.status, 200);
  const off = await makeEnv();
  const disabled = await worker.fetch(new Request('https://coord.example/api/ci', { method: 'POST', body }), off);
  assert.equal(disabled.status, 503);
});
