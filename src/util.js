// Utilities shared by the Worker, the Durable Object and the Node tooling.
// Only Web-standard APIs (crypto.subtle, btoa/atob) so the same code runs on Workers and Node 24.

export const ISSUE_ID = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;
export const LOCAL_ID = /^local:[a-z0-9][a-z0-9/_.-]*$/;
export const DRAFT_ID = /^draft:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/[a-z0-9-]+$/;
export const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const PRIORITY_ORDER = { p0: 0, p1: 1, p2: 2, p3: 3 };
export const DIFFICULTY_ORDER = { low: 0, medium: 1, high: 2 };

export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
  toJSON() {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url(a);
}

export function randomId(prefix, bytes = 9) {
  return `${prefix}${randomToken(bytes)}`;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256B64url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return b64url(new Uint8Array(digest));
}

export function parseTaskId(id) {
  let m = ISSUE_ID.exec(id);
  if (m) return { kind: 'github', repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
  m = DRAFT_ID.exec(id);
  if (m) return { kind: 'draft', repo: `${m[1]}/${m[2]}`, number: null };
  if (LOCAL_ID.test(id)) return { kind: 'local', repo: null, number: null };
  return null;
}

// Keys that must never carry a string value in anything the coordinator returns to an agent.
const SECRET_KEY = /(token|secret|password|passwd|private[_-]?key|deploy[_-]?key|ssh[_-]?key|credential|api[_-]?key)/i;
const ALLOWED_SECRETLIKE_KEYS = new Set(['token_prefix', 'credential_issued', 'credentials_issued']);

export function findSecretLikeFields(value, path = '$', found = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => findSecretLikeFields(v, `${path}[${i}]`, found));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k) && !ALLOWED_SECRETLIKE_KEYS.has(k) && typeof v === 'string' && v.length > 0) {
        found.push(`${path}.${k}`);
      }
      findSecretLikeFields(v, `${path}.${k}`, found);
    }
  }
  return found;
}

export function assertNoSecrets(value) {
  const found = findSecretLikeFields(value);
  if (found.length) throw new AppError('secret_leak_blocked', `refusing to return secret-like fields: ${found.join(', ')}`, 500);
  return value;
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(err) {
  if (err instanceof AppError) return json({ error: err.toJSON() }, err.status);
  return json({ error: { code: 'internal_error', message: 'internal error' } }, 500);
}

/** Lowercase hex id; safe inside `local:` task ids. */
export function randomHexId(prefix, bytes = 8) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return prefix + [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
