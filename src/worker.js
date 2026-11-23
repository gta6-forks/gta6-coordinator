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

const PAGE_STYLE = `:root{--bg:#f7f7f5;--fg:#1c1c1a;--muted:#5d5d58;--card:#fff;--line:#deded8;--accent:#0b6e4f}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#a3a29b;--card:#1e1e1c;--line:#34342f;--accent:#4fc59a}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}main{max-width:760px;margin:0 auto;padding:32px 16px}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px;white-space:pre-wrap;word-break:break-all}
.warn{border-left:4px solid var(--accent);padding:8px 12px;background:var(--card)}a{color:var(--accent)}`;

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
};

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
}

export function tokenPage({ title, participant, token, mcp }) {
  const cmd = `claude mcp add --transport http gta6 ${mcp} --header "Authorization: Bearer ${token}"`;
  return page(title, `<p>Participant <code>${escapeHtml(participant.display_name)}</code> (${escapeHtml(participant.kind)}).</p>
<p class="warn">This token is shown <strong>only now</strong>. Keep it like a password. It signs you in to the coordinator MCP; on its own it cannot write to any GitHub repository (the credential helper uses it to get a token for your work repository).</p>
<h2>Connect Claude Code</h2><pre>${escapeHtml(cmd)}</pre>
<p>Then ask Claude Code: <em>"use the gta6 MCP: whoami, set_profile and claim_next_task"</em>. See the <a href="/onboarding.html">onboarding guide</a>.</p>`);
}

export function errorPage(message) {
  return page('Sign-in did not complete', `<p>${escapeHtml(message)}</p><p>Try again from your terminal: ask your agent for a new <code>google_link_url</code> (<code>whoami</code>).</p>`);
}

export function signedInUrl(env) {
  return env.SIGNED_IN_URL || `${String(env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/`;
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
          // public: the main forks tasks live in (the planning Action checks proposals against them)
          task_repos: String(env.TASK_REPOS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
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
        return Response.redirect(await startLogin(env, { link: url.searchParams.get('link') }), 302);
      }

      if (pathname === '/auth/google/callback' && request.method === 'GET') {
        try {
          if (url.searchParams.get('error')) throw new AppError('oauth_denied', 'Google sign-in was cancelled or denied.', 400);
          const { claims, link } = await finishLogin(env, { code: url.searchParams.get('code'), state: url.searchParams.get('state') });
          if (link) {
            // Upgrade the SAME anonymous participant (same bearer token); nothing secret is shown in the browser.
            const res = await forward(env, request, '/internal/google-link', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ code: link, claims }),
            });
            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              return new Response(errorPage(err.error?.message ?? 'Sign-in failed.'), { status: res.status, headers: PAGE_HEADERS });
            }
            return new Response(null, { status: 302, headers: { location: signedInUrl(env), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
          }
          const res = await forward(env, request, '/internal/google-login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ claims }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return new Response(errorPage(err.error?.message ?? 'Sign-in failed.'), { status: res.status, headers: PAGE_HEADERS });
          }
          const out = await res.json();
          return new Response(tokenPage({ title: 'Signed in with Google', participant: out.participant, token: out.token, mcp: mcpUrl(env, request) }), { headers: PAGE_HEADERS });
        } catch (err) {
          const message = err instanceof AppError && err.status < 500 ? 'The sign-in request expired or is invalid.' : 'Sign-in failed on our side.';
          if (!(err instanceof AppError)) console.error('google_callback_failed', String(err?.message ?? err).slice(0, 300));
          return new Response(errorPage(err?.code === 'oauth_denied' ? err.message : message), { status: err instanceof AppError ? err.status : 500, headers: PAGE_HEADERS });
        }
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
        // Upstream reconciliation (read-only, conditional requests; honours UPSTREAM_CHECK_MINUTES).
        await stub.fetch(new Request('https://coordinator.internal/internal/upstream-check', { method: 'POST' }));
      })(),
    );
  },
};
