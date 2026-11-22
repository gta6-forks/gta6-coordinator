// Task distribution: eligibility, reservations (hard 24h timeout from assignment, NO renewal), idempotency,
// one task at a time, abandonment rules.
// All mutations run inside store.tx(); the Coordinator Durable Object additionally serializes requests,
// and partial unique indexes guarantee one active reservation per task and per participant.
import { AppError, DIFFICULTY_ORDER, PRIORITY_ORDER, randomId } from '../util.js';
import { matchesFilters, profileMismatches } from '../domain/task.js';
import { isUniqueViolation, recordEvent } from '../store/store.js';
import { getTask, loadTasks } from './catalog.js';

export const HARD_TIMEOUT_HOURS = 24;

export function reservationPolicy(env) {
  // The 24h limit is absolute (owner decision 2026-11-21). The env may only make it SHORTER (useful for tests/ops).
  const hours = Math.min(HARD_TIMEOUT_HOURS, Number(env.RESERVATION_TTL_HOURS ?? HARD_TIMEOUT_HOURS));
  return {
    ttlMs: hours * 3600 * 1000,
    renewable: false,
    reclaimCooldownMs: Number(env.RECLAIM_COOLDOWN_HOURS ?? 72) * 3600 * 1000,
    maxExpirationsPerWeek: Number(env.MAX_EXPIRATIONS_PER_WEEK ?? 3),
  };
}

export function sweepExpired(ctx) {
  const now = ctx.now();
  const expired = ctx.store.all("SELECT id, task_id, participant_id FROM reservations WHERE state = 'active' AND expires_at <= ?", now);
  if (!expired.length) return 0;
  ctx.store.exec("UPDATE reservations SET state = 'expired', closed_at = ? WHERE state = 'active' AND expires_at <= ?", now, now);
  for (const r of expired) recordEvent(ctx.store, now, 'system', 'reservation.expired', r);
  return expired.length;
}

function depSatisfied(depId, byId) {
  const dep = byId.get(depId);
  if (!dep) return false; // unknown dependency: stay blocked (conservative)
  return dep.status === 'done' || dep.data.state === 'closed';
}

function siblingVerifyIds(task) {
  const { review_id: rid } = task.data.review;
  return [1, 2].map((s) => `local:verify/${rid}/${s}`).filter((id) => id !== task.id);
}

export function evaluate(ctx, task, participant, index) {
  const reasons = [];
  const d = task.data;
  if (!d.executable) reasons.push('not_executable_group');
  if (d.readiness !== 'ready') reasons.push(`readiness:${d.readiness}`);
  if (d.state === 'closed') reasons.push('closed');
  if (task.status !== 'open') reasons.push(`status:${task.status}`);
  for (const dep of d.depends_on) if (!depSatisfied(dep, index.byId)) reasons.push(`blocked_by:${dep}`);
  if (d.parent) {
    const parent = index.byId.get(d.parent);
    if (parent && parent.data.executable) reasons.push('parent_is_not_a_group');
  }
  const active = index.activeByTask.get(task.id);
  if (active && active.participant_id !== participant.id) reasons.push('reserved');
  if (d.type === 'strategic' && participant.kind !== 'google') reasons.push('requires_google_login');
  if (d.role === 'verify') {
    if (d.review.executor_id === participant.id) reasons.push('verifier_is_executor');
    const sib = siblingVerifyIds(task);
    const held = ctx.store.one(
      `SELECT 1 AS x FROM reservations WHERE participant_id = ? AND state IN ('active','completed') AND task_id IN (${sib.map(() => '?').join(',')})`,
      participant.id,
      ...sib,
    );
    if (held) reasons.push('verifier_not_independent');
  }
  const policy = reservationPolicy(ctx.env);
  const expiredHere = ctx.store.one(
    "SELECT 1 AS x FROM reservations WHERE participant_id = ? AND task_id = ? AND state = 'expired' AND closed_at > ?",
    participant.id, task.id, ctx.now() - policy.reclaimCooldownMs,
  );
  if (expiredHere) reasons.push('you_let_this_task_expire_recently');
  reasons.push(...profileMismatches(d.requirements.implementation, participant.profile));
  return reasons;
}

function buildIndex(ctx) {
  const tasks = loadTasks(ctx.store);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const activeByTask = new Map(
    ctx.store.all("SELECT * FROM reservations WHERE state = 'active'").map((r) => [r.task_id, r]),
  );
  return { tasks, byId, activeByTask };
}

function sortCandidates(tasks) {
  return [...tasks].sort(
    (a, b) =>
      PRIORITY_ORDER[a.data.priority] - PRIORITY_ORDER[b.data.priority] ||
      DIFFICULTY_ORDER[a.data.difficulty] - DIFFICULTY_ORDER[b.data.difficulty] ||
      a.id.localeCompare(b.id),
  );
}

export function publicTask(task, extra = {}) {
  const d = structuredClone(task.data);
  if (d.review) delete d.review.executor_id;
  return { ...d, status: task.status, ...extra };
}

function publicReservation(r, policy, now) {
  return {
    id: r.id,
    task_id: r.task_id,
    state: r.state,
    created_at: new Date(r.created_at).toISOString(),
    expires_at: new Date(r.expires_at).toISOString(),
    renewable: false,
    hard_timeout: true,
    remaining_seconds: Math.max(0, Math.floor((r.expires_at - now) / 1000)),
  };
}

export function listTasks(ctx, participant, { filters = {}, include_ineligible = false } = {}) {
  sweepExpired(ctx);
  const index = buildIndex(ctx);
  const out = [];
  for (const t of sortCandidates(index.tasks)) {
    if (!matchesFilters(t.data, filters)) continue;
    const reasons = evaluate(ctx, t, participant, index);
    if (reasons.length && !include_ineligible) continue;
    out.push(publicTask(t, { eligible: reasons.length === 0, ineligible_reasons: reasons }));
  }
  return out;
}

export function publicCatalog(ctx) {
  sweepExpired(ctx);
  const index = buildIndex(ctx);
  return sortCandidates(index.tasks)
    .filter((t) => t.origin === 'catalog')
    .map((t) => ({
      id: t.id,
      title: t.data.title,
      url: t.data.url ?? null,
      kind: t.data.kind,
      status: t.status,
      reserved: index.activeByTask.has(t.id),
      blocked_by: t.data.depends_on.filter((dep) => !depSatisfied(dep, index.byId)),
      filters: t.data.filters,
    }));
}

function idempotent(ctx, participant, key, op, compute) {
  if (!key) return compute();
  if (typeof key !== 'string' || key.length < 8 || key.length > 100) {
    throw new AppError('invalid_idempotency_key', 'idempotency_key must be 8-100 chars', 400);
  }
  const prev = ctx.store.one('SELECT op, response_json FROM idempotency WHERE participant_id = ? AND key = ?', participant.id, key);
  if (prev) {
    if (prev.op !== op) throw new AppError('idempotency_key_reused', `key already used for ${prev.op}`, 409);
    return { ...JSON.parse(prev.response_json), idempotent_replay: true };
  }
  const result = compute();
  ctx.store.exec(
    'INSERT INTO idempotency (participant_id, key, op, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
    participant.id, key, op, JSON.stringify(result), ctx.now(),
  );
  return result;
}

export function activeReservation(ctx, participant) {
  return ctx.store.one("SELECT * FROM reservations WHERE participant_id = ? AND state = 'active'", participant.id);
}

export function claim(ctx, participant, { task_id = null, filters = {}, idempotency_key = null } = {}) {
  const policy = reservationPolicy(ctx.env);
  return ctx.store.tx(() => {
    sweepExpired(ctx);
    return idempotent(ctx, participant, idempotency_key, task_id ? `claim:${task_id}` : 'claim_next', () => {
      const recentExpired = ctx.store.one(
        "SELECT COUNT(*) AS n FROM reservations WHERE participant_id = ? AND state = 'expired' AND closed_at > ?",
        participant.id, ctx.now() - 7 * 24 * 3600 * 1000,
      ).n;
      if (recentExpired >= policy.maxExpirationsPerWeek) {
        throw new AppError('too_many_expirations', `you let ${recentExpired} tasks expire in the last 7 days; new claims are paused`, 429);
      }
      const current = activeReservation(ctx, participant);
      if (current) {
        throw new AppError('active_reservation_exists', 'finish, release or let your current reservation expire first (one task at a time)', 409, {
          reservation: publicReservation(current, policy, ctx.now()),
        });
      }
      const index = buildIndex(ctx);
      let candidates;
      if (task_id) {
        const t = index.byId.get(task_id);
        if (!t) throw new AppError('task_not_found', `unknown task ${task_id}`, 404);
        const reasons = evaluate(ctx, t, participant, index);
        if (reasons.length) throw new AppError('task_not_eligible', 'task cannot be reserved by you now', 409, { reasons });
        candidates = [t];
      } else {
        candidates = sortCandidates(index.tasks).filter(
          (t) => matchesFilters(t.data, filters) && evaluate(ctx, t, participant, index).length === 0,
        );
      }
      const now = ctx.now();
      for (const t of candidates) {
        const id = randomId('res_');
        try {
          const { rowsWritten } = ctx.store.exec(
            `INSERT INTO reservations (id, task_id, participant_id, state, created_at, expires_at)
             SELECT ?, ?, ?, 'active', ?, ? WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status = 'open')`,
            id, t.id, participant.id, now, now + policy.ttlMs, t.id,
          );
          if (!rowsWritten) continue;
        } catch (err) {
          if (isUniqueViolation(err)) continue;
          throw err;
        }
        recordEvent(ctx.store, now, participant.id, 'reservation.created', { reservation_id: id, task_id: t.id });
        const r = ctx.store.one('SELECT * FROM reservations WHERE id = ?', id);
        return { status: 'reserved', reservation: publicReservation(r, policy, ctx.now()), task: publicTask(getTask(ctx.store, t.id)) };
      }
      return { status: 'no_task_available', message: 'no unblocked task matches your profile and filters right now' };
    });
  });
}

function ownedActive(ctx, participant, reservationId) {
  const r = ctx.store.one('SELECT * FROM reservations WHERE id = ?', reservationId);
  if (!r || r.participant_id !== participant.id) throw new AppError('reservation_not_found', 'no such reservation for you', 404);
  if (r.state !== 'active') {
    if (r.state === 'expired') throw new AppError('reservation_expired', 'the 24h deadline passed; late results are not accepted', 410);
    throw new AppError('reservation_not_active', `reservation is ${r.state}`, 409);
  }
  if (r.expires_at <= ctx.now()) throw new AppError('reservation_expired', 'the 24h deadline passed; late results are not accepted', 410);
  return r;
}

export function renew() {
  throw new AppError('renewal_not_allowed', 'tasks have a hard 24h timeout from assignment; deliver or release before it ends', 409);
}

export function release(ctx, participant, reservationId, reason = '') {
  return ctx.store.tx(() => {
    sweepExpired(ctx);
    const r = ownedActive(ctx, participant, reservationId);
    const now = ctx.now();
    ctx.store.exec("UPDATE reservations SET state = 'released', closed_at = ? WHERE id = ?", now, r.id);
    recordEvent(ctx.store, now, participant.id, 'reservation.released', { reservation_id: r.id, reason: String(reason).slice(0, 500) });
    return { status: 'released', reservation_id: r.id, task_id: r.task_id };
  });
}

export function currentReservation(ctx, participant) {
  sweepExpired(ctx);
  const r = activeReservation(ctx, participant);
  if (!r) return { status: 'none' };
  return { status: 'active', reservation: publicReservation(r, reservationPolicy(ctx.env), ctx.now()), task: publicTask(getTask(ctx.store, r.task_id)) };
}

export { ownedActive, idempotent };
