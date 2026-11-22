import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, createAnonymous, loginGoogle, revokeToken, checkRateLimit } from '../src/services/auth.js';
import { setup } from './helpers.js';

test('anonymous participant gets a persistent token that is stored only as a hash', async () => {
  const { ctx, store } = await setup();
  const { participant, token } = await createAnonymous(ctx, { display_name: 'tester' });
  assert.match(token, /^g6a_/);
  assert.equal(participant.kind, 'anonymous');
  const rows = store.all('SELECT hash FROM tokens');
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].hash, token);
  assert.ok(!JSON.stringify(store.all('SELECT * FROM tokens')).includes(token));
  const again = await authenticate(ctx, `Bearer ${token}`);
  assert.equal(again.id, participant.id);
});

test('revoked or malformed tokens are rejected', async () => {
  const { ctx } = await setup();
  const { token } = await createAnonymous(ctx, {});
  await assert.rejects(authenticate(ctx, 'Bearer nope'), /malformed/);
  await assert.rejects(authenticate(ctx, `Token ${token}`), /malformed/);
  assert.equal(await revokeToken(ctx, token), true);
  await assert.rejects(authenticate(ctx, `Bearer ${token}`), /revoked/);
});

test('pepper matters: the same token does not authenticate under another pepper', async () => {
  const { ctx } = await setup();
  const { token } = await createAnonymous(ctx, {});
  const other = { ...ctx, env: { ...ctx.env, TOKEN_PEPPER: 'different' } };
  await assert.rejects(authenticate(other, `Bearer ${token}`));
});

test('google login requires verified claims and reuses the participant by sub', async () => {
  const { ctx } = await setup();
  await assert.rejects(loginGoogle(ctx, { sub: 'x', email_verified: false }), /verified/);
  const a = await loginGoogle(ctx, { sub: 'abc', email: 'a@example.test', email_verified: true, name: 'A' });
  const b = await loginGoogle(ctx, { sub: 'abc', email: 'a@example.test', email_verified: true, name: 'A' });
  assert.equal(a.participant.id, b.participant.id);
  assert.match(a.token, /^g6g_/);
  assert.notEqual(a.token, b.token);
  assert.equal((await authenticate(ctx, `Bearer ${a.token}`)).kind, 'google');
});

test('anonymous sign-up rate limit is per bucket and per window', async () => {
  const { ctx, now } = await setup();
  for (let i = 0; i < 3; i++) assert.equal(checkRateLimit(ctx, 'anon:ip1', 3, 3600_000), true);
  assert.equal(checkRateLimit(ctx, 'anon:ip1', 3, 3600_000), false);
  assert.equal(checkRateLimit(ctx, 'anon:ip2', 3, 3600_000), true);
  now.advance(3600_001);
  assert.equal(checkRateLimit(ctx, 'anon:ip1', 3, 3600_000), true);
});
