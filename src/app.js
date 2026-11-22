// Core HTTP application that runs INSIDE the Coordinator Durable Object (single writer).
// The public Worker (src/worker.js) handles static assets and Google OAuth, then forwards here.
import { AppError, errorResponse, json } from './util.js';
import { migrate } from './store/migrations.js';
import { checkRateLimit, createAnonymous, linkGoogle, loginGoogle } from './services/auth.js';
import { syncCatalog } from './services/catalog.js';
import { publicCatalog, reservationPolicy } from './services/scheduler.js';
import { markMerged, reportCi } from './services/review.js';
import { handleRpc } from './mcp/server.js';
import { PendingGitWriteAdapter } from './github/write-adapter.js';
import { GitHubReadOnlySource, SeedSource } from './github/read-source.js';
import { SEED } from './generated/seed.js';
import { createProvisioner, DisabledProvisioner } from './github/provisioner.js';
import { authenticate } from './services/auth.js';
import { integrationResult, issueGitCredential, reconcileWorkspaces } from './services/workspace.js';
import { handleGithubWebhook } from './github/webhooks.js';
import { metricsBundle } from './services/metrics.js';

const MAX_BODY = 1024 * 1024;

async function readJson(request) {
  const len = Number(request.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) throw new AppError('payload_too_large', 'body over 1 MiB', 413);
  const text = await request.text();
  if (text.length > MAX_BODY) throw new AppError('payload_too_large', 'body over 1 MiB', 413);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new AppError('invalid_json', 'body is not JSON', 400);
  }
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function taskSource(env) {
  if (env.TASK_SOURCE === 'github') {
    const repos = String(env.TASK_REPOS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return new GitHubReadOnlySource({ repos, readToken: env.GITHUB_READ_TOKEN ?? null, roadmap: SEED.roadmap });
  }
  return new SeedSource(SEED);
}

export function createApp({ store, env, now = () => Date.now(), gitWrite = new PendingGitWriteAdapter(), provisioner = null }) {
  let prov = provisioner;
  if (!prov) {
    try {
      prov = createProvisioner(env, { store, now });
    } catch (err) {
      // Misconfiguration must not take the MCP down: fall back to disabled and say why in /health.
      prov = new DisabledProvisioner();
      prov.describe = () => ({ name: 'disabled', enabled: false, reason: `github-app provisioner misconfigured: ${err.message}` });
    }
  }
  const ctx = { store, env, now, gitWrite, provisioner: prov };
  migrate(store);

  async function sync() {
    const source = taskSource(env);
    return syncCatalog(ctx, await source.listTasks(), await source.getRoadmap());
  }

  async function ensureSeeded() {
    if (!store.one("SELECT 1 AS x FROM tasks WHERE origin = 'catalog' LIMIT 1")) await sync();
  }

  async function handle(request) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === '/mcp') {
        if (request.method !== 'POST') return json({ error: { code: 'method_not_allowed', message: 'POST JSON-RPC to /mcp' } }, 405, { allow: 'POST' });
        const body = await readJson(request);
        const auth = request.headers.get('authorization');
        if (Array.isArray(body)) {
          const out = (await Promise.all(body.map((m) => handleRpc(ctx, m, auth)))).filter(Boolean);
          return out.length ? json(out) : new Response(null, { status: 202 });
        }
        const out = await handleRpc(ctx, body, auth);
        await reconcileWorkspaces(ctx);
        return out ? json(out) : new Response(null, { status: 202 });
      }
      if (pathname === '/internal/anonymous' && request.method === 'POST') {
        const body = await readJson(request);
        const limit = Number(env.ANON_SIGNUPS_PER_HOUR ?? 10);
        if (!checkRateLimit(ctx, `anon:${body.ip_hash ?? 'unknown'}`, limit, 3600_000)) {
          throw new AppError('rate_limited', 'too many anonymous sign-ups from this network; try later', 429);
        }
        const { participant, token } = await createAnonymous(ctx, { display_name: body.display_name });
        return json({ participant: { id: participant.id, kind: participant.kind, display_name: participant.display_name }, token });
      }
      if (pathname === '/internal/google-login' && request.method === 'POST') {
        const body = await readJson(request);
        const { participant, token } = await loginGoogle(ctx, body.claims);
        return json({ participant: { id: participant.id, kind: participant.kind, display_name: participant.display_name }, token });
      }
      if (pathname === '/internal/google-link' && request.method === 'POST') {
        const body = await readJson(request);
        const participant = await linkGoogle(ctx, body.code, body.claims);
        return json({ participant: { id: participant.id, kind: participant.kind, display_name: participant.display_name } });
      }
      if (pathname === '/internal/sync' && request.method === 'POST') return json(await sync());
      if (pathname === '/internal/reconcile' && request.method === 'POST') return json({ results: await reconcileWorkspaces(ctx) });
      if (pathname === '/api/git/credential' && request.method === 'POST') {
        const participant = await authenticate(ctx, request.headers.get('authorization'));
        const body = await readJson(request);
        const repo = String(body.repo ?? body.path ?? '').replace(/\.git$/, '').replace(/^\//, '');
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || (body.host && body.host !== 'github.com')) {
          throw new AppError('bad_credential_request', 'expected host=github.com and path=owner/repo(.git)', 400);
        }
        return json(await issueGitCredential(ctx, participant, { repo }));
      }
      if (pathname === '/api/integration' && request.method === 'POST') {
        if (!env.INTEGRATION_CALLBACK_SECRET) throw new AppError('integration_not_configured', 'integration callback secret not configured', 503);
        if (!timingSafeEqual(request.headers.get('x-coordinator-secret') ?? '', env.INTEGRATION_CALLBACK_SECRET)) {
          throw new AppError('unauthorized', 'bad callback secret', 401);
        }
        const out = integrationResult(ctx, await readJson(request));
        await reconcileWorkspaces(ctx);
        return json(out);
      }
      if (pathname === '/api/github/webhook' && request.method === 'POST') {
        const raw = await request.text();
        return json(await handleGithubWebhook(ctx, request.headers, raw));
      }
      if (pathname === '/api/tasks' && request.method === 'GET') {
        await ensureSeeded();
        return json({ tasks: publicCatalog(ctx), reservation_policy: reservationPolicy(env) });
      }
      if (pathname === '/api/metrics' && request.method === 'GET') {
        await ensureSeeded();
        return json(metricsBundle(ctx, { period: url.searchParams.get('period') ?? '30d', days: Number(url.searchParams.get('days') ?? 30) }));
      }
      if (pathname === '/api/ci' && request.method === 'POST') {
        if (!env.CI_WEBHOOK_SECRET) throw new AppError('ci_webhook_not_configured', 'CI webhook secret not configured', 503);
        if (!timingSafeEqual(request.headers.get('x-coordinator-secret') ?? '', env.CI_WEBHOOK_SECRET)) {
          throw new AppError('unauthorized', 'bad webhook secret', 401);
        }
        const body = await readJson(request);
        if (body.event === 'pr_merged') return json(markMerged(ctx, body));
        return json(await reportCi(ctx, body));
      }
      if (pathname === '/health') return json({ ok: true, service: 'gta6-coordinator', git_write: gitWrite.describe(), workspaces: ctx.provisioner.describe() });
      return json({ error: { code: 'not_found', message: 'not found' } }, 404);
    } catch (err) {
      return errorResponse(err);
    }
  }

  return { handle, sync, ensureSeeded, ctx };
}
