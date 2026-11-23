// GET /api/tasks: optional `status` filter (comma-separated) and `counts` by status (computed before filtering).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { filterCatalog, TASK_STATUSES } from '../src/services/scheduler.js';
import { baseEnv, clock, createNodeStore } from './helpers.js';

const sample = [
  { id: 'a', status: 'open' },
  { id: 'b', status: 'open' },
  { id: 'c', status: 'cancelled' },
  { id: 'd', status: 'done' },
  { id: 'e', status: 'in_review' },
];

test('TASK_STATUSES matches the statuses the store accepts', () => {
  assert.deepEqual(TASK_STATUSES, ['open', 'in_review', 'needs_replan', 'approved', 'done', 'cancelled']);
});

test('no status parameter: every task, counts by status', () => {
  const out = filterCatalog(sample, null);
  assert.equal(out.tasks.length, 5);
  assert.deepEqual(out.counts, { open: 2, in_review: 1, needs_replan: 0, approved: 0, done: 1, cancelled: 1 });
});

test('one status and several statuses (spaces and repeats tolerated)', () => {
  assert.deepEqual(filterCatalog(sample, 'open').tasks.map((t) => t.id), ['a', 'b']);
  assert.deepEqual(filterCatalog(sample, 'open, in_review,open').tasks.map((t) => t.id), ['a', 'b', 'e']);
});

test('counts are computed before filtering', () => {
  assert.equal(filterCatalog(sample, 'done').counts.open, 2);
});

test('unknown status (including the readiness value "ready") is a 400 naming invalid and accepted values', () => {
  for (const bad of ['ready', 'open,ready', 'OPEN', '', ',']) {
    assert.throws(() => filterCatalog(sample, bad), (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'invalid_status_filter');
      assert.deepEqual(err.details.accepted, TASK_STATUSES);
      assert.ok(Array.isArray(err.details.invalid) && err.details.invalid.length >= 1);
      return true;
    });
  }
});

test('HTTP: /api/tasks keeps its shape, adds counts, filters and rejects unknown statuses', async () => {
  const app = createApp({ store: createNodeStore(), env: baseEnv(), now: clock() });
  await app.ensureSeeded();
  const get = async (q) => app.handle(new Request(`https://coord.example/api/tasks${q}`));
  const all = await (await get('')).json();
  assert.ok(all.tasks.length >= 12);
  assert.ok(all.reservation_policy);
  assert.equal(Object.values(all.counts).reduce((a, b) => a + b, 0), all.tasks.length);
  const open = await (await get('?status=open')).json();
  assert.ok(open.tasks.length > 0 && open.tasks.every((t) => t.status === 'open'));
  assert.deepEqual(open.counts, all.counts);
  const bad = await get('?status=ready');
  assert.equal(bad.status, 400);
  const body = await bad.json();
  assert.equal(body.error.code, 'invalid_status_filter');
  assert.deepEqual(body.error.details.invalid, ['ready']);
});
