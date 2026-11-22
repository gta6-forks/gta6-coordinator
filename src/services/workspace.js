// Isolated work repositories: one per reservation, write-scoped to that repository only.
// State lives in the Durable Object; GitHub side effects go through the provisioner and are reconciled
// idempotently (the database decides what should exist; reconcile() makes GitHub match).
import { AppError, randomHexId } from '../util.js';
import { recordEvent } from '../store/store.js';
import { getTask } from './catalog.js';
import { checkRateLimit } from './auth.js';
import { ownedActive, sweepExpired } from './scheduler.js';
import { createVerificationTasks } from './review.js';

const DAY = 24 * 3600 * 1000;

export function workspacePolicy(env) {
  return {
    retentionMs: Number(env.WORKSPACE_RETENTION_DAYS ?? 7) * DAY,
    credentialsPerHour: Number(env.WORKSPACE_CREDENTIALS_PER_HOUR ?? 60),
    org: env.WORKSPACE_ORG || null,
  };
}

export function taskBranch(taskId) {
  return `task/${taskId.replace(/^.*#/, 'issue-').replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/^local:/, '')}`;
}

function view(ctx, w) {
  if (!w) return null;
  const base = (ctx.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
  const repo = w.repo_full_name;
  return {
    workspace_id: w.id,
    state: w.state,
    task_id: w.task_id,
    repo: repo ?? null,
    clone_url: repo ? `https://github.com/${repo}.git` : null,
    integration_repo: w.integration_repo ?? null,
    task_branch: w.task_branch,
    base_sha: w.base_sha ?? null,
    last_error: w.last_error ?? null,
    write_scope:
      'Write access to this single repository only, while your reservation is active. GitHub tokens are repository-scoped, not branch-scoped. Tokens last at most 1 hour; the credential helper fetches a new one when git asks.',
    start_from: w.integration_repo
      ? {
          repo: w.integration_repo,
          branch: w.task_branch,
          sha: w.base_sha ?? null,
          clone_url: `https://github.com/${w.integration_repo}.git`,
          note: 'public, read-only: clone it without credentials',
        }
      : null,
    steps: repo
      ? [
          `git clone --branch ${w.task_branch} https://github.com/${w.integration_repo}.git work && cd work`,
          `git remote add work https://github.com/${repo}.git`,
          '# commit your changes, then:',
          `git push work HEAD:refs/heads/${w.task_branch}`,
          'submit_completion with workspace_id and the pushed commit SHA',
        ]
      : [],
    credential_helper: repo
      ? {
          endpoint: `${base}/api/git/credential`,
          setup: [
            `git config --global credential.https://github.com/${repo}.git.helper "!node /path/to/git-credential-gta6.mjs"`,
            `git config --global credential.https://github.com/${repo}.git.useHttpPath true`,
            'export GTA6_TOKEN=<your coordinator token>  # never commit it',
          ],
        }
      : null,
  };
}

function rowById(ctx, id) {
  return ctx.store.one('SELECT * FROM workspaces WHERE id = ?', id);
}

/** MCP tool get_workspace: create (idempotently) the work repository for the caller's active reservation. */
export async function getWorkspace(ctx, participant, { reservation_id }) {
  const created = ctx.store.tx(() => {
    sweepExpired(ctx);
    const r = ownedActive(ctx, participant, reservation_id);
    const task = getTask(ctx.store, r.task_id);
    if (task.data.role === 'verify') {
      throw new AppError('verify_uses_integration_repo', 'verifiers check out the integrated commit from the main fork; no work repository is issued', 400);
    }
    const existing = ctx.store.one('SELECT * FROM workspaces WHERE reservation_id = ?', r.id);
    if (existing) return existing;
    const id = randomHexId('ws_');
    const integration = task.data.role === 'plan' ? ctx.env.COORDINATOR_REPO || null : task.data.fork_repo ?? null;
    ctx.store.exec(
      `INSERT INTO workspaces (id, reservation_id, task_id, participant_id, state, integration_repo, task_branch, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'requested', ?, ?, ?, ?)`,
      id, r.id, task.id, participant.id, integration, taskBranch(task.id), ctx.now(), ctx.now(),
    );
    recordEvent(ctx.store, ctx.now(), participant.id, 'workspace.requested', { workspace_id: id, task_id: task.id });
    return rowById(ctx, id);
  });
  if (created.state !== 'requested') return view(ctx, created);

  const task = getTask(ctx.store, created.task_id);
  const res = await ctx.provisioner.provision({ workspace: created, task: task.data });
  if (res.repo_full_name) {
    ctx.store.exec(
      `UPDATE workspaces SET state = 'ready', repo_full_name = ?, integration_repo = COALESCE(?, integration_repo),
         task_branch = COALESCE(?, task_branch), base_sha = ?, updated_at = ? WHERE id = ? AND state = 'requested'`,
      res.repo_full_name, res.integration_repo ?? null, res.task_branch ?? null, res.base_sha ?? null, ctx.now(), created.id,
    );
    recordEvent(ctx.store, ctx.now(), 'system', 'workspace.ready', { workspace_id: created.id, repo: res.repo_full_name });
  } else {
    ctx.store.exec('UPDATE workspaces SET last_error = ?, updated_at = ? WHERE id = ?', res.status ?? 'unknown', ctx.now(), created.id);
  }
  return { ...view(ctx, rowById(ctx, created.id)), provisioner: ctx.provisioner.describe() };
}

/**
 * HTTP /api/git/credential (called by the git credential helper with the coordinator bearer token).
 * Returns a token that can write ONLY to the caller's own work repository, only while the reservation is active.
 */
export async function issueGitCredential(ctx, participant, { repo }) {
  const w = ctx.store.tx(() => {
    sweepExpired(ctx);
    const row = ctx.store.one(
      `SELECT w.* FROM workspaces w JOIN reservations r ON r.id = w.reservation_id
       WHERE w.participant_id = ? AND w.repo_full_name = ? AND w.state = 'ready' AND r.state = 'active' AND r.expires_at > ?`,
      participant.id, repo, ctx.now(),
    );
    if (!row) throw new AppError('no_write_access', 'no active work repository of yours matches this path', 403);
    if (!checkRateLimit(ctx, `cred:${row.id}`, workspacePolicy(ctx.env).credentialsPerHour, 3600_000)) {
      throw new AppError('rate_limited', 'too many credential requests for this workspace', 429);
    }
    return row;
  });
  const cred = await ctx.provisioner.mintCredential({ workspace: w });
  ctx.store.exec('UPDATE workspaces SET credentials_issued = credentials_issued + 1, updated_at = ? WHERE id = ?', ctx.now(), w.id);
  recordEvent(ctx.store, ctx.now(), participant.id, 'workspace.credential_issued', { workspace_id: w.id, expires_at: cred.expires_at });
  return cred;
}

/** Called from submitCompletion when the delivery comes from a work repository. Runs inside its transaction. */
export function beginIntegration(ctx, participant, reservation, completion) {
  const w = ctx.store.one('SELECT * FROM workspaces WHERE id = ? AND reservation_id = ?', completion.workspace_id, reservation.id);
  if (!w || w.participant_id !== participant.id) throw new AppError('workspace_not_found', 'workspace does not belong to this reservation', 404);
  if (w.state !== 'ready') throw new AppError('workspace_not_ready', `workspace is ${w.state}`, 409);
  if (!w.integration_repo) throw new AppError('integration_repo_missing', 'the main fork for this task is not configured yet', 409);
  ctx.store.exec("UPDATE workspaces SET state = 'integrating', head_sha = ?, last_error = NULL, updated_at = ? WHERE id = ?", completion.commit_sha, ctx.now(), w.id);
  return w.id;
}

export async function dispatchIntegration(ctx, workspaceId) {
  const w = rowById(ctx, workspaceId);
  if (!w || w.state !== 'integrating') return null;
  const res = await ctx.provisioner.integrate({ workspace: w, head_sha: w.head_sha });
  recordEvent(ctx.store, ctx.now(), 'system', 'workspace.integration_dispatched', { workspace_id: w.id, status: res.status });
  return res;
}

/**
 * Result of the trusted integration job (callback with shared secret).
 *   success: { workspace_id, outcome: 'integrated', pr_url, commit_sha }   commit must equal the submitted head
 *   failure: { workspace_id, outcome: 'conflict' | 'error', detail }        participant pulls, fixes, resubmits
 *   unsafe:  { workspace_id, outcome: 'forbidden_content', detail }         access revoked, repo queued for deletion
 */
export function integrationResult(ctx, body) {
  return ctx.store.tx(() => {
    const w = rowById(ctx, body.workspace_id ?? '');
    if (!w) throw new AppError('workspace_not_found', 'unknown workspace', 404);
    sweepExpired(ctx);
    expireLateIntegrations(ctx);
    const review = ctx.store.one("SELECT * FROM reviews WHERE workspace_id = ? AND state = 'integrating'", w.id);
    const late = ctx.store.one("SELECT 1 AS x FROM reviews WHERE workspace_id = ? AND state = 'expired'", w.id);
    if (late && !review) {
      recordEvent(ctx.store, ctx.now(), 'integrator', 'workspace.late_result_rejected', { workspace_id: w.id, outcome: body.outcome ?? null });
      return { status: 'rejected_late', reason: 'the 24h deadline passed before integration finished' };
    }
    if (w.state !== 'integrating' || !review) {
      const done = ctx.store.one('SELECT id, state FROM reviews WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1', w.id);
      return { status: 'ignored', reason: `workspace is ${w.state}`, review: done ?? null };
    }
    const now = ctx.now();
    const detail = String(body.detail ?? '').slice(0, 2000);
    if (body.outcome === 'integrated') {
      if (body.commit_sha !== w.head_sha) throw new AppError('commit_mismatch', 'integration must not rewrite the submitted commit', 409);
      if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(body.pr_url ?? '')) throw new AppError('invalid_pr_url', 'pr_url required', 400);
      ctx.store.exec("UPDATE reviews SET state = 'verifying', pr_url = ?, updated_at = ? WHERE id = ?", body.pr_url, now, review.id);
      ctx.store.exec("UPDATE workspaces SET state = 'integrated', updated_at = ? WHERE id = ?", now, w.id);
      ctx.store.exec("UPDATE reservations SET state = 'completed', closed_at = ? WHERE id = ? AND state = 'active'", now, w.reservation_id);
      const slots = createVerificationTasks(ctx, ctx.store.one('SELECT * FROM reviews WHERE id = ?', review.id), getTask(ctx.store, w.task_id));
      recordEvent(ctx.store, now, 'integrator', 'workspace.integrated', { workspace_id: w.id, pr_url: body.pr_url });
      return { status: 'verifying', review_id: review.id, verification_tasks: slots };
    }
    if (body.outcome === 'conflict' || body.outcome === 'error') {
      ctx.store.exec("UPDATE reviews SET state = 'integration_failed', updated_at = ? WHERE id = ?", now, review.id);
      ctx.store.exec("UPDATE workspaces SET state = 'ready', last_error = ?, updated_at = ? WHERE id = ?", `${body.outcome}: ${detail}`, now, w.id);
      ctx.store.exec("UPDATE tasks SET status = 'open', updated_at = ? WHERE id = ?", now, w.task_id);
      recordEvent(ctx.store, now, 'integrator', 'workspace.integration_failed', { workspace_id: w.id, outcome: body.outcome });
      return { status: 'integration_failed', outcome: body.outcome };
    }
    if (body.outcome === 'forbidden_content') {
      ctx.store.exec("UPDATE reviews SET state = 'integration_failed', updated_at = ? WHERE id = ?", now, review.id);
      ctx.store.exec("UPDATE workspaces SET state = 'failed', last_error = ?, delete_after = ?, updated_at = ? WHERE id = ?", `forbidden_content: ${detail}`, now, now, w.id);
      ctx.store.exec("UPDATE reservations SET state = 'cancelled', closed_at = ? WHERE id = ? AND state = 'active'", now, w.reservation_id);
      ctx.store.exec("UPDATE tasks SET status = 'open', updated_at = ? WHERE id = ?", now, w.task_id);
      recordEvent(ctx.store, now, 'integrator', 'workspace.forbidden_content', { workspace_id: w.id, participant_id: w.participant_id });
      return { status: 'revoked_for_forbidden_content' };
    }
    throw new AppError('invalid_outcome', 'outcome must be integrated|conflict|error|forbidden_content', 400);
  });
}

/** Integrations still running when the 24h deadline passes are void: the task goes back to the pool. */
export function expireLateIntegrations(ctx) {
  const now = ctx.now();
  const late = ctx.store.all(
    `SELECT rv.id, rv.task_id, rv.workspace_id FROM reviews rv
     JOIN workspaces w ON w.id = rv.workspace_id JOIN reservations r ON r.id = w.reservation_id
     WHERE rv.state = 'integrating' AND r.state = 'expired'`,
  );
  for (const rv of late) {
    ctx.store.exec("UPDATE reviews SET state = 'expired', updated_at = ? WHERE id = ?", now, rv.id);
    ctx.store.exec("UPDATE tasks SET status = 'open', updated_at = ? WHERE id = ? AND status = 'in_review'", now, rv.task_id);
    recordEvent(ctx.store, now, 'system', 'review.expired', { review_id: rv.id, workspace_id: rv.workspace_id });
  }
  return late.length;
}

/**
 * Idempotent reconciliation, run after every MCP call and by the cron trigger:
 *   - work repos whose reservation is no longer active (expired, released, cancelled, completed) lose write access;
 *   - revoked repos past retention are deleted.
 */
export async function reconcileWorkspaces(ctx) {
  ctx.store.tx(() => {
    sweepExpired(ctx);
    expireLateIntegrations(ctx);
  });
  const now = ctx.now();
  const toRevoke = ctx.store.all(
    `SELECT w.*, r.state AS reservation_state FROM workspaces w JOIN reservations r ON r.id = w.reservation_id
     WHERE (w.state IN ('requested','ready','integrating','integration_failed','integrated') AND r.state <> 'active')
        OR w.state = 'revoking'
        OR (w.state = 'failed' AND w.revoked_at IS NULL)`,
  );
  const results = [];
  for (const w of toRevoke) {
    ctx.store.exec("UPDATE workspaces SET state = 'revoking', updated_at = ? WHERE id = ?", now, w.id);
    const res = await ctx.provisioner.revoke({ workspace: w, reason: `reservation_${w.reservation_state}` });
    // Expired / released / abandoned work is archived and KEPT for audit (no automatic deletion).
    // Integrated work lives on in the main fork, so its work repo is deleted after retention.
    // Forbidden content already carries delete_after = now.
    const keep = ['expired', 'released'].includes(w.reservation_state) && w.state !== 'failed';
    const deleteAfter = w.delete_after ?? (keep ? null : now + workspacePolicy(ctx.env).retentionMs);
    ctx.store.exec(
      "UPDATE workspaces SET state = 'revoked', revoked_at = ?, delete_after = ?, updated_at = ? WHERE id = ?",
      now, deleteAfter, now, w.id,
    );
    recordEvent(ctx.store, now, 'system', 'workspace.revoked', { workspace_id: w.id, provisioner: res.status });
    results.push({ workspace_id: w.id, action: 'revoked' });
  }
  const toDelete = ctx.store.all("SELECT * FROM workspaces WHERE state = 'revoked' AND delete_after IS NOT NULL AND delete_after <= ?", now);
  for (const w of toDelete) {
    const res = await ctx.provisioner.cleanup({ workspace: w });
    ctx.store.exec("UPDATE workspaces SET state = 'deleted', updated_at = ? WHERE id = ?", now, w.id);
    recordEvent(ctx.store, now, 'system', 'workspace.deleted', { workspace_id: w.id, provisioner: res.status });
    results.push({ workspace_id: w.id, action: 'deleted' });
  }
  return results;
}

export function myWorkspace(ctx, participant) {
  const w = ctx.store.one(
    `SELECT w.* FROM workspaces w JOIN reservations r ON r.id = w.reservation_id
     WHERE w.participant_id = ? AND r.state = 'active' ORDER BY w.created_at DESC LIMIT 1`,
    participant.id,
  );
  return view(ctx, w);
}
