import test from 'node:test';
import assert from 'node:assert/strict';
import { ciConclusion, refreshCi } from '../src/services/ci-sync.js';

test('ci conclusion from GitHub check runs', () => {
  assert.equal(ciConclusion([]), null);
  assert.equal(ciConclusion([{ status: 'in_progress' }, { status: 'completed', conclusion: 'success' }]), null);
  assert.equal(ciConclusion([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }]), 'success');
  assert.equal(ciConclusion([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }]), 'failure');
});

test('refreshCi is a no-op without a GitHub planner', async () => {
  assert.deepEqual(await refreshCi({ planner: null }), []);
});
