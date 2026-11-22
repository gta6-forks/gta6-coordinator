// Google OAuth 2.0 / OpenID Connect, authorization-code flow with PKCE + state + nonce.
// The OAuth client (client ID/secret) belongs to a Google Cloud project administered by the owner;
// each participant signs in with their OWN Google account. Nothing here uses the owner's personal session.
// Runs in the Worker (Web Crypto + fetch). Secrets come from env (wrangler secrets), never from code.
import { AppError, b64url, b64urlDecode, randomToken, sha256B64url } from '../util.js';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const STATE_TTL_SECONDS = 600;

export function googleConfigured(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.OAUTH_KV && env.PUBLIC_BASE_URL);
}

export function redirectUri(env) {
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/auth/google/callback`;
}

/** Creates state + PKCE verifier + nonce, stores them in KV (TTL 10 min) and returns the Google URL. */
export async function startLogin(env, { link = null } = {}) {
  if (!googleConfigured(env)) throw new AppError('google_not_configured', 'Google OAuth is not configured on this deployment', 503);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const nonce = randomToken(24);
  await env.OAUTH_KV.put(`oauth_state:${state}`, JSON.stringify({ verifier, nonce, link: /^[A-Za-z0-9_-]{20,64}$/.test(link ?? '') ? link : null, created_at: Date.now() }), {
    expirationTtl: STATE_TTL_SECONDS,
  });
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri(env));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', await sha256B64url(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

/** Validates state (single use), exchanges the code and verifies the ID token. Returns { claims, link }. */
export async function finishLogin(env, { code, state }, { fetchImpl = fetch, now = Date.now } = {}) {
  if (!googleConfigured(env)) throw new AppError('google_not_configured', 'Google OAuth is not configured on this deployment', 503);
  if (!code || !state) throw new AppError('oauth_bad_request', 'missing code or state', 400);
  const key = `oauth_state:${state}`;
  const saved = await env.OAUTH_KV.get(key, 'json');
  if (!saved) throw new AppError('oauth_state_invalid', 'unknown or expired state', 400);
  await env.OAUTH_KV.delete(key);

  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(env),
      grant_type: 'authorization_code',
      code_verifier: saved.verifier,
    }),
  });
  if (!res.ok) throw new AppError('oauth_exchange_failed', `token endpoint returned ${res.status}`, 502);
  const body = await res.json();
  if (!body.id_token) throw new AppError('oauth_exchange_failed', 'no id_token in response', 502);
  const claims = await verifyIdToken(env, body.id_token, { nonce: saved.nonce, fetchImpl, now });
  return { claims, link: saved.link ?? null };
}

async function loadJwks(env, fetchImpl, { force = false } = {}) {
  const cacheKey = 'google_jwks';
  if (!force && env.OAUTH_KV) {
    const cached = await env.OAUTH_KV.get(cacheKey, 'json');
    if (cached?.keys) return cached;
  }
  const res = await fetchImpl(GOOGLE_JWKS_URL);
  if (!res.ok) throw new AppError('jwks_unavailable', `JWKS fetch returned ${res.status}`, 502);
  const jwks = await res.json();
  if (env.OAUTH_KV) await env.OAUTH_KV.put(cacheKey, JSON.stringify(jwks), { expirationTtl: 3600 });
  return jwks;
}

export async function verifyIdToken(env, idToken, { nonce, fetchImpl = fetch, now = Date.now } = {}) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new AppError('id_token_invalid', 'malformed JWT', 401);
  const dec = (s) => JSON.parse(new TextDecoder().decode(b64urlDecode(s)));
  let header;
  let claims;
  try {
    header = dec(parts[0]);
    claims = dec(parts[1]);
  } catch {
    throw new AppError('id_token_invalid', 'undecodable JWT', 401);
  }
  if (header.alg !== 'RS256' || !header.kid) throw new AppError('id_token_invalid', 'unexpected JWT header', 401);

  let jwks = await loadJwks(env, fetchImpl);
  let jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    jwks = await loadJwks(env, fetchImpl, { force: true });
    jwk = jwks.keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new AppError('id_token_invalid', 'signing key not found', 401);

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new AppError('id_token_invalid', 'bad signature', 401);

  const nowSec = Math.floor(now() / 1000);
  if (!ISSUERS.has(claims.iss)) throw new AppError('id_token_invalid', 'bad issuer', 401);
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw new AppError('id_token_invalid', 'bad audience', 401);
  if (typeof claims.exp !== 'number' || claims.exp < nowSec - 60) throw new AppError('id_token_invalid', 'expired', 401);
  if (typeof claims.iat === 'number' && claims.iat > nowSec + 300) throw new AppError('id_token_invalid', 'issued in the future', 401);
  if (nonce !== undefined && claims.nonce !== nonce) throw new AppError('id_token_invalid', 'nonce mismatch', 401);
  if (claims.email_verified !== true) throw new AppError('id_token_invalid', 'email not verified', 401);
  if (env.GOOGLE_ALLOWED_DOMAIN && claims.hd !== env.GOOGLE_ALLOWED_DOMAIN) {
    throw new AppError('id_token_invalid', 'account domain not allowed', 403);
  }
  return { sub: claims.sub, email: claims.email, email_verified: true, name: claims.name ?? null };
}

// Exported for tests that build their own signed tokens.
export const _internals = { b64url };
