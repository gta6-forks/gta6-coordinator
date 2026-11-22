import test from 'node:test';
import assert from 'node:assert/strict';
import { finishLogin, googleConfigured, redirectUri, startLogin, verifyIdToken } from '../src/auth/google-oidc.js';
import { b64url } from '../src/util.js';
import { FakeKV } from './helpers.js';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

async function keyPair(kid = 'k1') {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { pair, jwks: { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }, kid };
}

async function sign(pair, kid, claims) {
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: 'RS256', kid, typ: 'JWT' });
  const body = enc(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

function env(kv = new FakeKV()) {
  return { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'placeholder-not-real', OAUTH_KV: kv, PUBLIC_BASE_URL: 'http://localhost:8787' };
}

const nowMs = Date.UTC(2026, 10, 21, 12);
const baseClaims = (o = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '1234',
  email: 'p@example.test',
  email_verified: true,
  iat: nowMs / 1000 - 10,
  exp: nowMs / 1000 + 3600,
  nonce: 'n1',
  ...o,
});

test('google login is disabled until the owner configures client id, secret, KV and base URL', async () => {
  assert.equal(googleConfigured({}), false);
  await assert.rejects(startLogin({}), /not configured/);
  assert.equal(googleConfigured(env()), true);
});

test('start builds an authorization-code + PKCE URL and stores state in KV', async () => {
  const kv = new FakeKV();
  const url = new URL(await startLogin(env(kv)));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), redirectUri(env(kv)));
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.ok(!url.toString().includes('placeholder-not-real'), 'client secret never goes to the browser');
  const saved = await kv.get(`oauth_state:${url.searchParams.get('state')}`, 'json');
  assert.ok(saved.verifier && saved.nonce);
});

test('ID token verification checks signature, issuer, audience, expiry, nonce and email_verified', async () => {
  const { pair, jwks, kid } = await keyPair();
  const fetchImpl = async () => new Response(JSON.stringify(jwks));
  const e = env();
  const ok = await verifyIdToken(e, await sign(pair, kid, baseClaims()), { nonce: 'n1', fetchImpl, now: () => nowMs });
  assert.equal(ok.sub, '1234');
  const bad = async (claims, re, opts = {}) =>
    assert.rejects(verifyIdToken(env(), await sign(pair, kid, claims), { nonce: 'n1', fetchImpl, now: () => nowMs, ...opts }), re);
  await bad(baseClaims({ aud: 'other' }), /audience/);
  await bad(baseClaims({ iss: 'https://evil.example' }), /issuer/);
  await bad(baseClaims({ exp: nowMs / 1000 - 3600 }), /expired/);
  await bad(baseClaims({ nonce: 'other' }), /nonce/);
  await bad(baseClaims({ email_verified: false }), /verified/);
  const other = await keyPair('k1');
  await assert.rejects(verifyIdToken(env(), await sign(other.pair, 'k1', baseClaims()), { nonce: 'n1', fetchImpl, now: () => nowMs }), /signature/);
});

test('callback consumes state once and exchanges the code with the secret server-side', async () => {
  const { pair, jwks, kid } = await keyPair();
  const kv = new FakeKV();
  const e = env(kv);
  const url = new URL(await startLogin(e));
  const state = url.searchParams.get('state');
  const { nonce } = await kv.get(`oauth_state:${state}`, 'json');
  const idToken = await sign(pair, kid, baseClaims({ nonce }));
  const calls = [];
  const fetchImpl = async (u, init) => {
    calls.push({ u: String(u), body: init?.body ? String(init.body) : '' });
    if (String(u).includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ id_token: idToken }));
    return new Response(JSON.stringify(jwks));
  };
  const { claims, link } = await finishLogin(e, { code: 'abc', state }, { fetchImpl, now: () => nowMs });
  assert.equal(link, null);
  assert.equal(claims.email, 'p@example.test');
  const tokenCall = calls.find((c) => c.u.includes('/token'));
  assert.match(tokenCall.body, /code_verifier=/);
  assert.match(tokenCall.body, /grant_type=authorization_code/);
  await assert.rejects(finishLogin(e, { code: 'abc', state }, { fetchImpl, now: () => nowMs }), /state/);
});
