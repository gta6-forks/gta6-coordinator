// Reads the GitHub check runs of commits under review and reports them to the review (same path as /api/ci).
// The participant never reports CI; the coordinator reads it from GitHub with the App (read-only).
import { getMeta, setMeta } from '../store/store.js';
import { reportCi } from './review.js';

const POLL_MS = 2 * 60 * 1000;
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);

/** success | failure | null (still running / no checks yet) */
export function ciConclusion(runs) {
  if (!runs.length) return null;
  if (runs.some((r) => r.status !== 'completed')) return null;
  return runs.some((r) => FAILED.has(r.conclusion)) ? 'failure' : 'success';
}

export async function refreshCi(ctx, { force = false } = {}) {
  if (!ctx.planner?.checkRuns) return [];
  const reviews = ctx.store.all(
    "SELECT * FROM reviews WHERE state IN ('verifying','awaiting_ci') AND ci_conclusion IS NULL AND pr_url IS NOT NULL ORDER BY updated_at LIMIT 10",
  );
  const out = [];
  for (const review of reviews) {
    const key = `ci_poll:${review.id}`;
    if (!force && ctx.now() - getMeta(ctx.store, key, 0) < POLL_MS) continue;
    setMeta(ctx.store, key, ctx.now());
    const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/.exec(review.pr_url);
    if (!m) continue;
    try {
      const conclusion = ciConclusion(await ctx.planner.checkRuns(m[1], review.commit_sha));
      if (conclusion) {
        await reportCi(ctx, { commit_sha: review.commit_sha, conclusion, details_url: `${review.pr_url}/checks` });
        out.push({ review_id: review.id, conclusion });
      }
    } catch (err) {
      console.error('ci_refresh_failed', review.id, String(err.message ?? err).slice(0, 200));
    }
  }
  return out;
}
