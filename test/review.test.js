import test from 'node:test';
import assert from 'node:assert/strict';
import { claim, listTasks } from '../src/services/scheduler.js';
import { markMerged, reportCi, submitCompletion, submitVerification } from '../src/services/review.js';
import { getTask } from '../src/services/catalog.js';
import { anon, completion, google, setup, sha, task, verification } from './helpers.js';

async function inReview() {
  const s = await setup({ tasks: [task('R0Y00/Xbox2Windows#77'), task('o/next#2')] });
  const exec = await anon(s.ctx);
  const r = claim(s.ctx, exec.participant, { task_id: 'R0Y00/Xbox2Windows#77' });
  const done = submitCompletion(s.ctx, exec.participant, { reservation_id: r.reservation.id, completion: completion() });
  return { ...s, exec, done };
}

test('completion validation: schema, forbidden game data, PR target repository', async () => {
  const s = await setup({ tasks: [task('R0Y00/Xbox2Windows#77')] });
  const a = await anon(s.ctx);
  const r = claim(s.ctx, a.participant, {});
  const send = (c) => () => submitCompletion(s.ctx, a.participant, { reservation_id: r.reservation.id, completion: c });
  assert.throws(send(completion({ commit_sha: 'abc' })), /schema/);
  assert.throws(send(completion({ game_data_in_deliverables: true })), /schema/);
  assert.throws(send(completion({ deliverables: { code: [], knowledge_md: [], tests: [], artifacts: ['dump/textures.rpf'] } })), /never accepted/);
  assert.throws(send(completion({ deliverables: { code: ['game-files/x.txt'], knowledge_md: [], tests: [], artifacts: [] } })), /never accepted/);
  assert.throws(send(completion({ pr_url: 'https://github.com/x/ScarlettX/pull/1' })), /Xbox2Windows/);
  assert.equal(send(completion())().status, 'in_review');
});

test('completion frees the executor for the next task (continuous mode) and creates two verify tasks', async () => {
  const { ctx, exec, done } = await inReview();
  assert.equal(done.verification_tasks.length, 2);
  assert.equal(getTask(ctx.store, 'R0Y00/Xbox2Windows#77').status, 'in_review');
  assert.equal(claim(ctx, exec.participant, {}).task.id, 'o/next#2');
});

test('verify tasks: Google only, never the executor, never the same person twice', async () => {
  const { ctx, done } = await inReview();
  const anonV = await anon(ctx);
  assert.ok(!listTasks(ctx, anonV.participant).some((t) => t.role === 'verify'));
  const v1 = await google(ctx);
  const r1 = claim(ctx, v1.participant, { task_id: done.verification_tasks[0] });
  await submitVerification(ctx, v1.participant, { reservation_id: r1.reservation.id, verification: verification() });
  assert.throws(() => claim(ctx, v1.participant, { task_id: done.verification_tasks[1] }), (e) => e.details.reasons.includes('verifier_not_independent'));
});

test('executor logged in with Google cannot verify their own delivery', async () => {
  const s = await setup({ tasks: [task('R0Y00/Xbox2Windows#77')] });
  const g = await google(s.ctx);
  const r = claim(s.ctx, g.participant, {});
  const done = submitCompletion(s.ctx, g.participant, { reservation_id: r.reservation.id, completion: completion() });
  assert.throws(() => claim(s.ctx, g.participant, { task_id: done.verification_tasks[0] }), (e) => e.details.reasons.includes('verifier_is_executor'));
});

test('verification must target exactly the reviewed commit', async () => {
  const { ctx, done } = await inReview();
  const v1 = await google(ctx);
  const r1 = claim(ctx, v1.participant, { task_id: done.verification_tasks[0] });
  await assert.rejects(submitVerification(ctx, v1.participant, { reservation_id: r1.reservation.id, verification: verification({ commit_sha: sha(2) }) }), /verify exactly/);
});

test('two approvals + CI success -> ready_to_merge with a pending merge intent (no merge happens)', async () => {
  const { ctx, done } = await inReview();
  const [v1, v2] = [await google(ctx), await google(ctx)];
  const r1 = claim(ctx, v1.participant, { task_id: done.verification_tasks[0] });
  const a1 = await submitVerification(ctx, v1.participant, { reservation_id: r1.reservation.id, verification: verification() });
  assert.equal(a1.status, 'verifying');
  const r2 = claim(ctx, v2.participant, { task_id: done.verification_tasks[1] });
  const a2 = await submitVerification(ctx, v2.participant, { reservation_id: r2.reservation.id, verification: verification() });
  assert.equal(a2.status, 'awaiting_ci');
  const ci = await reportCi(ctx, { commit_sha: sha(1), conclusion: 'success' });
  assert.equal(ci.merges[0].status, 'pending_decision');
  assert.equal(ci.merges[0].credentials_issued, false);
  assert.equal(ctx.store.one('SELECT state FROM reviews WHERE id = ?', done.review_id).state, 'ready_to_merge');
  assert.equal(getTask(ctx.store, 'R0Y00/Xbox2Windows#77').status, 'approved');
  markMerged(ctx, { pr_url: completion().pr_url, commit_sha: sha(1) });
  assert.equal(getTask(ctx.store, 'R0Y00/Xbox2Windows#77').status, 'done');
});

test('CI success before the verifications still requires both approvals', async () => {
  const { ctx, done } = await inReview();
  await reportCi(ctx, { commit_sha: sha(1), conclusion: 'success' });
  const [v1, v2] = [await google(ctx), await google(ctx)];
  const r1 = claim(ctx, v1.participant, { task_id: done.verification_tasks[0] });
  await submitVerification(ctx, v1.participant, { reservation_id: r1.reservation.id, verification: verification() });
  assert.equal(ctx.store.one('SELECT state FROM reviews WHERE id = ?', done.review_id).state, 'verifying');
  const r2 = claim(ctx, v2.participant, { task_id: done.verification_tasks[1] });
  const out = await submitVerification(ctx, v2.participant, { reservation_id: r2.reservation.id, verification: verification() });
  assert.equal(out.status, 'ready_to_merge');
  assert.equal(out.merge.status, 'pending_decision');
});

test('a rejection stops handing out the other slot, marks the task needs_replan and feeds a planner task', async () => {
  const { ctx, done } = await inReview();
  const [v1, v2, planner] = [await google(ctx), await google(ctx), await google(ctx)];
  const r2 = claim(ctx, v2.participant, { task_id: done.verification_tasks[1] });
  const r1 = claim(ctx, v1.participant, { task_id: done.verification_tasks[0] });
  const out = await submitVerification(ctx, v1.participant, {
    reservation_id: r1.reservation.id,
    verification: verification({ verdict: 'reject', feedback_md: 'O teste novo não falha antes da correção.' }),
  });
  assert.equal(out.status, 'changes_requested');
  assert.equal(getTask(ctx.store, done.verification_tasks[1]).status, 'cancelled');
  assert.equal(ctx.store.one('SELECT state FROM reservations WHERE id = ?', r2.reservation.id).state, 'active', 'work in progress is not thrown away');
  assert.equal(getTask(ctx.store, 'R0Y00/Xbox2Windows#77').status, 'needs_replan');
  const plan = getTask(ctx.store, out.replan_task);
  assert.match(plan.data.instructions_md, /não falha antes/);
  const anonP = await anon(ctx);
  assert.throws(() => claim(ctx, anonP.participant, { task_id: out.replan_task }), /cannot be reserved/);
  assert.equal(claim(ctx, planner.participant, { task_id: out.replan_task }).status, 'reserved');
  const late = await submitVerification(ctx, v2.participant, {
    reservation_id: r2.reservation.id,
    verification: verification({ verdict: 'reject', feedback_md: 'Second reviewer: also missing a regression test.' }),
  });
  assert.equal(late.status, 'recorded_as_feedback');
  assert.match(getTask(ctx.store, out.replan_task).data.instructions_md, /Second reviewer/);
  assert.equal(ctx.store.one('SELECT state FROM reservations WHERE id = ?', r2.reservation.id).state, 'completed');
});

test('CI failure also sends the delivery back to planning', async () => {
  const { ctx, done } = await inReview();
  await reportCi(ctx, { commit_sha: sha(1), conclusion: 'failure', details_url: 'https://ci.example/run/1' });
  assert.equal(ctx.store.one('SELECT state FROM reviews WHERE id = ?', done.review_id).state, 'changes_requested');
  assert.ok(getTask(ctx.store, `local:plan/replan/${done.review_id}`));
});

test('planning tasks must reference a validated proposal and target the coordinator repository', async () => {
  const s = await setup();
  const g = await google(s.ctx);
  const r = claim(s.ctx, g.participant, { task_id: 'local:plan/bootstrap-issues' });
  const c = completion({ pr_url: 'https://github.com/gta6/coordinator/pull/3', deliverables: { code: [], knowledge_md: [], tests: [], artifacts: ['planning/proposals/x.json'] } });
  assert.throws(() => submitCompletion(s.ctx, g.participant, { reservation_id: r.reservation.id, completion: c }), /planning_proposal_id/);
  assert.throws(
    () => submitCompletion(s.ctx, g.participant, { reservation_id: r.reservation.id, completion: { ...c, planning_proposal_id: 'missing' } }),
    /passed validation/,
  );
});

test('CI is read from GitHub check runs: two approvals + green checks -> ready_to_merge', async () => {
  const { refreshCi } = await import('../src/services/ci-sync.js');
  const { ctx, done } = await inReview();
  const review = ctx.store.one('SELECT * FROM reviews WHERE id = ?', done.review_id);
  ctx.planner = { checkRuns: async (repo, sha) => (sha === review.commit_sha ? [{ status: 'completed', conclusion: 'success' }] : []) };
  for (const [i, id] of done.verification_tasks.entries()) {
    const v = await google(ctx);
    const r = claim(ctx, v.participant, { task_id: id });
    await submitVerification(ctx, v.participant, { reservation_id: r.reservation.id, verification: verification() });
    if (i === 0) assert.equal(ctx.store.one('SELECT state FROM reviews WHERE id = ?', done.review_id).state, 'verifying');
  }
  assert.equal(ctx.store.one('SELECT state FROM reviews WHERE id = ?', done.review_id).state, 'awaiting_ci');
  const out = await refreshCi(ctx, { force: true });
  assert.deepEqual(out.map((o) => o.conclusion), ['success']);
  assert.equal(ctx.store.one('SELECT state FROM reviews WHERE id = ?', done.review_id).state, 'ready_to_merge');
});

test('once the re-planning task is approved and merged, the task that needed it is settled', async () => {
  const { settleReplanned } = await import('../src/services/catalog.js');
  const { ctx, done } = await inReview();
  const v = await google(ctx);
  const r = claim(ctx, v.participant, { task_id: done.verification_tasks[0] });
  const out = await submitVerification(ctx, v.participant, { reservation_id: r.reservation.id, verification: verification({ verdict: 'reject', feedback_md: 'needs work' }) });
  assert.equal(getTask(ctx.store, 'R0Y00/Xbox2Windows#77').status, 'needs_replan');
  assert.equal(settleReplanned(ctx), 0, 'nothing to settle while the re-planning is open');
  ctx.store.exec("UPDATE tasks SET status = 'done' WHERE id = ?", out.replan_task);
  assert.equal(settleReplanned(ctx), 1);
  assert.equal(getTask(ctx.store, 'R0Y00/Xbox2Windows#77').status, 'open', 'an operational task goes back to the queue');
});
