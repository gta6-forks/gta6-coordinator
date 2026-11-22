import test from 'node:test';
import assert from 'node:assert/strict';
import { claim } from '../src/services/scheduler.js';
import { reportCi, submitCompletion, submitVerification } from '../src/services/review.js';
import { byModel, byProject, history, leaderboard, recordCommits, reportUsage, summary } from '../src/services/metrics.js';
import { anon, completion, google, HOUR, setup, sha, task, verification } from './helpers.js';

const usage = (o = {}) => ({
  report_id: `rep-${Math.random().toString(36).slice(2, 12)}`,
  task_id: 'R0Y00/Xbox2Windows#77',
  provider: 'anthropic',
  model_id: 'claude-opus-5-5',
  measurement: 'reported_actual',
  input_tokens: 1200,
  output_tokens: 300,
  method: 'client_usage_report',
  source: 'claude code usage counters',
  confidence: 'high',
  ...o,
});

async function acceptedDelivery(s, executor, taskId, n) {
  const r = claim(s.ctx, executor.participant, { task_id: taskId });
  s.now.advance(2 * HOUR);
  const done = submitCompletion(s.ctx, executor.participant, {
    reservation_id: r.reservation.id,
    completion: completion({ commit_sha: sha(n), pr_url: `https://github.com/x/${taskId.split('/')[1].split('#')[0]}/pull/${n}` }),
  });
  for (const slot of [0, 1]) {
    const v = await google(s.ctx);
    const rv = claim(s.ctx, v.participant, { task_id: done.verification_tasks[slot] });
    await submitVerification(s.ctx, v.participant, { reservation_id: rv.reservation.id, verification: verification({ commit_sha: sha(n) }) });
  }
  await reportCi(s.ctx, { commit_sha: sha(n), conclusion: 'success' });
  return done;
}

test('usage reports: actual vs estimated vs unknown are kept distinct and validated', async () => {
  const s = await setup({ tasks: [task('R0Y00/Xbox2Windows#77')] });
  const a = await anon(s.ctx);
  assert.throws(() => reportUsage(s.ctx, a.participant, usage()), /tasks you reserved/);
  claim(s.ctx, a.participant, {});
  assert.equal(reportUsage(s.ctx, a.participant, usage()).stored.total_tokens, 1500);
  assert.throws(() => reportUsage(s.ctx, a.participant, usage({ measurement: 'reported_actual', method: 'heuristic' })), /reported_actual requires/);
  assert.throws(() => reportUsage(s.ctx, a.participant, usage({ measurement: 'unknown', method: 'none', confidence: 'none' })), /must not carry/);
  const est = reportUsage(s.ctx, a.participant, usage({ measurement: 'estimated', method: 'heuristic', confidence: 'high', input_tokens: 10, output_tokens: 10 }));
  assert.equal(est.stored.confidence, 'medium', 'estimates are never high confidence');
  const unk = usage({ measurement: 'unknown', method: 'none', confidence: 'none' });
  delete unk.input_tokens;
  delete unk.output_tokens;
  assert.equal(reportUsage(s.ctx, a.participant, unk).status, 'recorded');
  const dup = usage({ report_id: 'same-key-0001' });
  reportUsage(s.ctx, a.participant, dup);
  assert.equal(reportUsage(s.ctx, a.participant, dup).status, 'duplicate');
  const t = summary(s.ctx, { period: '7d' }).tokens;
  assert.equal(t.reported_actual, 3000);
  assert.equal(t.estimated, 20);
  assert.equal(t.unknown_reports, 1);
  assert.equal(t.verified_by_coordinator, false);
});

test('leaderboard ranks by accepted deliveries, not by raw volume, and exposes only pseudonyms', async () => {
  const s = await setup({ tasks: [task('o/a#1'), task('o/a#2'), task('o/a#3'), task('o/a#4')] });
  const quality = await anon(s.ctx);
  const volume = await anon(s.ctx);
  await acceptedDelivery(s, quality, 'o/a#1', 11);
  // volume: two deliveries, both rejected
  for (const [id, n] of [['o/a#2', 21], ['o/a#3', 22]]) {
    const r = claim(s.ctx, volume.participant, { task_id: id });
    submitCompletion(s.ctx, volume.participant, { reservation_id: r.reservation.id, completion: completion({ commit_sha: sha(n), pr_url: 'https://github.com/x/a/pull/1' }) });
    await reportCi(s.ctx, { commit_sha: sha(n), conclusion: 'failure' });
  }
  const board = leaderboard(s.ctx, { period: '30d' });
  const q = board.find((r) => r.participant === quality.participant.public_alias);
  const v = board.find((r) => r.participant === volume.participant.public_alias);
  assert.equal(q.rank, 1);
  assert.equal(q.accepted, 1);
  assert.equal(v.delivered, 2);
  assert.equal(v.rejected, 2);
  assert.ok(q.rank < v.rank);
  assert.equal(q.median_minutes_to_delivery, 120);
  assert.equal(q.delivered_within_24h_rate, 1);
  assert.equal(q.account, 'anonymous_pseudonym');
  const text = JSON.stringify(board);
  assert.ok(!text.includes('@example.test'), 'no e-mails');
  assert.ok(!/User \d/.test(text), 'no Google names');
  assert.ok(!text.includes(quality.participant.id), 'no internal ids');
  assert.equal(q.commits_pushed, null, 'no webhook data -> unknown, not zero');
});

test('expired reservations lower the within-24h rate; summary, projects, history agree', async () => {
  const s = await setup({ tasks: [task('o/a#1'), task('o/b#2')] });
  const a = await anon(s.ctx);
  claim(s.ctx, a.participant, { task_id: 'o/b#2' });
  s.now.advance(24 * HOUR);
  await acceptedDelivery(s, a, 'o/a#1', 31);
  const sum = summary(s.ctx, { period: '30d' });
  assert.equal(sum.expired, 1);
  assert.equal(sum.delivered, 1);
  assert.equal(sum.accepted, 1);
  assert.equal(sum.delivered_within_24h_rate, 0.5);
  const proj = byProject(s.ctx, { period: '30d' });
  assert.equal(proj.find((p) => p.project === 'o/a').accepted, 1);
  assert.equal(proj.find((p) => p.project === 'o/b').expired, 1);
  const h = history(s.ctx, { days: 7 });
  assert.equal(h.length, 7);
  assert.equal(h.reduce((n, d) => n + d.accepted, 0), 1);
  assert.equal(h.reduce((n, d) => n + d.expired, 0), 1);
});

test('by_model aggregates reported usage and links it to accepted deliveries', async () => {
  const s = await setup({ tasks: [task('R0Y00/Xbox2Windows#77')] });
  const a = await anon(s.ctx);
  await acceptedDelivery(s, a, 'R0Y00/Xbox2Windows#77', 41);
  reportUsage(s.ctx, a.participant, usage({ model_version: '2026-11' }));
  const m = byModel(s.ctx, { period: '30d' });
  assert.equal(m[0].model_id, 'claude-opus-5-5');
  assert.equal(m[0].accepted_deliveries, 1);
  assert.equal(m[0].tokens.reported_actual, 1500);
});

test('commit counts come from deduplicated push webhooks; reciprocal approvals are flagged', async () => {
  const s = await setup({ tasks: [task('o/a#1'), task('o/a#2'), task('o/a#3'), task('o/a#4')] });
  assert.equal(recordCommits(s.ctx, { repo: 'w/x', shas: [sha(1), sha(1), 'bad'], source: 'github_push' }), 1);
  assert.equal(recordCommits(s.ctx, { repo: 'w/x', shas: [sha(1)], source: 'github_push' }), 0);
  const [x, y] = [await google(s.ctx), await google(s.ctx)];
  const deliver = (p, id, n) => {
    const r = claim(s.ctx, p.participant, { task_id: id });
    return submitCompletion(s.ctx, p.participant, { reservation_id: r.reservation.id, completion: completion({ commit_sha: sha(n), pr_url: 'https://github.com/x/a/pull/1' }) });
  };
  const approve = async (p, vt, n) => {
    const r = claim(s.ctx, p.participant, { task_id: vt });
    await submitVerification(s.ctx, p.participant, { reservation_id: r.reservation.id, verification: verification({ commit_sha: sha(n) }) });
  };
  const d1 = deliver(x, 'o/a#1', 51);
  await approve(y, d1.verification_tasks[0], 51);
  const d2 = deliver(x, 'o/a#2', 52);
  await approve(y, d2.verification_tasks[0], 52);
  const d3 = deliver(y, 'o/a#3', 53);
  await approve(x, d3.verification_tasks[0], 53);
  const d4 = deliver(y, 'o/a#4', 54);
  await approve(x, d4.verification_tasks[0], 54);
  const board = leaderboard(s.ctx, { period: '30d' });
  assert.ok(board.find((r) => r.participant === x.participant.public_alias).flags.includes('reciprocal_approvals'));
  assert.equal(summary(s.ctx).commits_pushed, 1);
});
