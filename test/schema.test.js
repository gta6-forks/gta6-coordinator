import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTask, matchesFilters, profileMismatches } from '../src/domain/task.js';
import { SEED } from '../src/generated/seed.js';
import { task } from './helpers.js';

test('every seed task is valid and the ten investigated challenges are present', () => {
  for (const raw of SEED.tasks) {
    const { errors } = normalizeTask(raw);
    assert.deepEqual(errors, [], raw.id);
  }
  const ids = SEED.tasks.map((t) => t.id);
  for (const id of [
    'R0Y00/Xbox2Windows#77',
    'R0Y00/Xbox2Windows#126',
    'draft:ItsNotRexed/Leonida/system-values',
    'ItsNotRexed/Leonida#29',
    'draft:Freminet/ScarlettX/guest-texture-upload',
    'draft:Freminet/ScarlettX/child-process-boot',
    'breadbbbb/rpf9-explorer#1',
    'draft:breadbbbb/rpf9-explorer/bcpack-decoder',
    'draft:realdody/americas-recomp/f16-interpolation',
    'draft:realdody/americas-recomp/xgameruntime-standin',
  ]) assert.ok(ids.includes(id), id);
  const repos = new Set(SEED.tasks.map((t) => t.repo).filter(Boolean));
  assert.equal(repos.size, 5);
});

test('group issues are not executable; subissues need a parent', () => {
  assert.equal(normalizeTask(task('o/r#1', { kind: 'group' })).task.executable, false);
  assert.match(normalizeTask(task('o/r#2', { kind: 'subissue' })).errors.join(), /parent/);
});

test('ids must be repo#issue, draft:… or local:…; repo must match the id', () => {
  assert.ok(normalizeTask(task('not-an-id')).errors.length);
  assert.match(normalizeTask(task('o/r#3', { repo: 'x/y' })).errors.join(), /repo/);
  assert.match(normalizeTask(task('draft:o/r/x', { repo: 'o/r', readiness: 'ready' })).errors.join(), /draft/);
});

test('plan and verify tasks must be strategic', () => {
  assert.match(normalizeTask(task('local:plan/x', { role: 'plan' })).errors.join(), /strategic/);
});

test('requirements carry confidence; unspecified ones are not enforced', () => {
  const t = normalizeTask(
    task('o/r#4', {
      requirements: {
        implementation: {
          required: [
            { kind: 'os', value: ['windows'], confidence: 'confirmed' },
            { kind: 'gpu', value: 'amd', confidence: 'unspecified' },
            { kind: 'game_files', value: 'yes', confidence: 'confirmed' },
          ],
          optional: [],
          suggested: [],
        },
        validation: { required: [], optional: [], suggested: [] },
      },
    }),
  ).task;
  assert.deepEqual(t.filters.os, ['windows']);
  assert.equal(t.filters.gpu, 'unspecified');
  assert.equal(t.filters.needs_game_files.implementation, 'yes');
  assert.deepEqual(profileMismatches(t.requirements.implementation, { os: ['linux'] }), ['requires_os:windows', 'requires_own_game_copy']);
  assert.deepEqual(profileMismatches(t.requirements.implementation, { os: ['windows'], has_own_game_copy: true }), []);
  assert.equal(matchesFilters(t, { os: 'windows', needs_game_files: 'yes' }), true);
  assert.equal(matchesFilters(t, { os: 'macos' }), false);
});
