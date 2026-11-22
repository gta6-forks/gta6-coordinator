// GitHub App webhooks (X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(secret, raw body), hex).
// Handled: pull_request closed+merged on an integration repo -> review merged -> task done (unblocks dependents);
//          push on a work repo -> audit only. Everything else is acknowledged and ignored.
import { AppError } from '../util.js';
import { recordEvent } from '../store/store.js';
import { markMerged } from '../services/review.js';
import { getTask } from '../services/catalog.js';
import { recordCommits } from '../services/metrics.js';

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function verifySignature(secret, headers, raw) {
  const header = headers.get('x-hub-signature-256') ?? '';
  if (!header.startsWith('sha256=')) return false;
  return safeEqual(header.slice(7), await hmacHex(secret, raw));
}

export async function handleGithubWebhook(ctx, headers, raw) {
  if (!ctx.env.GITHUB_WEBHOOK_SECRET) throw new AppError('webhook_not_configured', 'GitHub webhook secret not configured', 503);
  if (!(await verifySignature(ctx.env.GITHUB_WEBHOOK_SECRET, headers, raw))) throw new AppError('unauthorized', 'bad webhook signature', 401);
  const event = headers.get('x-github-event') ?? '';
  const delivery = headers.get('x-github-delivery') ?? '';
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new AppError('invalid_json', 'webhook body is not JSON', 400);
  }
  // A public App can be installed by anyone: only our own installations count (D-GIT, webhook scope).
  const known = [ctx.env.GITHUB_APP_WORK_INSTALLATION_ID, ctx.env.GITHUB_APP_FORKS_INSTALLATION_ID].filter(Boolean).map(String);
  const inst = payload.installation?.id != null ? String(payload.installation.id) : null;
  if (!known.length || !inst || !known.includes(inst)) return { status: 'ignored', reason: 'unknown_installation' };
  if (delivery) {
    const seen = ctx.store.one("SELECT 1 AS x FROM events WHERE type = 'github.delivery' AND data_json = ?", JSON.stringify({ delivery }));
    if (seen) return { status: 'duplicate_delivery' };
    recordEvent(ctx.store, ctx.now(), 'github', 'github.delivery', { delivery });
  }
  if (event === 'pull_request' && payload.action === 'closed' && payload.pull_request?.merged) {
    const prUrl = payload.pull_request.html_url;
    const head = payload.pull_request.head?.sha;
    let merged;
    try {
      merged = markMerged(ctx, { pr_url: prUrl, commit_sha: head });
    } catch (err) {
      if (err instanceof AppError && err.code === 'review_not_ready') {
        recordEvent(ctx.store, ctx.now(), 'github', 'github.merge_without_ready_review', { pr_url: prUrl, head });
        return { status: 'ignored', reason: 'no ready_to_merge review for this PR head' };
      }
      throw err;
    }
    // An approved planning PR in the coordinator repository: apply it (issues in the forks + catalog).
    const task = getTask(ctx.store, merged.task_id);
    if (task?.data.role === 'plan' && payload.repository?.full_name === ctx.env.COORDINATOR_REPO && ctx.applyPlanning) {
      try {
        merged.planning = await ctx.applyPlanning({ number: payload.pull_request.number, url: prUrl });
      } catch (err) {
        recordEvent(ctx.store, ctx.now(), 'planner', 'planning.apply_failed', { pr: prUrl, message: String(err.message ?? err).slice(0, 300) });
        merged.planning = { status: 'apply_failed', retry: 'POST /api/planning/apply' };
      }
    }
    return merged;
  }
  if (event === 'push') {
    const repo = payload.repository?.full_name ?? '';
    const added = repo ? recordCommits(ctx, { repo, shas: (payload.commits ?? []).map((c) => c.id), source: 'github_push' }) : 0;
    recordEvent(ctx.store, ctx.now(), 'github', 'github.push', {
      repo: payload.repository?.full_name ?? null,
      ref: payload.ref ?? null,
      after: payload.after ?? null,
      forced: Boolean(payload.forced),
      commits_added: added,
    });
    return { status: 'recorded', commits_added: added };
  }
  return { status: 'ignored', event };
}
