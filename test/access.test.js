// Access matrix (authentication != authorization):
//   anyone with a token (anonymous included) -> operational work: claim, workspace, submit_completion, usage, metrics
//   authenticated (Google) only              -> strategic work: planning and approval (verification) of contributions
import test from 'node:test';
import assert from 'node:assert/strict';
import { claim, listTasks } from '../src/services/scheduler.js';
import { submitCompletion, submitVerification } from '../src/services/review.js';
import { planningContext } from '../src/services/planning.js';
import { anon, completion, google, setup, task, verification } from './helpers.js';

test('anonymous participants can do operational work end to end', async () => {
  const { ctx } = await setup({ tasks: [task('R0Y00/Xbox2Windows#77')] });
  const a = await anon(ctx);
  assert.ok(listTasks(ctx, a.participant).some((t) => t.id === 'R0Y00/Xbox2Windows#77' && t.claimable !== false));
  const r = claim(ctx, a.participant, { task_id: 'R0Y00/Xbox2Windows#77' });
  assert.equal(r.status, 'reserved');
  const out = submitCompletion(ctx, a.participant, { reservation_id: r.reservation.id, completion: completion() });
  assert.equal(out.status, 'in_review');
  assert.equal(out.verification_tasks.length, 2);
});

test('anonymous participants can never approve (verify) or plan, even naming the task directly', async () => {
  const { ctx } = await setup({ tasks: [task('R0Y00/Xbox2Windows#77')] });
  const exec = await anon(ctx);
  const r = claim(ctx, exec.participant, {});
  const out = submitCompletion(ctx, exec.participant, { reservation_id: r.reservation.id, completion: completion() });
  const other = await anon(ctx);
  for (const id of out.verification_tasks) {
    assert.throws(() => claim(ctx, other.participant, { task_id: id }), (e) => e.details?.reasons?.includes('requires_google_login'));
  }
  await assert.rejects(
    submitVerification(ctx, other.participant, { reservation_id: r.reservation.id, verification: verification() }),
    (e) => e.code === 'requires_google_login',
  );
  assert.throws(() => planningContext(ctx, other.participant), (e) => e.code === 'requires_google_login');
  assert.throws(() => claim(ctx, other.participant, { task_id: 'local:plan/bootstrap-issues' }));

  const g = await google(ctx);
  const v = claim(ctx, g.participant, { task_id: out.verification_tasks[0] });
  assert.equal(v.status, 'reserved');
});
