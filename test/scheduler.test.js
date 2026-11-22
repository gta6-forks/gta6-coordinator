import test from 'node:test';
import assert from 'node:assert/strict';
import { claim, listTasks, release, renew, currentReservation } from '../src/services/scheduler.js';
import { syncCatalog } from '../src/services/catalog.js';
import { anon, baseEnv, google, HOUR, setup, task, createNodeStore } from './helpers.js';
import { migrate } from '../src/store/migrations.js';

test('seed: anonymous Windows participant gets #77 first; drafts, needs_info and blocked tasks are never served', async () => {
  const { ctx } = await setup();
  const { participant } = await anon(ctx);
  const eligible = listTasks(ctx, participant).map((t) => t.id);
  assert.ok(eligible.includes('R0Y00/Xbox2Windows#77'));
  for (const id of eligible) assert.ok(!id.startsWith('draft:'), id);
  assert.ok(!eligible.includes('R0Y00/Xbox2Windows#126'), 'needs_info is not served');
  assert.ok(!eligible.includes('ItsNotRexed/Leonida#29'), 'blocked by rpf9-explorer#1');
  assert.ok(!eligible.includes('local:plan/bootstrap-issues'), 'strategic needs Google');
  const all = listTasks(ctx, participant, { include_ineligible: true });
  const leonida = all.find((t) => t.id === 'ItsNotRexed/Leonida#29');
  assert.ok(leonida.ineligible_reasons.includes('blocked_by:breadbbbb/rpf9-explorer#1'));
  const group = all.find((t) => t.id === 'draft:Freminet/ScarlettX/failing-tests');
  assert.ok(group.ineligible_reasons.includes('not_executable_group'));
  const r = claim(ctx, participant, {});
  assert.equal(r.status, 'reserved');
  assert.equal(r.task.id, 'R0Y00/Xbox2Windows#77');
});

test('strategic tasks require Google login', async () => {
  const { ctx } = await setup();
  const a = await anon(ctx);
  assert.throws(() => claim(ctx, a.participant, { task_id: 'local:plan/bootstrap-issues' }), (e) => e.details.reasons.includes('requires_google_login'));
  const g = await google(ctx);
  assert.equal(claim(ctx, g.participant, { task_id: 'local:plan/bootstrap-issues' }).status, 'reserved');
});

test('cross-repo dependency unblocks when the dependency is done or closed upstream', async () => {
  const { ctx } = await setup();
  const g = await google(ctx, { os: ['windows'], gpu_vendor: 'none' });
  assert.throws(() => claim(ctx, g.participant, { task_id: 'ItsNotRexed/Leonida#29' }), /cannot be reserved/);
  ctx.store.exec("UPDATE tasks SET status = 'done' WHERE id = 'breadbbbb/rpf9-explorer#1'");
  assert.equal(claim(ctx, g.participant, { task_id: 'ItsNotRexed/Leonida#29' }).status, 'reserved');
});

test('unknown dependencies keep a task blocked (conservative)', async () => {
  const { ctx } = await setup({ tasks: [task('o/a#1', { depends_on: ['o/missing#9'] })] });
  const { participant } = await anon(ctx);
  assert.equal(claim(ctx, participant, {}).status, 'no_task_available');
});

test('one task at a time; a task cannot be reserved twice', async () => {
  const { ctx } = await setup({ tasks: [task('o/a#1'), task('o/a#2')] });
  const a = await anon(ctx);
  const b = await anon(ctx);
  const ra = claim(ctx, a.participant, { task_id: 'o/a#1' });
  assert.throws(() => claim(ctx, a.participant, {}), /one task at a time/);
  assert.throws(() => claim(ctx, b.participant, { task_id: 'o/a#1' }), (e) => e.details.reasons.includes('reserved'));
  assert.equal(claim(ctx, b.participant, {}).task.id, 'o/a#2');
  assert.equal(ra.reservation.task_id, 'o/a#1');
});

test('the database itself refuses a second active reservation for a task (defence in depth)', async () => {
  const store = createNodeStore();
  migrate(store);
  store.exec("INSERT INTO participants (id, kind, display_name, public_alias, created_at) VALUES ('p1','anonymous','a','a',0), ('p2','anonymous','b','b',0)");
  store.exec("INSERT INTO tasks (id, origin, data_json, status, updated_at) VALUES ('o/a#1','catalog','{}','open',0)");
  store.exec("INSERT INTO reservations (id, task_id, participant_id, state, created_at, expires_at) VALUES ('r1','o/a#1','p1','active',0,1)");
  assert.throws(
    () => store.exec("INSERT INTO reservations (id, task_id, participant_id, state, created_at, expires_at) VALUES ('r2','o/a#1','p2','active',0,1)"),
    /UNIQUE/,
  );
});

test('idempotency: the same key returns the same reservation; reusing it for another op fails', async () => {
  const { ctx } = await setup({ tasks: [task('o/a#1'), task('o/a#2')] });
  const a = await anon(ctx);
  const first = claim(ctx, a.participant, { idempotency_key: 'retry-key-0001' });
  const second = claim(ctx, a.participant, { idempotency_key: 'retry-key-0001' });
  assert.equal(second.reservation.id, first.reservation.id);
  assert.equal(second.idempotent_replay, true);
  assert.throws(() => claim(ctx, a.participant, { task_id: 'o/a#2', idempotency_key: 'retry-key-0001' }), /already used/);
});

test('hard 24h timeout from assignment: no renewal, late results refused, task redistributed', async () => {
  const { ctx, now } = await setup({ tasks: [task('o/a#1')], env: baseEnv({ RESERVATION_TTL_HOURS: '48' }) });
  const a = await anon(ctx);
  const b = await anon(ctx);
  const r = claim(ctx, a.participant, {});
  assert.equal(new Date(r.reservation.expires_at) - new Date(r.reservation.created_at), 24 * HOUR, 'env can never raise it above 24h');
  assert.equal(r.reservation.renewable, false);
  assert.throws(() => renew(ctx, a.participant, r.reservation.id), /hard 24h timeout/);
  now.advance(24 * HOUR - 1);
  assert.equal(claim(ctx, b.participant, {}).status, 'no_task_available');
  now.advance(1);
  assert.throws(() => release(ctx, a.participant, r.reservation.id), /deadline passed/);
  assert.equal(currentReservation(ctx, a.participant).status, 'none');
  assert.equal(claim(ctx, b.participant, {}).status, 'reserved', 'redistributed');
  const state = ctx.store.one('SELECT state FROM reservations WHERE id = ?', r.reservation.id).state;
  assert.equal(state, 'expired');
  assert.ok(ctx.store.one("SELECT 1 AS x FROM events WHERE type = 'reservation.expired'"), 'audit log kept');
});

test('abandonment: no re-claim of a task you let expire (72h); claims paused after 3 expirations in 7 days', async () => {
  const { ctx, now } = await setup({ tasks: [task('o/a#1'), task('o/a#2'), task('o/a#3'), task('o/a#4')] });
  const a = await anon(ctx);
  claim(ctx, a.participant, { task_id: 'o/a#1' });
  now.advance(24 * HOUR);
  assert.throws(() => claim(ctx, a.participant, { task_id: 'o/a#1' }), (e) => e.details.reasons.includes('you_let_this_task_expire_recently'));
  claim(ctx, a.participant, { task_id: 'o/a#2' });
  now.advance(24 * HOUR);
  claim(ctx, a.participant, { task_id: 'o/a#3' });
  now.advance(24 * HOUR);
  assert.throws(() => claim(ctx, a.participant, {}), /paused/);
  now.advance(7 * 24 * HOUR);
  assert.equal(claim(ctx, a.participant, {}).status, 'reserved');
});

test('release frees the task; only the owner can release', async () => {
  const { ctx } = await setup({ tasks: [task('o/a#1')] });
  const a = await anon(ctx);
  const b = await anon(ctx);
  const r = claim(ctx, a.participant, {});
  assert.throws(() => release(ctx, b.participant, r.reservation.id), /no such reservation/);
  release(ctx, a.participant, r.reservation.id, 'sem Windows hoje');
  assert.equal(claim(ctx, b.participant, {}).status, 'reserved');
});

test('profile matching: OS, GPU and own-copy requirements; filters narrow the pool', async () => {
  const req = (kind, value) => ({ kind, value, confidence: 'confirmed' });
  const reqs = (...required) => ({
    implementation: { required, optional: [], suggested: [] },
    validation: { required: [], optional: [], suggested: [] },
  });
  const { ctx } = await setup({
    tasks: [
      task('o/win#1', { requirements: reqs(req('os', ['windows'])) }),
      task('o/amd#2', { requirements: reqs(req('gpu', 'amd')) }),
      task('o/copy#3', { requirements: reqs(req('game_files', 'yes')) }),
      task('o/hard#4', { difficulty: 'high' }),
    ],
  });
  const mac = await anon(ctx, { os: ['macos'], gpu_vendor: 'apple', has_own_game_copy: false });
  const ids = listTasks(ctx, mac.participant).map((t) => t.id);
  assert.deepEqual(ids, ['o/hard#4']);
  const amd = await anon(ctx, { os: ['linux'], gpu_vendor: 'amd', has_own_game_copy: true });
  assert.deepEqual(listTasks(ctx, amd.participant).map((t) => t.id).sort(), ['o/amd#2', 'o/copy#3', 'o/hard#4']);
  assert.deepEqual(listTasks(ctx, amd.participant, { filters: { max_difficulty: 'low' } }).map((t) => t.id).sort(), ['o/amd#2', 'o/copy#3']);
  const noProfile = await anon(ctx, null);
  assert.ok(listTasks(ctx, noProfile.participant, { include_ineligible: true }).find((t) => t.id === 'o/win#1').ineligible_reasons.includes('profile_missing_os'));
});

test('priority then difficulty decides what claim_next_task picks', async () => {
  const { ctx } = await setup({
    tasks: [task('o/a#1', { priority: 'p2' }), task('o/a#2', { priority: 'p0', difficulty: 'high' }), task('o/a#3', { priority: 'p0' })],
  });
  const a = await anon(ctx);
  assert.equal(claim(ctx, a.participant, {}).task.id, 'o/a#3');
});

test('catalog sync skips invalid tasks and dependency cycles', async () => {
  const { ctx } = await setup({ tasks: [] });
  const out = syncCatalog(ctx, [task('o/a#1', { depends_on: ['o/a#2'] }), task('o/a#2', { depends_on: ['o/a#1'] }), { id: 'bad' }, task('o/a#3')], null);
  assert.equal(out.synced, 1);
  assert.equal(out.errors.length, 1);
  assert.equal(out.cycles.length, 1);
});
