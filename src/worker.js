// Public Cloudflare Worker entry point.
//   - static landing page and onboarding: served by Workers Static Assets (./public) before this code runs
//   - /auth/google/*: OAuth/OIDC with the owner-administered Google OAuth client (secrets from env)
//   - /auth/anonymous: anonymous participant with a persistent bearer token (operational tasks only)
//   - /mcp, /api/*: forwarded to the single Coordinator Durable Object
// Participants write only to isolated work repositories (credential helper -> /api/git/credential).
// GitHub App credentials never leave the backend.
import { AppError, errorResponse, json, sha256Hex } from './util.js';
import { finishLogin, googleConfigured, startLogin } from './auth/google-oidc.js';
import { Coordinator } from './coordinator-do.js';

export { Coordinator };

function coordinator(env) {
  return env.COORDINATOR.get(env.COORDINATOR.idFromName('global'));
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // non-browser clients (Claude Code, curl) send no Origin
  const allowed = new Set(String(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  if (env.PUBLIC_BASE_URL) allowed.add(new URL(env.PUBLIC_BASE_URL).origin);
  return allowed.has(origin);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function mcpUrl(env, request) {
  return `${(env.PUBLIC_BASE_URL ?? new URL(request.url).origin).replace(/\/$/, '')}/mcp`;
}

export function tokenPage({ title, participant, token, mcp }) {
  const cmd = `claude mcp add --transport http gta6 ${mcp} --header "Authorization: Bearer ${token}"`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<style>:root{--bg:#f7f7f5;--fg:#1c1c1a;--muted:#5d5d58;--card:#fff;--line:#deded8;--accent:#0b6e4f}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#a3a29b;--card:#1e1e1c;--line:#34342f;--accent:#4fc59a}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}main{max-width:760px;margin:0 auto;padding:32px 16px}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px;white-space:pre-wrap;word-break:break-all}
.warn{border-left:4px solid var(--accent);padding:8px 12px;background:var(--card)}a{color:var(--accent)}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>
<p>Participante <code>${escapeHtml(participant.display_name)}</code> (${escapeHtml(participant.kind)}).</p>
<p class="warn">Este token aparece <strong>só agora</strong>. Guarde-o como senha. Ele autentica você no MCP do coordenador; sozinho não escreve em nenhum repositório GitHub; o credential helper usa-o para obter o token do seu repositório de trabalho.</p>
<h2>Conectar o Claude Code</h2><pre>${escapeHtml(cmd)}</pre>
<p>Depois, no Claude Code: <em>"use o MCP gta6: whoami, set_profile e claim_next_task"</em>. Veja o <a href="/onboarding.html">onboarding</a>.</p>
</main></body></html>`;
}

async function forward(env, request, path, init) {
  const url = new URL(request.url);
  url.pathname = path;
  return coordinator(env).fetch(new Request(url.toString(), init ?? request));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname.startsWith('/internal/')) return json({ error: { code: 'not_found', message: 'not found' } }, 404);

      if (pathname === '/api/config') {
        return json({
          google_login: googleConfigured(env),
          mcp_url: mcpUrl(env, request),
          reservation_ttl_hours: Number(env.RESERVATION_TTL_HOURS ?? 24),
          github_write: 'pending_decision',
        });
      }

      if (pathname === '/auth/anonymous' && request.method === 'POST') {
        if (!allowedOrigin(request, env)) throw new AppError('forbidden_origin', 'origin not allowed', 403);
        const body = await request.json().catch(() => ({}));
        const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
        const ipHash = (await sha256Hex(`${env.TOKEN_PEPPER ?? ''}:ip:${ip}`)).slice(0, 32);
        const res = await forward(env, request, '/internal/anonymous', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ display_name: body.display_name, ip_hash: ipHash }),
        });
        if (!res.ok) return res;
        const out = await res.json();
        return json({ ...out, mcp_url: mcpUrl(env, request) });
      }

      if (pathname === '/auth/google/start' && request.method === 'GET') {
        return Response.redirect(await startLogin(env), 302);
      }

      if (pathname === '/auth/google/callback' && request.method === 'GET') {
        if (url.searchParams.get('error')) throw new AppError('oauth_denied', 'Google login was cancelled or denied', 400);
        const claims = await finishLogin(env, { code: url.searchParams.get('code'), state: url.searchParams.get('state') });
        const res = await forward(env, request, '/internal/google-login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ claims }),
        });
        if (!res.ok) return res;
        const out = await res.json();
        return new Response(tokenPage({ title: 'Login Google concluído', participant: out.participant, token: out.token, mcp: mcpUrl(env, request) }), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            'referrer-policy': 'no-referrer',
          },
        });
      }

      if (pathname === '/mcp') {
        if (!allowedOrigin(request, env)) throw new AppError('forbidden_origin', 'origin not allowed', 403);
        return forward(env, request, '/mcp');
      }

      if (pathname.startsWith('/api/') || pathname === '/health') return forward(env, request, pathname);

      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: { code: 'not_found', message: 'not found' } }, 404);
    } catch (err) {
      return errorResponse(err);
    }
  },

  async scheduled(_event, env, ctx) {
    const stub = coordinator(env);
    ctx.waitUntil(
      (async () => {
        await stub.fetch(new Request('https://coordinator.internal/internal/sync', { method: 'POST' }));
        await stub.fetch(new Request('https://coordinator.internal/internal/reconcile', { method: 'POST' }));
      })(),
    );
  },
};
