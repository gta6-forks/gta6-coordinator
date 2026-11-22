// Anonymous key -> Google without copy/paste: whoami returns a one-time link; the callback upgrades the SAME participant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRpc } from '../src/mcp/server.js';
import { claim } from '../src/services/scheduler.js';
import { createGoogleLink, linkGoogle, loginGoogle } from '../src/services/auth.js';
import { anon, baseEnv, google, HOUR, setup } from './helpers.js';
import { FakeKV } from './helpers.js';

const env = () => baseEnv({ GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'x', OAUTH_KV: new FakeKV(), PUBLIC_BASE_URL: 'https://c.example' });
const claims = (n) => ({ sub: `link-sub-${n}`, email: `l${n}@example.test`, email_verified: true, name: `Linked ${n}` });
const call = (ctx, token, name, args = {}) =>
  handleRpc(ctx, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, `Bearer ${token}`);

test('whoami gives anonymous participants a one-time google_link_url; the same token becomes strategic', async () => {
  const { ctx } = await setup({ env: env() });
  const a = await anon(ctx);
  const who = (await call(ctx, a.token, 'whoami')).result.structuredContent;
  const url = new URL(who.google_link_url);
  assert.equal(url.origin + url.pathname, 'https://c.example/auth/google/start');
  const code = url.searchParams.get('link');
  assert.throws(() => claim(ctx, a.participant, { task_id: 'local:plan/bootstrap-issues' }));

  const p = await linkGoogle(ctx, code, claims(1));
  assert.equal(p.id, a.participant.id);
  assert.equal(p.kind, 'google');
  const who2 = (await call(ctx, a.token, 'whoami')).result.structuredContent;
  assert.equal(who2.participant.kind, 'google', 'same bearer token, now Google');
  assert.equal(who2.google_link_url, undefined);
  assert.equal(claim(ctx, p, { task_id: 'local:plan/bootstrap-issues' }).status, 'reserved');
  await assert.rejects(linkGoogle(ctx, code, claims(1)), /expired or was already used/);
});

test('link codes expire, need verified claims, and never hijack an existing Google account', async () => {
  const { ctx, now } = await setup({ env: env() });
  const a = await anon(ctx);
  const l1 = await createGoogleLink(ctx, a.participant);
  now.advance(11 * 60 * 1000);
  await assert.rejects(linkGoogle(ctx, l1.code, claims(2)), /expired/);
  const l2 = await createGoogleLink(ctx, a.participant);
  await assert.rejects(linkGoogle(ctx, l2.code, { ...claims(2), email_verified: false }), /verified/);
  await loginGoogle(ctx, { sub: 'taken-sub', email_verified: true, name: 'Existing' });
  await assert.rejects(linkGoogle(ctx, l2.code, { sub: 'taken-sub', email_verified: true }), (e) => e.code === 'google_account_in_use');
  const fresh = await anon(ctx);
  assert.equal((await call(ctx, fresh.token, 'whoami')).result.structuredContent.participant.kind, 'anonymous', 'refused link leaves the key anonymous');
  const g = await google(ctx);
  assert.equal(await createGoogleLink(ctx, g.participant), null, 'only anonymous participants get a link');
  await assert.rejects(linkGoogle(ctx, 'short', claims(3)), /invalid/);
  void HOUR;
});
