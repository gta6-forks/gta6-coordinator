// Completion → two independent verifications of the SAME commit → CI → controlled merge intent.
// Any rejection (or CI failure) sends feedback to a planner through a new strategic `plan` task.
import { AppError, randomHexId, randomId } from '../util.js';
import { validate } from '../schema/validate.js';
import { completionSchema, verificationSchema } from '../schema/schemas.js';
import { normalizeTask } from '../domain/task.js';
import { recordEvent } from '../store/store.js';
import { getTask } from './catalog.js';
import { idempotent, ownedActive, sweepExpired } from './scheduler.js';
import { beginIntegration } from './workspace.js';

// Never accepted as deliverables: game archives, executables, packages, extracted assets, shaders in any form.
const FORBIDDEN_EXT = /\.(rpf|ysc|ytd|ydr|yft|ydd|ybn|ymap|ytyp|awc|ttpf|xvd|xvc|msixvc|exe|dll|pdb|dxbc|fssm|spv|dds|bk2|r9texdata|r9modeldata)$/i;
const FORBIDDEN_NAME = /(^|\/)(MicrosoftGame\.Config|appxmanifest\.xml|game-files\/|export_peds\/)/i;

export function forbiddenDeliverables(deliverables) {
  const all = [...deliverables.code, ...deliverables.knowledge_md, ...deliverables.tests, ...deliverables.artifacts];
  return all.filter((p) => FORBIDDEN_EXT.test(p) || FORBIDDEN_NAME.test(p) || p.includes('..'));
}

function prRepo(prUrl) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+$/.exec(prUrl);
  return m ? { owner: m[1], name: m[2] } : null;
}

function checkPrTarget(ctx, task, prUrl) {
  const pr = prRepo(prUrl);
  if (task.data.role === 'plan') {
    const coord = ctx.env.COORDINATOR_REPO;
    if (coord && `${pr.owner}/${pr.name}` !== coord) {
      throw new AppError('pr_wrong_repo', `planning PRs go to ${coord}`, 400);
    }
    return;
  }
  const want = (task.data.fork_repo ?? task.data.repo ?? '').split('/')[1];
  if (want && pr.name !== want) throw new AppError('pr_wrong_repo', `PR must target a ${want} fork or upstream`, 400);
}

function insertGeneratedTask(ctx, raw) {
  const { task, errors } = normalizeTask(raw);
  if (!task) throw new AppError('generated_task_invalid', 'internal: generated task failed validation', 500, { errors });
  ctx.store.exec(
    `INSERT INTO tasks (id, origin, data_json, status, updated_at) VALUES (?, 'coordinator', ?, 'open', ?)
     ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, status = 'open', updated_at = excluded.updated_at`,
    task.id, JSON.stringify(task), ctx.now(),
  );
  return task;
}

function verifyTaskFor(review, target, slot) {
  const d = target.data;
  const short = review.commit_sha.slice(0, 7);
  return {
    id: `local:verify/${review.id}/${slot}`,
    repo: d.repo ?? null,
    fork_repo: d.fork_repo ?? null,
    github_kind: null,
    url: review.pr_url,
    title: `Review ${target.id} @ ${short} (${slot}/2)`,
    kind: 'issue',
    parent: null,
    type: 'strategic',
    role: 'verify',
    difficulty: d.difficulty,
    difficulty_source: 'estimate',
    priority: d.priority,
    readiness: 'ready',
    state: 'open',
    milestone: d.milestone ?? null,
    depends_on: [],
    instructions_md: [
      `# Independent review ${slot}/2`,
      '',
      `- Task: \`${target.id}\` — ${d.title}`,
      `- PR: ${review.pr_url}`,
      `- Commit to review (exactly this one): \`${review.commit_sha}\``,
      '',
      'Check out that commit, run the task validation commands and check every acceptance criterion.',
      'Do not take the executor report as proof: reproduce it. Report with `submit_verification`.',
      '',
      '## Acceptance criteria of the original task',
      ...d.acceptance.map((a) => `- [${a.confidence}] ${a.text}`),
    ].join('\n'),
    requirements: { implementation: structuredClone(d.requirements.validation), validation: structuredClone(d.requirements.validation) },
    acceptance: d.acceptance,
    deliverables: ['verification_report'],
    sources: [{ kind: 'coordinator', ref: `review:${review.id}` }],
    restrictions: d.restrictions ?? [],
    review: {
      review_id: review.id,
      target_task_id: target.id,
      slot,
      commit_sha: review.commit_sha,
      pr_url: review.pr_url,
      executor_id: review.executor_id,
    },
  };
}

function replanTaskFor(review, target, feedback) {
  return {
    id: `local:plan/replan/${review.id}`,
    repo: target.data.repo ?? null,
    fork_repo: null,
    github_kind: null,
    url: review.pr_url,
    title: `Re-plan ${target.id} after a failed review`,
    kind: 'issue',
    parent: null,
    type: 'strategic',
    role: 'plan',
    difficulty: 'medium',
    difficulty_source: 'estimate',
    priority: target.data.priority,
    readiness: 'ready',
    state: 'open',
    milestone: target.data.milestone ?? null,
    depends_on: [],
    instructions_md: [
      `# Re-planning \`${target.id}\``,
      '',
      `The delivery ${review.pr_url} (commit \`${review.commit_sha}\`) was not approved.`,
      '',
      '## Feedback',
      ...feedback.map((f) => `### ${f.from}\n\n${f.text}`),
      '',
      'Use `get_planning_context`, write a proposal (`validate_planning_proposal`) that adjusts, splits or',
      'replaces the task, and open the planning PR in the coordinator repository.',
    ].join('\n'),
    requirements: {
      implementation: { required: [], optional: [], suggested: [] },
      validation: { required: [], optional: [], suggested: [] },
    },
    acceptance: [
      { text: 'Proposal valid against schemas/planning-proposal.schema.json, opened as a PR in the coordinator repository.', source: 'docs/SPEC.md#planejamento', confidence: 'confirmed' },
    ],
    deliverables: ['planning_proposal'],
    sources: [{ kind: 'coordinator', ref: `review:${review.id}` }],
  };
}

export function createVerificationTasks(ctx, review, task) {
  return [1, 2].map((s) => insertGeneratedTask(ctx, verifyTaskFor(review, task, s)).id);
}

export function submitCompletion(ctx, participant, { reservation_id, completion, idempotency_key = null }) {
  return ctx.store.tx(() => {
    sweepExpired(ctx);
    return idempotent(ctx, participant, idempotency_key, `complete:${reservation_id}`, () => {
      const r = ownedActive(ctx, participant, reservation_id);
      const task = getTask(ctx.store, r.task_id);
      if (task.data.role === 'verify') throw new AppError('wrong_tool', 'use submit_verification for verify tasks', 400);
      const errors = validate(completionSchema, completion);
      if (errors.length) throw new AppError('invalid_completion', 'completion does not match schema', 400, { errors });
      const forbidden = forbiddenDeliverables(completion.deliverables);
      if (forbidden.length) throw new AppError('forbidden_deliverables', 'game data / binaries are never accepted', 400, { paths: forbidden });
      if (task.data.role === 'plan' && !completion.planning_proposal_id) {
        throw new AppError('invalid_completion', 'planning tasks must reference planning_proposal_id', 400);
      }
      if (task.data.role === 'plan') {
        const prop = ctx.store.one('SELECT validation_json FROM proposals WHERE id = ?', completion.planning_proposal_id);
        if (!prop || !JSON.parse(prop.validation_json).valid) {
          throw new AppError('invalid_completion', 'planning_proposal_id must reference a proposal that passed validation', 400);
        }
      }
      if (!completion.workspace_id && !completion.pr_url) {
        throw new AppError('invalid_completion', 'give workspace_id (work repository) or pr_url', 400);
      }
      if (completion.pr_url) checkPrTarget(ctx, task, completion.pr_url);

      const now = ctx.now();
      const completionId = randomId('cmp_');
      const reviewId = randomHexId('rev_');
      ctx.store.exec(
        'INSERT INTO completions (id, task_id, reservation_id, participant_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        completionId, task.id, r.id, participant.id, JSON.stringify(completion), now,
      );
      ctx.store.exec("UPDATE tasks SET status = 'in_review', updated_at = ? WHERE id = ?", now, task.id);
      const headRepo = completion.workspace_id
        ? ctx.store.one('SELECT repo_full_name FROM workspaces WHERE id = ?', completion.workspace_id)?.repo_full_name
        : completion.pr_url.split('/').slice(3, 5).join('/');
      if (headRepo) {
        ctx.store.exec(
          "INSERT OR IGNORE INTO commits (repo, sha, participant_id, task_id, source, at) VALUES (?, ?, ?, ?, 'completion_head', ?)",
          headRepo, completion.commit_sha, participant.id, task.id, now,
        );
      }
      if (completion.workspace_id) {
        // Work-repository path: the reservation stays active (and write access stays open) until the trusted
        // integration job copies the commit to the task branch of the main fork and opens the PR.
        const workspaceId = beginIntegration(ctx, participant, r, completion);
        ctx.store.exec(
          `INSERT INTO reviews (id, task_id, completion_id, executor_id, commit_sha, pr_url, workspace_id, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, 'integrating', ?, ?)`,
          reviewId, task.id, completionId, participant.id, completion.commit_sha, workspaceId, now, now,
        );
        recordEvent(ctx.store, now, participant.id, 'completion.submitted', { completion_id: completionId, review_id: reviewId, task_id: task.id, workspace_id: workspaceId });
        return { status: 'integrating', completion_id: completionId, review_id: reviewId, workspace_id: workspaceId };
      }
      ctx.store.exec("UPDATE reservations SET state = 'completed', closed_at = ? WHERE id = ?", now, r.id);
      ctx.store.exec(
        `INSERT INTO reviews (id, task_id, completion_id, executor_id, commit_sha, pr_url, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'verifying', ?, ?)`,
        reviewId, task.id, completionId, participant.id, completion.commit_sha, completion.pr_url, now, now,
      );
      const review = ctx.store.one('SELECT * FROM reviews WHERE id = ?', reviewId);
      const slots = createVerificationTasks(ctx, review, task);
      recordEvent(ctx.store, now, participant.id, 'completion.submitted', { completion_id: completionId, review_id: reviewId, task_id: task.id });
      return { status: 'in_review', completion_id: completionId, review_id: reviewId, verification_tasks: slots };
    });
  });
}

function rejectReview(ctx, review, feedback) {
  const now = ctx.now();
  ctx.store.exec("UPDATE reviews SET state = 'changes_requested', updated_at = ? WHERE id = ?", now, review.id);
  for (const s of [1, 2]) {
    const vid = `local:verify/${review.id}/${s}`;
    const vt = getTask(ctx.store, vid);
    if (vt && vt.status === 'open') {
      ctx.store.exec("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?", now, vid);
      ctx.store.exec("UPDATE reservations SET state = 'cancelled', closed_at = ? WHERE task_id = ? AND state = 'active'", now, vid);
    }
  }
  ctx.store.exec("UPDATE tasks SET status = 'needs_replan', updated_at = ? WHERE id = ?", now, review.task_id);
  const target = getTask(ctx.store, review.task_id);
  const plan = insertGeneratedTask(ctx, replanTaskFor(review, target, feedback));
  recordEvent(ctx.store, now, 'system', 'review.changes_requested', { review_id: review.id, replan_task: plan.id });
  return plan.id;
}

function approveIfComplete(ctx, review) {
  const approvals = ctx.store.one("SELECT COUNT(*) AS n FROM verifications WHERE review_id = ? AND verdict = 'approve'", review.id).n;
  if (approvals < 2) return 'verifying';
  const now = ctx.now();
  const next = review.ci_conclusion === 'success' ? 'ready_to_merge' : 'awaiting_ci';
  ctx.store.exec('UPDATE reviews SET state = ?, updated_at = ? WHERE id = ?', next, now, review.id);
  if (next === 'ready_to_merge') ctx.store.exec("UPDATE tasks SET status = 'approved', updated_at = ? WHERE id = ?", now, review.task_id);
  recordEvent(ctx.store, now, 'system', `review.${next}`, { review_id: review.id });
  return next;
}

async function requestMergeIfReady(ctx, reviewId) {
  const review = ctx.store.one('SELECT * FROM reviews WHERE id = ?', reviewId);
  if (review.state !== 'ready_to_merge') return null;
  if (ctx.store.one('SELECT 1 AS x FROM merge_intents WHERE review_id = ?', reviewId)) return null;
  const response = await ctx.gitWrite.requestMerge({ review });
  ctx.store.exec(
    'INSERT OR IGNORE INTO merge_intents (id, review_id, status, adapter_response_json, created_at) VALUES (?, ?, ?, ?, ?)',
    randomId('mrg_'), reviewId, response.status, JSON.stringify(response), ctx.now(),
  );
  return response;
}

export async function submitVerification(ctx, participant, { reservation_id, verification, idempotency_key = null }) {
  const result = ctx.store.tx(() => {
    sweepExpired(ctx);
    return idempotent(ctx, participant, idempotency_key, `verify:${reservation_id}`, () => {
      if (participant.kind !== 'google') throw new AppError('requires_google_login', 'verification is a strategic task', 403);
      const r = ownedActive(ctx, participant, reservation_id);
      const task = getTask(ctx.store, r.task_id);
      if (task.data.role !== 'verify') throw new AppError('wrong_tool', 'use submit_completion for this task', 400);
      const errors = validate(verificationSchema, verification);
      if (errors.length) throw new AppError('invalid_verification', 'verification does not match schema', 400, { errors });
      const { review_id: reviewId, slot } = task.data.review;
      const review = ctx.store.one('SELECT * FROM reviews WHERE id = ?', reviewId);
      if (!review || review.state !== 'verifying') throw new AppError('review_not_open', `review is ${review?.state ?? 'missing'}`, 409);
      if (verification.commit_sha !== review.commit_sha) {
        throw new AppError('commit_mismatch', `verify exactly ${review.commit_sha}; a new commit needs a new completion`, 409);
      }
      if (review.executor_id === participant.id) throw new AppError('verifier_not_independent', 'executor cannot verify', 403);
      const now = ctx.now();
      try {
        ctx.store.exec(
          'INSERT INTO verifications (id, review_id, slot, verifier_id, verdict, commit_sha, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          randomId('ver_'), reviewId, slot, participant.id, verification.verdict, verification.commit_sha, JSON.stringify(verification), now,
        );
      } catch (err) {
        if (/UNIQUE/i.test(String(err.message))) throw new AppError('verifier_not_independent', 'one verifier per review, one verdict per slot', 409);
        throw err;
      }
      ctx.store.exec("UPDATE reservations SET state = 'completed', closed_at = ? WHERE id = ?", now, r.id);
      ctx.store.exec("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?", now, task.id);
      recordEvent(ctx.store, now, participant.id, 'verification.submitted', { review_id: reviewId, slot, verdict: verification.verdict });
      if (verification.verdict === 'reject') {
        const planTask = rejectReview(ctx, review, [{ from: `Review ${slot}`, text: verification.feedback_md }]);
        return { status: 'changes_requested', review_id: reviewId, replan_task: planTask };
      }
      return { status: approveIfComplete(ctx, review), review_id: reviewId };
    });
  });
  const merge = await requestMergeIfReady(ctx, result.review_id);
  return merge ? { ...result, merge } : result;
}

/** Called by the CI webhook (shared secret). conclusion: success | failure. */
export async function reportCi(ctx, { commit_sha, conclusion, details_url = null }) {
  if (!/^[0-9a-f]{40}$/.test(commit_sha ?? '')) throw new AppError('invalid_ci_report', 'commit_sha required', 400);
  if (!['success', 'failure'].includes(conclusion)) throw new AppError('invalid_ci_report', 'conclusion must be success|failure', 400);
  const touched = ctx.store.tx(() => {
    const reviews = ctx.store.all("SELECT * FROM reviews WHERE commit_sha = ? AND state IN ('verifying','awaiting_ci')", commit_sha);
    const now = ctx.now();
    for (const review of reviews) {
      ctx.store.exec('UPDATE reviews SET ci_conclusion = ?, updated_at = ? WHERE id = ?', conclusion, now, review.id);
      if (conclusion === 'failure') {
        rejectReview(ctx, review, [{ from: 'CI', text: `CI falhou para \`${commit_sha}\`${details_url ? `: ${details_url}` : ''}.` }]);
      } else if (review.state === 'awaiting_ci') {
        ctx.store.exec("UPDATE reviews SET state = 'ready_to_merge', updated_at = ? WHERE id = ?", now, review.id);
        ctx.store.exec("UPDATE tasks SET status = 'approved', updated_at = ? WHERE id = ?", now, review.task_id);
      }
    }
    recordEvent(ctx.store, now, 'ci', 'ci.reported', { commit_sha, conclusion, reviews: reviews.map((r) => r.id) });
    return reviews.map((r) => r.id);
  });
  const merges = [];
  for (const id of touched) {
    const m = await requestMergeIfReady(ctx, id);
    if (m) merges.push(m);
  }
  return { status: 'recorded', reviews: touched, merges };
}

/** Called by the merge webhook once a PR is actually merged (by whatever merge executor gets decided). */
export function markMerged(ctx, { pr_url, commit_sha }) {
  return ctx.store.tx(() => {
    const review = ctx.store.one("SELECT * FROM reviews WHERE pr_url = ? AND commit_sha = ? AND state = 'ready_to_merge'", pr_url, commit_sha);
    if (!review) throw new AppError('review_not_ready', 'no ready_to_merge review for that PR and commit', 409);
    const now = ctx.now();
    ctx.store.exec("UPDATE reviews SET state = 'merged', updated_at = ? WHERE id = ?", now, review.id);
    ctx.store.exec("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?", now, review.task_id);
    recordEvent(ctx.store, now, 'ci', 'review.merged', { review_id: review.id });
    return { status: 'merged', review_id: review.id, task_id: review.task_id };
  });
}
