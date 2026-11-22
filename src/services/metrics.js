// Auditable contribution metrics. Every number here is derived from rows the coordinator recorded itself
// (reservations, completions, reviews, verifications, GitHub webhooks) or from usage the agent reported.
// Nothing is synthesized: model/token usage the agent did not report is shown as unknown, and self-reported
// numbers are always labelled as self-reported (the coordinator cannot verify them).
import { AppError, randomId } from '../util.js';
import { validate } from '../schema/validate.js';
import { usageReportSchema } from '../schema/schemas.js';
import { recordEvent } from '../store/store.js';
import { getTask } from './catalog.js';

const DAY = 24 * 3600 * 1000;
const ACCEPTED = "('ready_to_merge','merged')";

export const DEFINITIONS = {
  reserved: 'reservations created in the period',
  delivered: 'completions submitted in the period (before the 24h deadline; late results are refused)',
  accepted: 'deliveries whose review reached ready_to_merge or merged (2 independent approvals of the same commit + CI)',
  rejected: 'deliveries whose review ended in changes_requested (a verifier rejected or CI failed)',
  expired: 'reservations that hit the hard 24h deadline without a delivery',
  merged_prs: 'reviews marked merged by the GitHub webhook',
  verifications: 'verification verdicts given by the participant',
  commits_pushed: 'distinct commits seen in GitHub push webhooks to the participant\'s work repositories (null = no webhook data)',
  delivered_within_24h_rate: 'delivered / (delivered + expired) for reservations that ended in the period',
  median_minutes_to_delivery: 'median of (completion time - assignment time)',
  ranking: 'accepted desc, then acceptance rate, then merged PRs, then faster median delivery; raw volume is not a score',
  tokens: 'self-reported by agents through agent_report_usage; reported_actual = taken from the runtime usage counters; estimated = the agent estimated; unknown = no usage report. Never inferred from commits.',
};

export function periodRange(period = '30d', now = Date.now()) {
  if (period === 'all') return { from: 0, to: now, period };
  const m = /^(\d{1,3})d$/.exec(period);
  if (!m) throw new AppError('invalid_period', 'period must be Nd (e.g. 7d, 30d) or all', 400);
  return { from: now - Number(m[1]) * DAY, to: now, period };
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const rate = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

// ---------------------------------------------------------------- usage reports

export function reportUsage(ctx, participant, report) {
  const errors = validate(usageReportSchema, report);
  if (errors.length) throw new AppError('invalid_usage_report', 'usage report does not match schema', 400, { errors });
  const r = { ...report };
  const hasTokens = ['input_tokens', 'output_tokens', 'total_tokens'].some((k) => r[k] !== undefined);
  if (r.measurement === 'unknown') {
    if (hasTokens) throw new AppError('invalid_usage_report', 'measurement=unknown must not carry token numbers', 400);
    if (r.method !== 'none' || r.confidence !== 'none') throw new AppError('invalid_usage_report', 'unknown usage uses method=none, confidence=none', 400);
  } else {
    if (!hasTokens) throw new AppError('invalid_usage_report', 'give input/output tokens or total_tokens, or use measurement=unknown', 400);
    if (r.measurement === 'reported_actual' && !['runtime_usage_api', 'client_usage_report'].includes(r.method)) {
      throw new AppError('invalid_usage_report', 'reported_actual requires method runtime_usage_api or client_usage_report', 400);
    }
    if (r.measurement === 'estimated' && !['tokenizer_count', 'heuristic', 'other'].includes(r.method)) {
      throw new AppError('invalid_usage_report', 'estimated requires method tokenizer_count, heuristic or other', 400);
    }
    if (r.measurement === 'estimated' && r.confidence === 'high') r.confidence = 'medium';
    if (r.input_tokens !== undefined && r.output_tokens !== undefined) {
      const sum = r.input_tokens + r.output_tokens;
      if (r.total_tokens !== undefined && r.total_tokens < sum) throw new AppError('invalid_usage_report', 'total_tokens < input + output', 400);
      r.total_tokens = r.total_tokens ?? sum;
    }
  }
  return ctx.store.tx(() => {
    const task = getTask(ctx.store, r.task_id);
    if (!task) throw new AppError('task_not_found', `unknown task ${r.task_id}`, 404);
    const res = ctx.store.one(
      'SELECT * FROM reservations WHERE participant_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT 1',
      participant.id, r.task_id,
    );
    if (!res) throw new AppError('not_your_task', 'you can only report usage for tasks you reserved', 403);
    const closedAt = res.closed_at ?? res.expires_at;
    if (res.state !== 'active' && ctx.now() > closedAt + 48 * 3600 * 1000) {
      throw new AppError('usage_report_too_late', 'usage must be reported within 48h after the reservation ended', 409);
    }
    const prev = ctx.store.one('SELECT id FROM usage_reports WHERE participant_id = ? AND report_key = ?', participant.id, r.report_id);
    if (prev) return { status: 'duplicate', usage_report_id: prev.id };
    const count = ctx.store.one('SELECT COUNT(*) AS n FROM usage_reports WHERE participant_id = ? AND task_id = ?', participant.id, r.task_id).n;
    if (count >= 50) throw new AppError('too_many_usage_reports', 'at most 50 usage reports per task', 429);
    const id = randomId('use_');
    ctx.store.exec(
      `INSERT INTO usage_reports (id, participant_id, report_key, task_id, reservation_id, provider, model_id, model_version,
         input_tokens, output_tokens, total_tokens, measurement, method, source, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, participant.id, r.report_id, r.task_id, res.id, r.provider.toLowerCase(), r.model_id, r.model_version ?? null,
      r.input_tokens ?? null, r.output_tokens ?? null, r.total_tokens ?? null, r.measurement, r.method, r.source, r.confidence, ctx.now(),
    );
    recordEvent(ctx.store, ctx.now(), participant.id, 'usage.reported', { usage_report_id: id, task_id: r.task_id, measurement: r.measurement });
    return { status: 'recorded', usage_report_id: id, stored: { ...r, verified_by_coordinator: false } };
  });
}

// ---------------------------------------------------------------- commits (from webhooks / completions)

export function recordCommits(ctx, { repo, shas, source }) {
  const w = ctx.store.one('SELECT participant_id, task_id FROM workspaces WHERE repo_full_name = ?', repo);
  let added = 0;
  for (const sha of shas) {
    if (!/^[0-9a-f]{40}$/.test(sha)) continue;
    added += ctx.store.exec(
      'INSERT OR IGNORE INTO commits (repo, sha, participant_id, task_id, source, at) VALUES (?, ?, ?, ?, ?, ?)',
      repo, sha, w?.participant_id ?? null, w?.task_id ?? null, source, ctx.now(),
    ).rowsWritten;
  }
  return added;
}

// ---------------------------------------------------------------- aggregates

function participantsIndex(ctx) {
  return new Map(ctx.store.all('SELECT id, kind, public_alias, created_at FROM participants WHERE revoked = 0').map((p) => [p.id, p]));
}

function tokensBy(rows) {
  const out = { reported_actual: 0, estimated: 0, reports: rows.length, unknown_reports: 0 };
  for (const u of rows) {
    if (u.measurement === 'unknown') out.unknown_reports++;
    else out[u.measurement] += u.total_tokens ?? 0;
  }
  return out;
}

function reciprocalFlags(ctx, from) {
  const pairs = ctx.store.all(
    `SELECT v.verifier_id AS a, rv.executor_id AS b, COUNT(*) AS n FROM verifications v JOIN reviews rv ON rv.id = v.review_id
     WHERE v.verdict = 'approve' AND v.created_at >= ? GROUP BY v.verifier_id, rv.executor_id`,
    from,
  );
  const key = new Map(pairs.map((p) => [`${p.a}>${p.b}`, p.n]));
  const flagged = new Set();
  for (const p of pairs) if (p.n >= 2 && (key.get(`${p.b}>${p.a}`) ?? 0) >= 2) flagged.add(p.a).add(p.b);
  return flagged;
}

export function leaderboard(ctx, { period = '30d', limit = 100 } = {}) {
  const { from, to } = periodRange(period, ctx.now());
  const people = participantsIndex(ctx);
  const rows = new Map();
  const row = (pid) => {
    if (!rows.has(pid)) {
      rows.set(pid, {
        reserved: 0, delivered: 0, accepted: 0, rejected: 0, expired: 0, released: 0, merged_prs: 0, verifications: 0,
        commits_pushed: 0, delivery_minutes: [], usage: [],
      });
    }
    return rows.get(pid);
  };
  for (const r of ctx.store.all('SELECT participant_id, state, created_at, closed_at FROM reservations WHERE created_at BETWEEN ? AND ?', from, to)) {
    const x = row(r.participant_id);
    x.reserved++;
    if (r.state === 'expired') x.expired++;
    if (r.state === 'released') x.released++;
  }
  for (const c of ctx.store.all(
    `SELECT c.participant_id, c.created_at, r.created_at AS assigned_at FROM completions c JOIN reservations r ON r.id = c.reservation_id
     WHERE c.created_at BETWEEN ? AND ?`, from, to,
  )) {
    const x = row(c.participant_id);
    x.delivered++;
    x.delivery_minutes.push((c.created_at - c.assigned_at) / 60000);
  }
  for (const rv of ctx.store.all('SELECT executor_id, state FROM reviews WHERE updated_at BETWEEN ? AND ?', from, to)) {
    const x = row(rv.executor_id);
    if (['ready_to_merge', 'merged'].includes(rv.state)) x.accepted++;
    if (rv.state === 'merged') x.merged_prs++;
    if (rv.state === 'changes_requested') x.rejected++;
  }
  for (const v of ctx.store.all('SELECT verifier_id FROM verifications WHERE created_at BETWEEN ? AND ?', from, to)) row(v.verifier_id).verifications++;
  for (const c of ctx.store.all("SELECT participant_id FROM commits WHERE source = 'github_push' AND participant_id IS NOT NULL AND at BETWEEN ? AND ?", from, to)) {
    row(c.participant_id).commits_pushed++;
  }
  for (const u of ctx.store.all('SELECT * FROM usage_reports WHERE created_at BETWEEN ? AND ?', from, to)) row(u.participant_id).usage.push(u);
  const webhookCommits = ctx.store.one("SELECT COUNT(*) AS n FROM commits WHERE source = 'github_push'").n > 0;
  const flagged = reciprocalFlags(ctx, from);

  const out = [];
  for (const [pid, x] of rows) {
    const p = people.get(pid);
    if (!p) continue;
    const deliveredTasks = x.delivered;
    out.push({
      participant: p.public_alias,
      account: p.kind === 'google' ? 'google_verified' : 'anonymous_pseudonym',
      reserved: x.reserved,
      delivered: x.delivered,
      accepted: x.accepted,
      rejected: x.rejected,
      expired: x.expired,
      released: x.released,
      merged_prs: x.merged_prs,
      verifications: x.verifications,
      commits_pushed: webhookCommits ? x.commits_pushed : null,
      acceptance_rate: rate(x.accepted, x.accepted + x.rejected),
      delivered_within_24h_rate: rate(x.delivered, x.delivered + x.expired),
      median_minutes_to_delivery: median(x.delivery_minutes),
      tokens: { ...tokensBy(x.usage), deliveries_without_usage_report: Math.max(0, deliveredTasks - new Set(x.usage.map((u) => u.task_id)).size) },
      flags: flagged.has(pid) ? ['reciprocal_approvals'] : [],
    });
  }
  out.sort(
    (a, b) =>
      b.accepted - a.accepted ||
      (b.acceptance_rate ?? -1) - (a.acceptance_rate ?? -1) ||
      b.merged_prs - a.merged_prs ||
      (a.median_minutes_to_delivery ?? Infinity) - (b.median_minutes_to_delivery ?? Infinity) ||
      a.participant.localeCompare(b.participant),
  );
  return out.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));
}

export function summary(ctx, { period = '30d' } = {}) {
  const { from, to } = periodRange(period, ctx.now());
  const one = (sql, ...a) => ctx.store.one(sql, ...a).n;
  const delivered = one('SELECT COUNT(*) AS n FROM completions WHERE created_at BETWEEN ? AND ?', from, to);
  const expired = one("SELECT COUNT(*) AS n FROM reservations WHERE state = 'expired' AND closed_at BETWEEN ? AND ?", from, to);
  const minutes = ctx.store
    .all('SELECT c.created_at - r.created_at AS d FROM completions c JOIN reservations r ON r.id = c.reservation_id WHERE c.created_at BETWEEN ? AND ?', from, to)
    .map((r) => r.d / 60000);
  const usage = ctx.store.all('SELECT * FROM usage_reports WHERE created_at BETWEEN ? AND ?', from, to);
  const accepted = one(`SELECT COUNT(*) AS n FROM reviews WHERE state IN ${ACCEPTED} AND updated_at BETWEEN ? AND ?`, from, to);
  const rejected = one("SELECT COUNT(*) AS n FROM reviews WHERE state = 'changes_requested' AND updated_at BETWEEN ? AND ?", from, to);
  return {
    period,
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    participants: {
      google_verified: one("SELECT COUNT(*) AS n FROM participants WHERE kind = 'google' AND revoked = 0"),
      anonymous_pseudonyms: one("SELECT COUNT(*) AS n FROM participants WHERE kind = 'anonymous' AND revoked = 0"),
      active_in_period: one('SELECT COUNT(DISTINCT participant_id) AS n FROM reservations WHERE created_at BETWEEN ? AND ?', from, to),
    },
    reserved: one('SELECT COUNT(*) AS n FROM reservations WHERE created_at BETWEEN ? AND ?', from, to),
    active_now: one("SELECT COUNT(*) AS n FROM reservations WHERE state = 'active'"),
    delivered,
    accepted,
    rejected,
    expired,
    merged_prs: one("SELECT COUNT(*) AS n FROM reviews WHERE state = 'merged' AND updated_at BETWEEN ? AND ?", from, to),
    verifications: one('SELECT COUNT(*) AS n FROM verifications WHERE created_at BETWEEN ? AND ?', from, to),
    commits_pushed: one("SELECT COUNT(*) AS n FROM commits WHERE source = 'github_push'") > 0
      ? one("SELECT COUNT(*) AS n FROM commits WHERE source = 'github_push' AND at BETWEEN ? AND ?", from, to)
      : null,
    acceptance_rate: rate(accepted, accepted + rejected),
    delivered_within_24h_rate: rate(delivered, delivered + expired),
    median_minutes_to_delivery: median(minutes),
    tokens: { ...tokensBy(usage), self_reported: true, verified_by_coordinator: false },
  };
}

export function byModel(ctx, { period = '30d' } = {}) {
  const { from, to } = periodRange(period, ctx.now());
  const groups = new Map();
  for (const u of ctx.store.all('SELECT * FROM usage_reports WHERE created_at BETWEEN ? AND ?', from, to)) {
    const k = `${u.provider}|${u.model_id}|${u.model_version ?? ''}`;
    if (!groups.has(k)) groups.set(k, { provider: u.provider, model_id: u.model_id, model_version: u.model_version, rows: [], tasks: new Set(), people: new Set() });
    const g = groups.get(k);
    g.rows.push(u);
    g.tasks.add(u.task_id);
    g.people.add(u.participant_id);
  }
  const acceptedPairs = new Set(
    ctx.store.all(`SELECT task_id, executor_id FROM reviews WHERE state IN ${ACCEPTED}`).map((r) => `${r.task_id}|${r.executor_id}`),
  );
  return [...groups.values()]
    .map((g) => ({
      provider: g.provider,
      model_id: g.model_id,
      model_version: g.model_version,
      tasks: g.tasks.size,
      participants: g.people.size,
      accepted_deliveries: new Set(g.rows.filter((u) => acceptedPairs.has(`${u.task_id}|${u.participant_id}`)).map((u) => u.task_id)).size,
      tokens: tokensBy(g.rows),
    }))
    .sort((a, b) => b.accepted_deliveries - a.accepted_deliveries || b.tasks - a.tasks);
}

export function byProject(ctx, { period = '30d' } = {}) {
  const { from, to } = periodRange(period, ctx.now());
  const repoOf = new Map(ctx.store.all('SELECT id, data_json FROM tasks').map((t) => {
    const d = JSON.parse(t.data_json);
    return [t.id, d.repo ?? (d.review ? null : 'coordinator')];
  }));
  const target = new Map(ctx.store.all('SELECT id, data_json FROM tasks').map((t) => [t.id, JSON.parse(t.data_json).review?.target_task_id ?? t.id]));
  const out = new Map();
  const g = (taskId) => {
    const repo = repoOf.get(target.get(taskId) ?? taskId) ?? 'coordinator';
    if (!out.has(repo)) out.set(repo, { project: repo, reserved: 0, delivered: 0, accepted: 0, rejected: 0, expired: 0, merged_prs: 0, usage: [] });
    return out.get(repo);
  };
  for (const r of ctx.store.all('SELECT task_id, state FROM reservations WHERE created_at BETWEEN ? AND ?', from, to)) {
    const x = g(r.task_id);
    x.reserved++;
    if (r.state === 'expired') x.expired++;
  }
  for (const c of ctx.store.all('SELECT task_id FROM completions WHERE created_at BETWEEN ? AND ?', from, to)) g(c.task_id).delivered++;
  for (const rv of ctx.store.all('SELECT task_id, state FROM reviews WHERE updated_at BETWEEN ? AND ?', from, to)) {
    const x = g(rv.task_id);
    if (['ready_to_merge', 'merged'].includes(rv.state)) x.accepted++;
    if (rv.state === 'merged') x.merged_prs++;
    if (rv.state === 'changes_requested') x.rejected++;
  }
  for (const u of ctx.store.all('SELECT * FROM usage_reports WHERE created_at BETWEEN ? AND ?', from, to)) g(u.task_id).usage.push(u);
  return [...out.values()].map(({ usage, ...x }) => ({ ...x, tokens: tokensBy(usage) })).sort((a, b) => b.accepted - a.accepted || a.project.localeCompare(b.project));
}

export function byTask(ctx, { period = '30d', task_id = null } = {}) {
  const { from, to } = periodRange(period, ctx.now());
  const tasks = task_id ? [task_id] : ctx.store.all("SELECT id FROM tasks WHERE origin = 'catalog'").map((t) => t.id);
  return tasks.map((id) => {
    const one = (sql, ...a) => ctx.store.one(sql, ...a).n;
    const usage = ctx.store.all('SELECT * FROM usage_reports WHERE task_id = ? AND created_at BETWEEN ? AND ?', id, from, to);
    return {
      task_id: id,
      reserved: one('SELECT COUNT(*) AS n FROM reservations WHERE task_id = ? AND created_at BETWEEN ? AND ?', id, from, to),
      expired: one("SELECT COUNT(*) AS n FROM reservations WHERE task_id = ? AND state = 'expired' AND created_at BETWEEN ? AND ?", id, from, to),
      delivered: one('SELECT COUNT(*) AS n FROM completions WHERE task_id = ? AND created_at BETWEEN ? AND ?', id, from, to),
      accepted: one(`SELECT COUNT(*) AS n FROM reviews WHERE task_id = ? AND state IN ${ACCEPTED} AND updated_at BETWEEN ? AND ?`, id, from, to),
      rejected: one("SELECT COUNT(*) AS n FROM reviews WHERE task_id = ? AND state = 'changes_requested' AND updated_at BETWEEN ? AND ?", id, from, to),
      models: [...new Set(usage.map((u) => `${u.provider}/${u.model_id}${u.model_version ? `@${u.model_version}` : ''}`))],
      tokens: tokensBy(usage),
    };
  });
}

export function history(ctx, { days = 30 } = {}) {
  const n = Math.min(Math.max(Number(days) || 30, 1), 365);
  const end = ctx.now();
  const start = end - n * DAY;
  const buckets = [];
  for (let i = 0; i < n; i++) {
    const day = new Date(start + (i + 1) * DAY);
    buckets.push({ date: day.toISOString().slice(0, 10), reserved: 0, delivered: 0, accepted: 0, rejected: 0, expired: 0, tokens_reported_actual: 0, tokens_estimated: 0 });
  }
  const idx = (t) => Math.min(n - 1, Math.floor((t - start) / DAY));
  const add = (t, key, v = 1) => {
    if (t >= start && t <= end) buckets[idx(t)][key] += v;
  };
  for (const r of ctx.store.all('SELECT created_at, state, closed_at FROM reservations WHERE created_at >= ? OR closed_at >= ?', start, start)) {
    add(r.created_at, 'reserved');
    if (r.state === 'expired') add(r.closed_at, 'expired');
  }
  for (const c of ctx.store.all('SELECT created_at FROM completions WHERE created_at >= ?', start)) add(c.created_at, 'delivered');
  for (const rv of ctx.store.all('SELECT state, updated_at FROM reviews WHERE updated_at >= ?', start)) {
    if (['ready_to_merge', 'merged'].includes(rv.state)) add(rv.updated_at, 'accepted');
    if (rv.state === 'changes_requested') add(rv.updated_at, 'rejected');
  }
  for (const u of ctx.store.all("SELECT created_at, measurement, total_tokens FROM usage_reports WHERE created_at >= ? AND measurement <> 'unknown'", start)) {
    add(u.created_at, u.measurement === 'reported_actual' ? 'tokens_reported_actual' : 'tokens_estimated', u.total_tokens ?? 0);
  }
  return buckets;
}

export function metricsBundle(ctx, { period = '30d', days = 30 } = {}) {
  return {
    generated_at: new Date(ctx.now()).toISOString(),
    summary: summary(ctx, { period }),
    leaderboard: leaderboard(ctx, { period, limit: 50 }),
    by_model: byModel(ctx, { period }),
    by_project: byProject(ctx, { period }),
    history: history(ctx, { days }),
    definitions: DEFINITIONS,
    privacy: 'Participants appear only under a generated pseudonym. E-mails, Google names and IP data are never published.',
  };
}
