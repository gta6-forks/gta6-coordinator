// Minimal GitHub App client for the Worker (Web Crypto + fetch).
// Rule enforced here: every installation token that carries ANY write permission is restricted to exactly one
// repository. Tokens are never cached or returned anywhere except mintCredential's single repo-scoped token.
import { AppError, b64url } from '../util.js';

const API = 'https://api.github.com';

export async function importPrivateKey(pem) {
  if (!pem) throw new AppError('github_app_not_configured', 'GITHUB_APP_PRIVATE_KEY missing', 503);
  if (pem.includes('BEGIN RSA PRIVATE KEY')) {
    throw new AppError('github_app_key_format', 'convert the App key to PKCS#8: openssl pkcs8 -topk8 -nocrypt -in app.pem -out app.pkcs8.pem', 503);
  }
  const b64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

export async function appJwt({ appId, key, nowMs }) {
  const now = Math.floor(nowMs / 1000);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: 'RS256', typ: 'JWT' });
  const body = enc({ iat: now - 60, exp: now + 540, iss: String(appId) });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

export function hasWrite(permissions) {
  return !permissions || Object.values(permissions).some((v) => v === 'write' || v === 'admin');
}

export class GitHubAppClient {
  constructor({ appId, privateKeyPem, fetchImpl = fetch, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    if (!appId) throw new AppError('github_app_not_configured', 'GITHUB_APP_ID missing', 503);
    this.appId = appId;
    this.privateKeyPem = privateKeyPem;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.key = null;
  }

  async #jwt() {
    this.key ??= await importPrivateKey(this.privateKeyPem);
    return appJwt({ appId: this.appId, key: this.key, nowMs: this.now() });
  }

  /** REST call with retries for secondary rate limits (403/429 + retry-after or remaining=0) and 5xx. */
  async request(method, path, { token, jwt = false, body, ok = [200, 201, 202, 204] } = {}) {
    const auth = jwt ? `Bearer ${await this.#jwt()}` : `Bearer ${token}`;
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: {
          authorization: auth,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'gta6-coordinator',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const limited = (res.status === 403 || res.status === 429) && (res.headers.get('retry-after') || res.headers.get('x-ratelimit-remaining') === '0');
      if ((limited || res.status >= 500) && attempt < 4) {
        const wait = Math.min(Number(res.headers.get('retry-after') ?? 1) * 1000 * attempt, 10_000);
        await this.sleep(wait);
        continue;
      }
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!ok.includes(res.status)) {
        const err = new AppError('github_api_error', `${method} ${path} -> ${res.status}`, 502, { status: res.status, message: data?.message ?? null });
        err.githubStatus = res.status;
        throw err;
      }
      return { status: res.status, data };
    }
  }

  /** Installation token. Any write permission => exactly one repository (hard rule). */
  async installationToken(installationId, { repositories, permissions }) {
    if (!installationId) throw new AppError('github_app_not_configured', 'installation id missing', 503);
    if (!Array.isArray(repositories) || repositories.length === 0) {
      throw new AppError('token_scope_required', 'installation tokens must name their repositories', 500);
    }
    if (hasWrite(permissions) && repositories.length !== 1) {
      throw new AppError('multi_repo_write_forbidden', 'a token with write permission may cover only one repository', 500);
    }
    const body = { repositories };
    if (permissions) body.permissions = permissions;
    const { data } = await this.request('POST', `/app/installations/${installationId}/access_tokens`, { jwt: true, body, ok: [201] });
    return { token: data.token, expires_at: data.expires_at, repositories: (data.repositories ?? []).map((r) => r.full_name ?? r.name) };
  }
}
