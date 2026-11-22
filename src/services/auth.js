// MCP-level identity: anonymous participants (persistent bearer token, operational only) and
// Google participants (OIDC, strategic + operational). This is NOT GitHub write authentication,
// which is still pending a decision (see src/github/write-adapter.js).
import { AppError, randomId, randomToken, sha256Hex } from '../util.js';

// Public, privacy-preserving name used in leaderboards. Never derived from e-mail or Google profile name.
const ADJ = ['agil', 'calmo', 'firme', 'lucido', 'preciso', 'sereno', 'veloz', 'atento', 'claro', 'leal'];
const NOUN = ['falcao', 'lince', 'coruja', 'raposa', 'tucano', 'jaguar', 'garca', 'onca', 'arara', 'boto'];
function aliasFor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `${ADJ[h % ADJ.length]}-${NOUN[(h >>> 8) % NOUN.length]}-${id.slice(-4).toLowerCase()}`;
}
import { recordEvent } from '../store/store.js';
import { validate } from '../schema/validate.js';
import { profileSchema } from '../schema/schemas.js';

export const TOKEN_PREFIX = { anonymous: 'g6a_', google: 'g6g_' };

async function hashToken(ctx, token) {
  return sha256Hex(`${ctx.env.TOKEN_PEPPER ?? ''}:${token}`);
}

async function issueToken(ctx, participant) {
  const token = `${TOKEN_PREFIX[participant.kind]}${randomToken(32)}`;
  const hash = await hashToken(ctx, token);
  ctx.store.exec('INSERT INTO tokens (hash, participant_id, created_at) VALUES (?, ?, ?)', hash, participant.id, ctx.now());
  return token;
}

function rowToParticipant(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    display_name: row.display_name,
    public_alias: row.public_alias,
    email: row.email ?? null,
    profile: row.profile_json ? JSON.parse(row.profile_json) : null,
    created_at: row.created_at,
  };
}

export function getParticipant(ctx, id) {
  return rowToParticipant(ctx.store.one('SELECT * FROM participants WHERE id = ? AND revoked = 0', id));
}

/** Fixed-window limiter kept in the Durable Object, so it is consistent (KV would be eventually consistent). */
export function checkRateLimit(ctx, bucket, limit, windowMs) {
  const now = ctx.now();
  return ctx.store.tx(() => {
    const row = ctx.store.one('SELECT count, window_start FROM rate_limits WHERE bucket = ?', bucket);
    if (!row || now - row.window_start >= windowMs) {
      ctx.store.exec(
        'INSERT INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET count = 1, window_start = excluded.window_start',
        bucket,
        now,
      );
      return true;
    }
    if (row.count >= limit) return false;
    ctx.store.exec('UPDATE rate_limits SET count = count + 1 WHERE bucket = ?', bucket);
    return true;
  });
}

export async function createAnonymous(ctx, { display_name } = {}) {
  const id = randomId('anon_');
  const name = (typeof display_name === 'string' && display_name.trim().slice(0, 40)) || `anon-${id.slice(5, 11)}`;
  const token = `${TOKEN_PREFIX.anonymous}${randomToken(32)}`;
  const hash = await hashToken(ctx, token);
  ctx.store.tx(() => {
    ctx.store.exec(
      'INSERT INTO participants (id, kind, display_name, public_alias, created_at) VALUES (?, ?, ?, ?, ?)',
      id, 'anonymous', name, aliasFor(id), ctx.now(),
    );
    ctx.store.exec('INSERT INTO tokens (hash, participant_id, created_at) VALUES (?, ?, ?)', hash, id, ctx.now());
    recordEvent(ctx.store, ctx.now(), id, 'participant.created', { kind: 'anonymous' });
  });
  return { participant: getParticipant(ctx, id), token };
}

/** `claims` must come from a verified Google ID token (see auth/google-oidc.js). */
export async function loginGoogle(ctx, claims) {
  if (!claims?.sub || claims.email_verified !== true) throw new AppError('google_claims_invalid', 'verified Google claims required', 401);
  let row = ctx.store.one('SELECT * FROM participants WHERE google_sub = ?', claims.sub);
  if (row?.revoked) throw new AppError('participant_revoked', 'participant revoked', 403);
  if (!row) {
    const id = randomId('ggl_');
    ctx.store.tx(() => {
      ctx.store.exec(
        'INSERT INTO participants (id, kind, google_sub, email, display_name, public_alias, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, 'google', claims.sub, claims.email ?? null, (claims.name || 'google-user').slice(0, 80), aliasFor(id), ctx.now(),
      );
      recordEvent(ctx.store, ctx.now(), id, 'participant.created', { kind: 'google' });
    });
    row = ctx.store.one('SELECT * FROM participants WHERE id = ?', id);
  }
  const participant = rowToParticipant(row);
  const token = await issueToken(ctx, participant);
  return { participant, token };
}

export async function authenticate(ctx, authorization) {
  const m = /^Bearer\s+(g6[ag]_[A-Za-z0-9_-]{20,})$/.exec(authorization ?? '');
  if (!m) throw new AppError('unauthorized', 'missing or malformed bearer token', 401);
  const hash = await hashToken(ctx, m[1]);
  const row = ctx.store.one(
    `SELECT p.* FROM tokens t JOIN participants p ON p.id = t.participant_id
     WHERE t.hash = ? AND t.revoked = 0 AND p.revoked = 0`,
    hash,
  );
  if (!row) throw new AppError('unauthorized', 'unknown or revoked token', 401);
  ctx.store.exec('UPDATE tokens SET last_used_at = ? WHERE hash = ?', ctx.now(), hash);
  return rowToParticipant(row);
}

export async function revokeToken(ctx, token) {
  const hash = await hashToken(ctx, token);
  return ctx.store.exec('UPDATE tokens SET revoked = 1 WHERE hash = ?', hash).rowsWritten > 0;
}

export function setProfile(ctx, participant, profile) {
  const errors = validate(profileSchema, profile);
  if (errors.length) throw new AppError('invalid_profile', 'profile does not match schema', 400, { errors });
  ctx.store.exec('UPDATE participants SET profile_json = ? WHERE id = ?', JSON.stringify(profile), participant.id);
  recordEvent(ctx.store, ctx.now(), participant.id, 'participant.profile_set', {});
  return getParticipant(ctx, participant.id);
}

export const GOOGLE_LINK_TTL_MS = 10 * 60 * 1000;

/** One-time code (10 min) that upgrades THIS anonymous participant to Google; the bearer token stays the same. */
export async function createGoogleLink(ctx, participant) {
  if (participant.kind !== 'anonymous') return null;
  const code = randomToken(24);
  const now = ctx.now();
  ctx.store.exec('DELETE FROM google_links WHERE expires_at < ?', now - GOOGLE_LINK_TTL_MS);
  ctx.store.exec(
    'INSERT INTO google_links (code_hash, participant_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    await sha256Hex(`link:${code}`), participant.id, now, now + GOOGLE_LINK_TTL_MS,
  );
  return { code, expires_at: new Date(now + GOOGLE_LINK_TTL_MS).toISOString() };
}

/** Consumes a link code (single use) and promotes its anonymous participant using verified Google claims. */
export async function linkGoogle(ctx, code, claims) {
  if (!claims?.sub || claims.email_verified !== true) throw new AppError('google_claims_invalid', 'verified Google claims required', 401);
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(code ?? '')) throw new AppError('link_invalid', 'This sign-in link is invalid.', 400);
  const hash = await sha256Hex(`link:${code}`);
  return ctx.store.tx(() => {
    const now = ctx.now();
    const link = ctx.store.one('SELECT * FROM google_links WHERE code_hash = ?', hash);
    if (!link || link.used_at || link.expires_at <= now) {
      throw new AppError('link_expired', 'This sign-in link expired or was already used.', 400);
    }
    ctx.store.exec('UPDATE google_links SET used_at = ? WHERE code_hash = ?', now, hash);
    const row = ctx.store.one('SELECT * FROM participants WHERE id = ?', link.participant_id);
    if (!row || row.revoked) throw new AppError('participant_revoked', 'This participant was revoked.', 403);
    if (row.kind === 'google') {
      if (row.google_sub === claims.sub) return rowToParticipant(row);
      throw new AppError('already_linked', 'This key is already linked to another Google account.', 409);
    }
    const other = ctx.store.one('SELECT id FROM participants WHERE google_sub = ?', claims.sub);
    if (other) {
      throw new AppError('google_account_in_use', 'This Google account is already linked to another key. Use that key, or sign in with a different Google account.', 409);
    }
    ctx.store.exec(
      "UPDATE participants SET kind = 'google', google_sub = ?, email = ?, display_name = ? WHERE id = ?",
      claims.sub, claims.email ?? null, (claims.name || row.display_name || 'google-user').slice(0, 80), row.id,
    );
    recordEvent(ctx.store, now, row.id, 'participant.google_linked', {});
    return rowToParticipant(ctx.store.one('SELECT * FROM participants WHERE id = ?', row.id));
  });
}
