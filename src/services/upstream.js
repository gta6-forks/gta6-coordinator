// Upstream reconciliation: the ORIGINAL repositories (Leonida, Xbox2Windows, ...) evolve in parallel, so a task in
// stock can become resolved upstream, obsolete, partially met, or need re-planning. This module
//   1. periodically fetches each upstream (default branch HEAD sha + timestamp) with conditional requests,
//   2. re-checks each task's own upstream sources (the issue/PR it came from, the files it cites) and records
//      SIGNALS + EVIDENCE (commits, PRs, files) with a timestamp,
//   3. derives an automatic status, which a planner (Google login) confirms or overrides with a verdict that must
//      address every acceptance criterion with evidence (never just titles or keywords),
//   4. tells the scheduler/planner whether a task may be distributed (mode-gated, see UPSTREAM_RECONCILIATION).
// It never closes, cancels or edits a task, never touches reservations, and never deletes history: closing a
// task stays a reviewed planning proposal (close_issue). Verdicts are append-only.
import { AppError, parseTaskId, randomId } from '../util.js';
import { getMeta, recordEvent, setMeta } from '../store/store.js';
import { getTask, loadTasks } from './catalog.js';
import { UpstreamBudgetExhausted, UpstreamReader } from '../github/upstream-reader.js';

export const MODES = ['off', 'report', 'enforce_evidence', 'enforce'];
export const VERDICT_STATUSES = ['valid', 'resolved_upstream', 'obsolete', 'partially_met', 'needs_replan'];
/** Statuses that, once enforcement is on, keep a task out of distribution. */
export const BLOCKING = new Set(['resolved_upstream', 'obsolete', 'partially_met', 'needs_replan']);
const SEVERITY = ['valid', 'needs_review', 'needs_replan', 'partially_met', 'obsolete', 'resolved_upstream'];

const managedRepos = (env) => String(env.TASK_REPOS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
/** Branch to track per upstream ("owner/name=branch,..."); default: the repository's default branch. */
export function trackedBranch(env, repo) {
  for (const pair of String(env.UPSTREAM_BRANCHES ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [r, b] = pair.split('=').map((s) => s.trim());
    if (r && b && same(r, repo)) return b;
  }
  return null;
}
const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export function upstreamConfig(env = {}) {
  const mode = MODES.includes(env.UPSTREAM_RECONCILIATION) ? env.UPSTREAM_RECONCILIATION : 'report';
  return {
    mode,
    freshMs: num(env.UPSTREAM_FRESH_MINUTES, 15) * 60_000, // re-check before claim/plan when older than this
    staleMs: num(env.UPSTREAM_MAX_STALENESS_MINUTES, 360) * 60_000, // `enforce`: refuse to distribute past this
    intervalMs: num(env.UPSTREAM_CHECK_MINUTES, 30) * 60_000, // periodic (cron) cadence
    verdictMaxMs: num(env.UPSTREAM_VERDICT_MAX_DAYS, 14) * 86_400_000, // planner verdicts expire: revalidate stock
    maxRequests: num(env.UPSTREAM_MAX_REQUESTS_PER_RUN, 80),
    minRemaining: num(env.UPSTREAM_MIN_RATE_REMAINING, 200),
    precheckTimeoutMs: num(env.UPSTREAM_PRECHECK_TIMEOUT_MS, 8000),
    maxStockPerRepo: num(env.UPSTREAM_MAX_STOCK_PER_REPO, 10),
    baselineSince: env.UPSTREAM_BASELINE_SINCE || null,
  };
}

// ---------- mapping tasks -> upstream repository and sources ----------

/** fork -> upstream: explicit UPSTREAM_REPOS ("fork=upstream,..."), then learned from catalog tasks (repo + fork_repo). */
export function upstreamMap(env, tasks) {
  const map = new Map();
  for (const t of tasks) {
    const d = t.data ?? t;
    if (d.fork_repo && d.repo && d.repo !== d.fork_repo) map.set(d.fork_repo.toLowerCase(), d.repo);
  }
  for (const pair of String(env.UPSTREAM_REPOS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [fork, up] = pair.split('=').map((s) => s.trim());
    if (fork && up) map.set(fork.toLowerCase(), up);
  }
  return map;
}

export function upstreamOf(d, map, forks) {
  if (!d?.repo) return null;
  const hit = map.get(d.repo.toLowerCase());
  if (hit) return hit;
  if (forks.some((f) => f.toLowerCase() === d.repo.toLowerCase())) return null; // fork whose original is unknown
  return d.repo;
}

const GH_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9][0-9]*)/;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** The task's own upstream sources: the issue/PR it was derived from and the files it cites. */
const CONTEXT_RELATIONS = new Set(['context', 'see_also', 'related', 'background']);

export function sourceRefs(d, upstream, knownRepos = []) {
  const issues = new Map();
  const files = new Map();
  const skipped = [];
  if (!upstream) return { issues: [], files: [], skipped };
  const otherNames = new Set(knownRepos.filter((r) => !same(r, upstream)).map((r) => String(r).split('/')[1]?.toLowerCase()));
  const id = parseTaskId(d.id);
  if (id?.kind === 'github' && same(id.repo, upstream)) issues.set(id.number, { number: id.number, retrieved_at: null, context: false });
  for (const s of d.sources ?? []) {
    if (s.kind === 'issue' || s.kind === 'pull_request') {
      const m = GH_URL.exec(s.ref ?? '');
      // An issue/PR is the task's ORIGIN unless the source says it is only context (relation: context/see_also/...).
      // Closing or merging a context source asks for a review; it never resolves the task by itself.
      const context = CONTEXT_RELATIONS.has(String(s.relation ?? s.role ?? '').toLowerCase());
      if (m && same(m[1], upstream)) {
        const n = Number(m[3]);
        const prev = issues.get(n);
        issues.set(n, { number: n, retrieved_at: s.retrieved_at ?? prev?.retrieved_at ?? null, context: prev ? prev.context && context : context });
      }
    } else if (s.kind === 'file' && s.ref) {
      const parts = s.ref.split('/');
      const name = upstream.split('/')[1];
      if (parts.length > 1 && !same(parts[0], name) && otherNames.has(parts[0].toLowerCase())) {
        skipped.push(`source_file_other_repo:${s.ref}`); // cited from ANOTHER upstream: not checked against this one
        continue;
      }
      const path = same(parts[0], name) && parts.length > 1 ? parts.slice(1).join('/') : s.ref;
      files.set(path, { path, retrieved_at: s.retrieved_at ?? null, heading: s.heading ?? null, lines: s.lines ?? null });
    }
  }
  return { issues: [...issues.values()], files: [...files.values()], skipped };
}

const iso = (ms) => new Date(ms).toISOString();
const toMs = (v) => {
  if (!v) return null;
  const t = Date.parse(String(v).length === 10 ? `${v}T00:00:00Z` : v);
  return Number.isNaN(t) ? null : t;
};

// ---------- checking one task ----------

/**
 * Re-checks one task against the current upstream HEAD. Pure w.r.t. the store except for the HTTP cache.
 * @returns { auto_status, reasons, evidence, baseline, fingerprint, complete }
 */
export async function checkTask(reader, d, upstream, head, prev, cfg, now) {
  const refs = sourceRefs(d, upstream, cfg.knownRepos ?? []);
  const sinceOf = (ref) => toMs(ref.retrieved_at) ?? toMs(cfg.baselineSince);
  const baseline = structuredClone(prev?.baseline ?? { issues: {}, files: {} });
  const reasons = [];
  const evidence = [];
  const candidates = [];
  let complete = true;
  reasons.push(...refs.skipped);

  for (const ref of refs.issues) {
    const r = await reader.issue(upstream, ref.number);
    const url = `https://github.com/${upstream}/issues/${ref.number}`;
    if (!r.ok) {
      if (r.status === 404) {
        reasons.push(`source_issue_missing:#${ref.number}`);
        candidates.push('needs_replan');
      } else complete = false;
      continue;
    }
    const i = r.data;
    const base = baseline.issues[ref.number];
    if (i.is_pull_request) {
      if (i.merged_at) {
        const p = await reader.pull(upstream, ref.number);
        evidence.push({ kind: 'pr', ref: i.html_url, merged_at: i.merged_at, merge_commit_sha: p.ok ? p.data.merge_commit_sha : null, observed_at: iso(now) });
        reasons.push(`${ref.context ? 'context' : 'source'}_pr_merged:#${ref.number}`);
        candidates.push(ref.context ? 'needs_review' : 'resolved_upstream');
      } else if (i.state === 'closed') {
        evidence.push({ kind: 'pr', ref: i.html_url, closed_at: i.closed_at, merged: false, observed_at: iso(now) });
        reasons.push(`${ref.context ? 'context' : 'source'}_pr_closed_unmerged:#${ref.number}`);
        candidates.push(ref.context ? 'needs_review' : 'obsolete');
      }
    } else if (i.state === 'closed') {
      const tl = await reader.timeline(upstream, ref.number);
      const closing = tl.ok ? tl.data.filter((e) => e.event === 'closed').at(-1) : null;
      const prs = tl.ok ? tl.data.filter((e) => e.pr).map((e) => e.pr) : [];
      evidence.push({
        kind: 'issue',
        ref: i.html_url ?? url,
        state_reason: i.state_reason,
        closed_at: i.closed_at,
        closing_commit: closing?.commit_id ?? null,
        linked_prs: prs.slice(-5),
        observed_at: iso(now),
      });
      if (closing?.commit_id) evidence.push({ kind: 'commit', ref: closing.commit_id, note: `closed #${ref.number}` });
      for (const pr of prs.filter((p) => p.merged_at)) evidence.push({ kind: 'pr', ref: pr.url, merged_at: pr.merged_at });
      if (ref.context) {
        reasons.push(`context_issue_closed:#${ref.number}`);
        candidates.push('needs_review');
      } else if (i.state_reason === 'not_planned' || i.state_reason === 'duplicate') {
        reasons.push(`source_issue_closed_${i.state_reason}:#${ref.number}`);
        candidates.push('obsolete');
      } else {
        reasons.push(`source_issue_closed_completed:#${ref.number}`);
        candidates.push('resolved_upstream');
      }
    } else {
      // A PR merged upstream that references the still-open origin issue means part of the work may already be done.
      const tl = await reader.timeline(upstream, ref.number);
      if (!tl.ok) {
        complete = false;
        reasons.push(`timeline_unavailable:#${ref.number}:${tl.error ?? tl.status}`);
      } else {
        const from = sinceOf(ref);
        const merged = tl.data.filter((e) => e.pr?.merged_at && (from === null || toMs(e.pr.merged_at) > from)).map((e) => e.pr);
        const uniq = [...new Map(merged.map((p) => [p.url, p])).values()];
        if (uniq.length) {
          reasons.push(`${ref.context ? 'context' : 'source'}_issue_linked_pr_merged:#${ref.number}`);
          for (const p of uniq.slice(-5)) evidence.push({ kind: 'pr', ref: p.url, merged_at: p.merged_at, references: `#${ref.number}`, observed_at: iso(now) });
          candidates.push(ref.context ? 'needs_review' : 'partially_met');
        }
      }
      // Relative to when the task was written, not to the first observation: a signal stays until a planner verdict.
      const since = ref.retrieved_at ?? cfg.baselineSince ?? base?.updated_at;
      const sinceMs = toMs(since);
      const grace = String(since ?? '').length === 10 ? 86_400_000 : 0; // date-only retrieved_at
      if (sinceMs !== null && toMs(i.updated_at) > sinceMs + grace) {
        reasons.push(`source_issue_updated:#${ref.number}`);
        evidence.push({ kind: 'issue', ref: i.html_url ?? url, updated_at: i.updated_at, since, observed_at: iso(now) });
        candidates.push('needs_review');
      }
    }
    if (!base) baseline.issues[ref.number] = { updated_at: i.updated_at, state: i.state, first_seen_at: iso(now) };
  }

  for (const ref of refs.files) {
    const r = await reader.file(upstream, ref.path, head.sha);
    if (!r.ok) {
      if (r.status === 404) {
        // "removed" only when this check saw the file before; never seen => the citation may point elsewhere (fork-only file)
        const seen = !!baseline.files[ref.path];
        reasons.push(`source_file_${seen ? 'removed' : 'not_found'}:${ref.path}`);
        evidence.push({ kind: 'file', ref: `${upstream}/${ref.path}@${head.sha}`, removed: seen, observed_at: iso(now) });
        candidates.push(seen ? 'needs_replan' : 'needs_review');
      } else complete = false;
      continue;
    }
    const base = baseline.files[ref.path];
    // Commits since the task was written (ETag-cached); sticky until a planner verdict, like the issue signals.
    const sinceMs = toMs(ref.retrieved_at) ?? toMs(cfg.baselineSince) ?? base?.at ?? null;
    const changed = sinceMs !== null;
    const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const hasHeading = ref.heading && Array.isArray(r.data.headings) ? r.data.headings.some((h) => norm(h) === norm(ref.heading)) : null;
    if (hasHeading === false) {
      // "removed" only if an earlier check saw the section (setext/HTML headings are not parsed => never a false removal)
      const seen = base?.headings?.[ref.heading] === true;
      reasons.push(`source_section_${seen ? 'removed' : 'not_found'}:${ref.path}#${ref.heading}`);
      evidence.push({ kind: 'file', ref: `${upstream}/${ref.path}@${head.sha}`, missing_heading: ref.heading, observed_at: iso(now) });
      candidates.push(seen ? 'needs_replan' : 'needs_review');
    }
    if (changed && sinceMs !== null) {
      const c = await reader.commitsForPath(upstream, ref.path, iso(sinceMs), head.sha);
      if (!c.ok) complete = false;
      else if (c.data.length) {
        reasons.push(`source_file_changed:${ref.path}`);
        evidence.push({ kind: 'file', ref: `${upstream}/${ref.path}@${head.sha}`, blob_sha: r.data.sha, cited: ref.heading ?? ref.lines ?? null, since: iso(sinceMs), observed_at: iso(now) });
        for (const cm of c.data) evidence.push({ kind: 'commit', ref: cm.sha, committed_at: cm.committed_at, message: cm.message, path: ref.path });
        candidates.push('needs_review');
      }
    }
    if (!base) baseline.files[ref.path] = { sha: r.data.sha, at: now };
    if (hasHeading !== null) {
      const b = baseline.files[ref.path];
      b.headings = { ...(b.headings ?? {}), [ref.heading]: hasHeading || b.headings?.[ref.heading] === true };
    }
  }

  let auto = candidates.reduce((a, b) => (SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a), 'valid');
  if (!complete && auto === 'valid') {
    auto = prev?.auto_status ?? 'unchecked';
    reasons.push('check_incomplete');
  }
  if (!refs.issues.length && !refs.files.length) reasons.push('no_upstream_sources');
  const fingerprint = [...reasons.filter((r) => r !== 'check_incomplete')].sort().join('|') + '#' + evidence.map((e) => e.ref).sort().join('|');
  return { auto_status: auto, reasons, evidence, baseline, fingerprint, complete };
}

// ---------- the reconciliation run ----------

async function readToken(ctx) {
  if (ctx.env.GITHUB_READ_TOKEN) return ctx.env.GITHUB_READ_TOKEN;
  if (!ctx.planner) return null;
  try {
    return await ctx.planner.readToken(managedRepos(ctx.env));
  } catch {
    return null; // unauthenticated fallback (60/h): conditional requests keep it workable for 5 repos
  }
}

function rowOf(store, taskId) {
  const r = store.one('SELECT * FROM upstream_task_checks WHERE task_id = ?', taskId);
  if (!r) return null;
  return { ...r, reasons: JSON.parse(r.auto_reasons_json), evidence: JSON.parse(r.evidence_json), baseline: JSON.parse(r.baseline_json) };
}

/** Tasks the reconciler looks at: catalog tasks still in stock or in flight, plus any task with an active reservation. */
function trackedTasks(store) {
  const active = new Set(store.all("SELECT task_id FROM reservations WHERE state = 'active'").map((r) => r.task_id));
  return loadTasks(store).filter((t) => t.data.repo && (!['done', 'cancelled'].includes(t.status) || active.has(t.id)));
}

const inflight = new WeakMap();

/**
 * One reconciliation run. Safe to call concurrently (deduplicated per store) and repeatedly (idempotent).
 * @param repos   restrict to these upstream repositories (pre-claim / pre-plan freshness)
 * @param force   ignore per-repo failure backoff (never ignores GitHub's own rate limit)
 */
export function checkUpstream(ctx, opts = {}) {
  const key = ctx.store;
  const running = inflight.get(key);
  if (running && !opts.repos) return running;
  const p = runCheck(ctx, opts).finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

async function runCheck(ctx, { repos = null, force = false, reason = 'manual', readerFactory = null } = {}) {
  const cfg = upstreamConfig(ctx.env);
  const now = ctx.now();
  if (cfg.mode === 'off') return { skipped: 'mode_off' };
  const backoff = getMeta(ctx.store, 'upstream_backoff_until', 0);
  if (backoff > now) return { skipped: 'github_rate_limit_backoff', resume_at: iso(backoff) };

  const tasks = trackedTasks(ctx.store);
  const forks = managedRepos(ctx.env);
  const map = upstreamMap(ctx.env, loadTasks(ctx.store));
  const byRepo = new Map();
  for (const t of tasks) {
    const up = upstreamOf(t.data, map, forks);
    if (!up) continue;
    if (!byRepo.has(up)) byRepo.set(up, []);
    byRepo.get(up).push(t);
  }
  const targets = repos ?? [...byRepo.keys()];
  cfg.knownRepos = [...new Set([...map.values(), ...byRepo.keys()])];
  const factory = readerFactory ?? ctx.upstreamReaderFactory ?? ((o) => new UpstreamReader(o));
  const reader = factory({ store: ctx.store, token: await readToken(ctx), now: ctx.now, maxRequests: cfg.maxRequests, minRemaining: cfg.minRemaining });
  const summary = { reason, mode: cfg.mode, at: iso(now), repos: {}, changed: [], partial: false };
  const activeByTask = new Map(ctx.store.all("SELECT task_id, participant_id FROM reservations WHERE state = 'active'").map((r) => [r.task_id, r.participant_id]));

  try {
    for (const repo of targets) {
      const prevRepo = ctx.store.one('SELECT * FROM upstream_repos WHERE repo = ?', repo);
      if (!force && prevRepo?.next_check_after && prevRepo.next_check_after > now) {
        summary.repos[repo] = { skipped: 'failure_backoff', next_check_after: iso(prevRepo.next_check_after) };
        continue;
      }
      const meta = await reader.repo(repo);
      const branch = meta.ok ? trackedBranch(ctx.env, repo) ?? meta.data.default_branch : null;
      const head = meta.ok ? await reader.headCommit(repo, branch) : meta;
      if (!meta.ok || !head.ok) {
        const failures = (prevRepo?.consecutive_failures ?? 0) + 1;
        const next = now + Math.min(5 * 60_000 * 2 ** (failures - 1), 2 * 3600_000);
        ctx.store.exec(
          `INSERT INTO upstream_repos (repo, last_attempt_at, last_error, consecutive_failures, next_check_after) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(repo) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
             consecutive_failures = excluded.consecutive_failures, next_check_after = excluded.next_check_after`,
          repo, now, head.error ?? meta.error, failures, next,
        );
        recordEvent(ctx.store, now, 'system', 'upstream.repo_check_failed', { repo, error: head.error ?? meta.error, failures });
        summary.repos[repo] = { error: head.error ?? meta.error, consecutive_failures: failures };
        continue;
      }
      const moved = prevRepo?.head_sha && prevRepo.head_sha !== head.data.sha;
      ctx.store.exec(
        `INSERT INTO upstream_repos (repo, branch, default_branch, head_sha, head_committed_at, head_message, archived, last_attempt_at, last_success_at, last_error, consecutive_failures, next_check_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)
         ON CONFLICT(repo) DO UPDATE SET branch = excluded.branch, default_branch = excluded.default_branch, head_sha = excluded.head_sha,
           head_committed_at = excluded.head_committed_at, head_message = excluded.head_message, archived = excluded.archived,
           last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at, last_error = NULL,
           consecutive_failures = 0, next_check_after = NULL`,
        repo, branch, meta.data.default_branch, head.data.sha, head.data.committed_at, head.data.message, meta.data.archived ? 1 : 0, now, now,
      );
      if (moved) recordEvent(ctx.store, now, 'system', 'upstream.head_moved', { repo, from: prevRepo.head_sha, to: head.data.sha });
      summary.repos[repo] = { branch, head_sha: head.data.sha, committed_at: head.data.committed_at, moved: !!moved, tasks: 0 };

      const list = (byRepo.get(repo) ?? [])
        .map((t) => ({ t, prev: rowOf(ctx.store, t.id) }))
        .sort((a, b) => (a.prev?.checked_at ?? 0) - (b.prev?.checked_at ?? 0)); // oldest first: a partial run still rotates
      for (const { t, prev } of list) {
        const res = await checkTask(reader, t.data, repo, head.data, prev, cfg, now);
        const changed = !prev || prev.auto_status !== res.auto_status || prev.fingerprint !== res.fingerprint;
        ctx.store.exec(
          `INSERT INTO upstream_task_checks (task_id, upstream_repo, auto_status, auto_reasons_json, evidence_json, baseline_json, fingerprint, basis_sha, checked_at, changed_at, verdict_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(task_id) DO UPDATE SET upstream_repo = excluded.upstream_repo, auto_status = excluded.auto_status,
             auto_reasons_json = excluded.auto_reasons_json, evidence_json = excluded.evidence_json, baseline_json = excluded.baseline_json,
             fingerprint = excluded.fingerprint, basis_sha = excluded.basis_sha, checked_at = excluded.checked_at,
             changed_at = CASE WHEN upstream_task_checks.fingerprint = excluded.fingerprint AND upstream_task_checks.auto_status = excluded.auto_status
                               THEN upstream_task_checks.changed_at ELSE excluded.changed_at END`,
          t.id, repo, res.auto_status, JSON.stringify(res.reasons), JSON.stringify(res.evidence), JSON.stringify(res.baseline),
          res.fingerprint, head.data.sha, now, now,
        );
        summary.repos[repo].tasks++;
        if (changed) {
          const ev = { task_id: t.id, from: prev?.auto_status ?? null, to: res.auto_status, reasons: res.reasons, basis_sha: head.data.sha };
          recordEvent(ctx.store, now, 'system', 'upstream.task_status_changed', ev);
          summary.changed.push(ev);
          if (activeByTask.has(t.id) && BLOCKING.has(res.auto_status)) {
            // Never cancel someone else's work automatically: flag it, the holder sees it in whoami/get_task.
            recordEvent(ctx.store, now, 'system', 'upstream.reserved_task_flagged', { task_id: t.id, participant_id: activeByTask.get(t.id), status: res.auto_status });
          }
        }
      }
    }
  } catch (err) {
    if (!(err instanceof UpstreamBudgetExhausted)) throw err;
    summary.partial = true;
    summary.stopped = err.reason;
    if (err.resumeAt && err.reason !== 'run_request_budget') {
      setMeta(ctx.store, 'upstream_backoff_until', err.resumeAt);
      summary.resume_at = iso(err.resumeAt);
    }
    recordEvent(ctx.store, now, 'system', 'upstream.run_stopped', { reason: err.reason, resume_at: err.resumeAt ? iso(err.resumeAt) : null });
  }
  summary.http = reader.stats();
  setMeta(ctx.store, 'upstream_last_run', summary);
  if (!repos) setMeta(ctx.store, 'upstream_last_full_run_at', now);
  return summary;
}

/** Periodic entry point (cron): honours UPSTREAM_CHECK_MINUTES so a faster cron does not multiply GitHub reads. */
export async function scheduledUpstreamCheck(ctx, { force = false } = {}) {
  const cfg = upstreamConfig(ctx.env);
  const last = getMeta(ctx.store, 'upstream_last_full_run_at', 0);
  if (!force && ctx.now() - last < cfg.intervalMs - 60_000) return { skipped: 'interval', last_run_at: iso(last) };
  return checkUpstream(ctx, { reason: 'cron', force });
}

/**
 * Mandatory check before planning and before claiming: re-checks the given upstreams when their snapshot is older
 * than UPSTREAM_FRESH_MINUTES. Bounded by a timeout; failures are recorded, and the scheduler decides with what it has.
 */
export async function ensureFresh(ctx, repos = null) {
  const cfg = upstreamConfig(ctx.env);
  if (cfg.mode === 'off') return { skipped: 'mode_off' };
  let all = repos;
  if (!all) {
    const map = upstreamMap(ctx.env, loadTasks(ctx.store));
    const forks = managedRepos(ctx.env);
    all = [...new Set(trackedTasks(ctx.store).map((t) => upstreamOf(t.data, map, forks)).filter(Boolean))];
  }
  const now = ctx.now();
  const stale = all.filter((r) => {
    const row = ctx.store.one('SELECT last_success_at FROM upstream_repos WHERE repo = ?', r);
    return !row?.last_success_at || now - row.last_success_at > cfg.freshMs;
  });
  if (!stale.length) return { fresh: true };
  let timer;
  try {
    return await Promise.race([
      checkUpstream(ctx, { repos: stale, reason: 'precheck' }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true, repos: stale }), cfg.precheckTimeoutMs);
      }),
    ]);
  } catch (err) {
    recordEvent(ctx.store, ctx.now(), 'system', 'upstream.precheck_failed', { message: String(err?.message ?? err).slice(0, 300) });
    return { error: true };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- effective status, distribution gate, views ----------

function verdictOf(store, id) {
  if (!id) return null;
  const v = store.one('SELECT * FROM upstream_verdicts WHERE id = ?', id);
  return v ? { ...v, data: JSON.parse(v.data_json) } : null;
}

/** Index for the scheduler: one query each, not one per task. */
export function upstreamIndex(ctx) {
  const rows = new Map(ctx.store.all('SELECT * FROM upstream_task_checks').map((r) => [r.task_id, r]));
  const verdicts = new Map(
    ctx.store.all('SELECT v.* FROM upstream_verdicts v JOIN upstream_task_checks c ON c.verdict_id = v.id').map((v) => [v.task_id, v]),
  );
  const repos = new Map(ctx.store.all('SELECT * FROM upstream_repos').map((r) => [r.repo, r]));
  const tasks = loadTasks(ctx.store);
  return { cfg: upstreamConfig(ctx.env), rows, verdicts, repos, map: upstreamMap(ctx.env, tasks), forks: managedRepos(ctx.env), now: ctx.now() };
}

export function effectiveStatus(idx, task) {
  const d = task.data ?? task;
  const upstream = upstreamOf(d, idx.map, idx.forks);
  if (!upstream) return { status: 'not_applicable', upstream: null };
  const row = idx.rows.get(task.id ?? d.id);
  const repo = idx.repos.get(upstream) ?? null;
  const freshness = {
    repo: upstream,
    head_sha: repo?.head_sha ?? null,
    last_success_at: repo?.last_success_at ? iso(repo.last_success_at) : null,
    stale: !repo?.last_success_at || idx.now - repo.last_success_at > idx.cfg.staleMs,
    last_error: repo?.last_error ?? null,
  };
  if (!row) return { status: 'unchecked', source: 'automatic', upstream, freshness };
  const v = idx.verdicts.get(row.task_id);
  const base = {
    upstream,
    freshness,
    checked_at: iso(row.checked_at),
    basis_sha: row.basis_sha,
    reasons: JSON.parse(row.auto_reasons_json),
    automatic_status: row.auto_status,
  };
  if (v && v.fingerprint === row.fingerprint && idx.now - v.created_at < idx.cfg.verdictMaxMs) {
    return { ...base, status: v.status, source: 'planner', verdict: { id: v.id, at: iso(v.created_at), basis_sha: v.basis_sha } };
  }
  return {
    ...base,
    status: row.auto_status,
    source: 'automatic',
    provisional: row.auto_status !== 'valid',
    revalidation_required: !!v, // a planner verdict existed, but upstream changed since or it expired
  };
}

/** Reasons that keep a task out of distribution (empty in `off` and `report`). */
export function upstreamReasons(idx, task) {
  const { mode } = idx.cfg;
  if (mode === 'off' || mode === 'report') return [];
  const e = effectiveStatus(idx, task);
  if (e.status === 'not_applicable') return [];
  const out = [];
  if (BLOCKING.has(e.status)) out.push(`upstream:${e.status}`);
  if (mode === 'enforce') {
    if (e.status === 'needs_review' || e.status === 'unchecked') out.push(`upstream:${e.status}`);
    if (e.freshness?.stale) out.push(`upstream_stale:${e.upstream}`);
  }
  return out;
}

/** In enforcement modes a dependency resolved upstream counts as satisfied (e.g. a merged upstream PR). */
export function dependencyResolvedUpstream(idx, dep) {
  if (!dep || idx.cfg.mode === 'off' || idx.cfg.mode === 'report') return false;
  // Only a planner verdict unblocks dependents: an automatic signal (e.g. "the PR to validate was merged") is not proof
  // that the work the dependent needs was done.
  const e = effectiveStatus(idx, dep);
  return e.status === 'resolved_upstream' && e.source === 'planner';
}

/** Compact view attached to tasks shown to agents. */
export function taskUpstreamSummary(idx, task) {
  const e = effectiveStatus(idx, task);
  if (e.status === 'not_applicable') return null;
  const out = { status: e.status, source: e.source ?? 'automatic', upstream: e.upstream, checked_at: e.checked_at ?? null, basis_sha: e.basis_sha ?? null, mode: idx.cfg.mode };
  if (e.provisional) out.provisional = true;
  if (e.revalidation_required) out.revalidation_required = true;
  if (e.reasons?.length) out.reasons = e.reasons;
  if (e.freshness?.stale) out.stale = true;
  if (e.status !== 'valid' && e.status !== 'unchecked') {
    out.warning = `Upstream ${e.upstream} reports this task as ${e.status} (${(e.reasons ?? []).join(', ')}). Check the evidence (get_upstream_status) before investing time.`;
  }
  return out;
}

export function upstreamReport(ctx, { task_id = null } = {}) {
  const idx = upstreamIndex(ctx);
  const tasks = trackedTasks(ctx.store).filter((t) => !task_id || t.id === task_id);
  const items = tasks.map((t) => {
    const e = effectiveStatus(idx, t);
    const row = idx.rows.get(t.id);
    const v = row?.verdict_id ? verdictOf(ctx.store, row.verdict_id) : null;
    return {
      task_id: t.id,
      title: t.data.title,
      task_status: t.status,
      readiness: t.data.readiness,
      ...e,
      evidence: row ? JSON.parse(row.evidence_json) : [],
      acceptance: t.data.acceptance?.map((a, index) => ({ index, text: a.text })) ?? [],
      last_verdict: v ? { id: v.id, status: v.status, at: iso(v.created_at), by: v.participant_id, basis_sha: v.basis_sha, in_force: e.source === 'planner' } : null,
      would_block: BLOCKING.has(e.status),
    };
  });
  const repos = ctx.store.all('SELECT * FROM upstream_repos ORDER BY repo').map((r) => ({
    repo: r.repo,
    branch: r.branch,
    default_branch: r.default_branch,
    head_sha: r.head_sha,
    head_committed_at: r.head_committed_at,
    last_success_at: r.last_success_at ? iso(r.last_success_at) : null,
    last_attempt_at: r.last_attempt_at ? iso(r.last_attempt_at) : null,
    last_error: r.last_error,
    consecutive_failures: r.consecutive_failures,
  }));
  const counts = {};
  for (const i of items) counts[i.status] = (counts[i.status] ?? 0) + 1;
  return {
    mode: idx.cfg.mode,
    policy: {
      periodic_minutes: idx.cfg.intervalMs / 60_000,
      fresh_minutes: idx.cfg.freshMs / 60_000,
      max_staleness_minutes: idx.cfg.staleMs / 60_000,
      verdict_max_days: idx.cfg.verdictMaxMs / 86_400_000,
      max_stock_per_repo: idx.cfg.maxStockPerRepo,
    },
    last_run: getMeta(ctx.store, 'upstream_last_run', null),
    repos,
    counts,
    tasks: items,
  };
}

// ---------- planner verdicts ----------

const SHA = /^[0-9a-f]{7,40}$/;
const EVIDENCE_KINDS = new Set(['commit', 'pr', 'issue', 'file', 'other']);
const STRONG = new Set(['commit', 'pr', 'file']);

/**
 * A planner verdict for one task, checked against the CURRENT upstream HEAD and the task's acceptance criteria.
 * Rules (so nothing is concluded from titles or keywords):
 *   - basis_sha must equal the upstream HEAD the coordinator observed in the last UPSTREAM_FRESH_MINUTES
 *   - one entry per acceptance criterion; a criterion is "yes"/"partial" only with commit/PR/file evidence
 *   - resolved_upstream: every criterion "yes"; partially_met: some but not all; valid: none met
 *   - obsolete / needs_replan: a written rationale (and evidence for obsolete)
 * The verdict never changes the task's workflow status; closing still goes through a reviewed planning proposal.
 */
export async function recordVerdict(ctx, participant, args, { verifyCommit = null } = {}) {
  if (participant.kind !== 'google') throw new AppError('requires_google_login', 'upstream verdicts are a planning activity (Google login)', 403);
  const cfg = upstreamConfig(ctx.env);
  if (cfg.mode === 'off') throw new AppError('upstream_reconciliation_off', 'upstream reconciliation is disabled on this deployment', 409);
  const task = getTask(ctx.store, args.task_id);
  if (!task) throw new AppError('task_not_found', `unknown task ${args.task_id}`, 404);
  if (!VERDICT_STATUSES.includes(args.status)) throw new AppError('bad_verdict', `status must be one of ${VERDICT_STATUSES.join(', ')}`, 400);
  const idx = upstreamIndex(ctx);
  const upstream = upstreamOf(task.data, idx.map, idx.forks);
  if (!upstream) throw new AppError('no_upstream', 'this task has no upstream repository', 409);
  const row = idx.rows.get(task.id);
  const repo = idx.repos.get(upstream);
  if (!row || !repo?.last_success_at || ctx.now() - repo.last_success_at > cfg.freshMs) {
    throw new AppError('upstream_check_required', 'the upstream was not checked recently: call check_upstream first, then review the evidence', 409);
  }
  if (args.basis_sha !== repo.head_sha) {
    throw new AppError('upstream_moved', `upstream ${upstream} is now at ${repo.head_sha}; re-check the evidence against it`, 409, { head_sha: repo.head_sha });
  }
  const errors = [];
  const acceptance = task.data.acceptance ?? [];
  const criteria = Array.isArray(args.criteria) ? args.criteria : [];
  const seen = new Set();
  for (const [i, c] of criteria.entries()) {
    if (!Number.isInteger(c.index) || c.index < 0 || c.index >= acceptance.length || seen.has(c.index)) errors.push(`criteria[${i}].index invalid or repeated`);
    seen.add(c.index);
    if (!['yes', 'partial', 'no', 'unknown'].includes(c.met)) errors.push(`criteria[${i}].met must be yes|partial|no|unknown`);
    const ev = Array.isArray(c.evidence) ? c.evidence : [];
    for (const [j, e] of ev.entries()) {
      if (!EVIDENCE_KINDS.has(e.kind) || typeof e.ref !== 'string' || !e.ref || e.ref.length > 300) errors.push(`criteria[${i}].evidence[${j}] needs kind and ref`);
      if (e.kind === 'commit' && !SHA.test(e.ref)) errors.push(`criteria[${i}].evidence[${j}].ref must be a commit sha`);
      if (e.kind === 'pr' && !e.ref.toLowerCase().startsWith(`https://github.com/${upstream.toLowerCase()}/pull/`)) {
        errors.push(`criteria[${i}].evidence[${j}].ref must be a PR of ${upstream}`);
      }
    }
    if ((c.met === 'yes' || c.met === 'partial') && !ev.some((e) => STRONG.has(e.kind))) {
      errors.push(`criteria[${i}]: "${c.met}" needs commit, PR or file evidence (an issue title or keyword is not evidence)`);
    }
  }
  if (criteria.length !== acceptance.length || seen.size !== acceptance.length) errors.push(`address every acceptance criterion: expected ${acceptance.length}, got ${criteria.length}`);
  const yes = criteria.filter((c) => c.met === 'yes').length;
  const some = criteria.filter((c) => c.met === 'yes' || c.met === 'partial').length;
  const rationale = String(args.rationale_md ?? '');
  const allEvidence = criteria.flatMap((c) => c.evidence ?? []).concat(Array.isArray(args.evidence) ? args.evidence : []);
  switch (args.status) {
    case 'resolved_upstream':
      if (yes !== acceptance.length || !acceptance.length) errors.push('resolved_upstream needs every acceptance criterion met ("yes") upstream');
      break;
    case 'partially_met':
      if (!some || yes === acceptance.length) errors.push('partially_met needs at least one criterion met or partial, and not all met');
      break;
    case 'valid':
      if (some) errors.push('valid means no criterion is met upstream yet; use partially_met or resolved_upstream');
      break;
    case 'obsolete':
      if (rationale.length < 20) errors.push('obsolete needs rationale_md (why the task no longer makes sense upstream)');
      if (!allEvidence.length) errors.push('obsolete needs at least one piece of evidence');
      break;
    case 'needs_replan':
      if (rationale.length < 20) errors.push('needs_replan needs rationale_md (what must be redefined)');
      break;
  }
  if (errors.length) throw new AppError('verdict_invalid', 'verdict rejected', 422, { errors });
  if (verifyCommit) {
    for (const e of allEvidence.filter((x) => x.kind === 'commit').slice(0, 10)) {
      if (!(await verifyCommit(upstream, e.ref))) throw new AppError('verdict_invalid', `commit ${e.ref} not found in ${upstream}`, 422);
    }
  }
  const now = ctx.now();
  const id = randomId('uv_');
  const data = { criteria, rationale_md: rationale.slice(0, 4000), evidence: (args.evidence ?? []).slice(0, 50), automatic_status: row.auto_status, automatic_reasons: JSON.parse(row.auto_reasons_json) };
  ctx.store.tx(() => {
    ctx.store.exec(
      'INSERT INTO upstream_verdicts (id, task_id, status, basis_sha, fingerprint, participant_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, task.id, args.status, args.basis_sha, row.fingerprint, participant.id, JSON.stringify(data), now,
    );
    ctx.store.exec('UPDATE upstream_task_checks SET verdict_id = ? WHERE task_id = ?', id, task.id);
    recordEvent(ctx.store, now, participant.id, 'upstream.verdict_recorded', { verdict_id: id, task_id: task.id, status: args.status, basis_sha: args.basis_sha });
    const holder = ctx.store.one("SELECT participant_id FROM reservations WHERE task_id = ? AND state = 'active'", task.id);
    if (holder && holder.participant_id !== participant.id && BLOCKING.has(args.status)) {
      recordEvent(ctx.store, now, participant.id, 'upstream.reserved_task_flagged', { task_id: task.id, participant_id: holder.participant_id, status: args.status, verdict_id: id });
    }
  });
  return {
    verdict_id: id,
    task_id: task.id,
    status: args.status,
    basis_sha: args.basis_sha,
    effect:
      BLOCKING.has(args.status)
        ? cfg.mode === 'report'
          ? 'recorded; distribution is NOT blocked because the deployment runs in report mode'
          : 'recorded; the task is no longer distributed. Close or redefine it through a planning proposal (close_issue / create_issue).'
        : 'recorded; the task stays distributable',
    note: 'The task workflow status and any active reservation are unchanged; the verdict stays in force until upstream changes or it expires.',
  };
}
