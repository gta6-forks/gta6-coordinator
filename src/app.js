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
import { GitHubReadOnlySource } from './github/read-source.js';
import { createPlanner } from './github/planner.js';
import { applyOverrides, applyPlanningPr, getOverrides, managedRepos } from './services/planning-apply.js';
import { recordEvent } from './store/store.js';
import { SEED } from './generated/seed.js';
import { createProvisioner, DisabledProvisioner } from './github/provisioner.js';
import { authenticate } from './services/auth.js';
import { integrationResult, issueGitCredential, reconcileWorkspaces } from './services/workspace.js';
import { handleGithubWebhook } from './github/webhooks.js';
import { metricsBundle } from './services/metrics.js';
import { refreshCi } from './services/ci-sync.js';
import { scheduledUpstreamCheck, upstreamConfig } from './services/upstream.js';
import { getMeta } from './store/store.js';

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


export function createApp({ store, env, now = () => Date.now(), gitWrite = new PendingGitWriteAdapter(), provisioner = null, planner = undefined }) {
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
  const ctx = { store, env, now, gitWrite, provisioner: prov, planner: planner === undefined ? createPlanner(env) : planner };
  migrate(store);

  // Catalog = seed (TASK_SOURCE seed | seed+github) + gta6-task issues of the main forks (github | seed+github),
  // with the overrides written by applied planning proposals.
  async function loadSourceTasks() {
    const mode = env.TASK_SOURCE ?? 'seed';
    const out = mode === 'github' ? [] : structuredClone(SEED.tasks);
    if (mode === 'github' || mode === 'seed+github') {
      const repos = managedRepos(env);
      try {
        const readToken = env.GITHUB_READ_TOKEN || (ctx.planner ? await ctx.planner.readToken(repos) : null);
        out.push(...(await new GitHubReadOnlySource({ repos, readToken, roadmap: SEED.roadmap }).listTasks()));
      } catch (err) {
        recordEvent(store, now(), 'system', 'catalog.github_read_failed', { message: String(err.message ?? err).slice(0, 300) });
        console.error('catalog_github_read_failed', String(err.message ?? err).slice(0, 300));
      }
    }
    return out;
  }

  async function sync() {
    return syncCatalog(ctx, applyOverrides(await loadSourceTasks(), getOverrides(store)), SEED.roadmap);
  }

  /** Applies the proposal(s) of a merged planning PR, then refreshes the catalog. */
  async function applyPlanning(pr) {
    if (!ctx.planner) throw new AppError('planner_not_configured', 'GitHub App planner is not configured', 503);
    const out = await applyPlanningPr(ctx, ctx.planner, pr);
    out.sync = await sync();
    return out;
  }
  ctx.applyPlanning = applyPlanning;

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
        await refreshCi(ctx);
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
      if (pathname === '/internal/upstream-check' && request.method === 'POST') {
        return json(await scheduledUpstreamCheck(ctx, { force: url.searchParams.get('force') === '1' }));
      }
      if (pathname === '/internal/reconcile' && request.method === 'POST') {
        return json({ results: await reconcileWorkspaces(ctx), ci: await refreshCi(ctx, { force: true }) });
      }
      if (pathname === '/api/git/credential' && request.method === 'POST') {
        const participant = await authenticate(ctx, request.headers.get('authorization'));
        const body = await readJson(request);
        const repo = String(body.repo ?? body.path ?? '').replace(/\.git$/, '').replace(/^\//, '');
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || (body.host && body.host !== 'github.com')) {
          throw new AppError('bad_credential_request', 'expected host=github.com and path=owner/repo(.git)', 400);
        }
        return json(await issueGitCredential(ctx, participant, { repo }));
      }
      if (pathname === '/api/planning/apply' && request.method === 'POST') {
        // Manual retry for the owner/integrator (same shared secret as the integration callback).
        if (!env.INTEGRATION_CALLBACK_SECRET || !timingSafeEqual(request.headers.get('x-coordinator-secret') ?? '', env.INTEGRATION_CALLBACK_SECRET)) {
          throw new AppError('unauthorized', 'bad secret', 401);
        }
        const body = await readJson(request);
        const n = Number(body.pr_number);
        if (!Number.isInteger(n) || n < 1) throw new AppError('bad_request', 'pr_number required', 400);
        return json(await applyPlanning({ number: n, url: `https://github.com/${env.COORDINATOR_REPO}/pull/${n}` }));
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
      if (pathname === '/health') {
        const last = getMeta(store, 'upstream_last_run', null);
        const upstream = { mode: upstreamConfig(env).mode, last_run_at: last?.at ?? null, last_run_partial: last?.partial ?? null };
        return json({ ok: true, service: 'gta6-coordinator', git_write: gitWrite.describe(), workspaces: ctx.provisioner.describe(), upstream });
      }
      return json({ error: { code: 'not_found', message: 'not found' } }, 404);
    } catch (err) {
      return errorResponse(err);
    }
  }

  return { handle, sync, ensureSeeded, ctx };
}
