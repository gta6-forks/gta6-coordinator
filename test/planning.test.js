import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planningContext, submitProposal, validateProposal, catalogSnapshot } from '../src/services/planning.js';
import { run as runAction } from '../tools/validate-planning.mjs';
import { anon, google, setup } from './helpers.js';

const base = (operations) => ({
  schema_version: 1,
  id: 'bootstrap-1',
  rationale_md: 'Transformar rascunhos em issues.',
  based_on: { roadmap_version: 1, snapshot_at: '2026-11-21T12:00:00Z' },
  operations,
});

const newIssue = {
  op: 'create_issue',
  ref: 'new:guest-texture',
  repo: 'Freminet/ScarlettX',
  replaces_draft: 'draft:Freminet/ScarlettX/guest-texture-upload',
  title: 'Upload de textura do guest atrasado um frame',
  body_md: 'Ver README linha 86.',
  task: {
    kind: 'issue',
    type: 'operational',
    role: 'execute',
    difficulty: 'medium',
    priority: 'p1',
    instructions_md: 'Corrigir o upload.',
    requirements: { implementation: { required: [], optional: [], suggested: [] }, validation: { required: [], optional: [], suggested: [] } },
    acceptance: [{ text: 'test_d3d12_guest_texture passa', confidence: 'confirmed' }],
    deliverables: ['code', 'tests'],
  },
};

test('a well-formed proposal against the seed catalog is valid', async () => {
  const { ctx } = await setup();
  const r = validateProposal(
    base([newIssue, { op: 'set_priority', id: 'R0Y00/Xbox2Windows#126', priority: 'p1' }, { op: 'add_dependency', id: 'new:guest-texture', depends_on: 'R0Y00/Xbox2Windows#77' }]),
    catalogSnapshot(ctx.store),
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid, true);
  assert.equal(r.requires_human_authorization, false);
});

test('unknown ids, cycles, sub-issues under executable parents and draft->ready shortcuts are rejected', async () => {
  const { ctx } = await setup();
  const snap = catalogSnapshot(ctx.store);
  assert.match(validateProposal(base([{ op: 'close_issue', id: 'o/none#1', reason: 'x' }]), snap).errors.join(), /unknown/);
  assert.match(
    validateProposal(base([{ op: 'add_dependency', id: 'breadbbbb/rpf9-explorer#1', depends_on: 'ItsNotRexed/Leonida#29' }]), snap).errors.join(),
    /cycle/,
  );
  assert.match(
    validateProposal(base([{ op: 'add_subissue', parent: 'R0Y00/Xbox2Windows#77', child: 'R0Y00/Xbox2Windows#126' }]), snap).errors.join(),
    /grouping/,
  );
  assert.match(
    validateProposal(base([{ op: 'set_readiness', id: 'draft:ItsNotRexed/Leonida/system-values', readiness: 'ready' }]), snap).errors.join(),
    /replaces_draft/,
  );
  assert.match(validateProposal(base([{ op: 'nuke' }]), snap).errors.join(), /unknown value/);
});

test('touching the protected objective requires human authorization', async () => {
  const { ctx } = await setup();
  const snap = catalogSnapshot(ctx.store);
  assert.equal(validateProposal(base([{ op: 'set_objective', text_md: 'novo objetivo' }]), snap).requires_human_authorization, true);
  assert.equal(validateProposal(base([{ op: 'roadmap_change', milestone: 'objective', change_md: 'x' }]), snap).requires_human_authorization, true);
  assert.equal(validateProposal(base([{ op: 'roadmap_change', milestone: 'M2-shaders', change_md: 'x' }]), snap).requires_human_authorization, false);
});

test('only Google participants can plan; valid proposals are stored with PR instructions', async () => {
  const { ctx } = await setup();
  const a = await anon(ctx);
  assert.throws(() => submitProposal(ctx, a.participant, base([newIssue])), /Google/);
  assert.throws(() => planningContext(ctx, a.participant), /Google/);
  const g = await google(ctx);
  const out = submitProposal(ctx, g.participant, base([newIssue]));
  assert.equal(out.proposal_id, 'bootstrap-1');
  assert.equal(out.pr_instructions.path, 'planning/proposals/bootstrap-1.json');
  const context = planningContext(ctx, g.participant);
  assert.ok(context.roadmap.objective.protected);
  assert.ok(context.tasks.length >= 12);
});

test('GitHub Action script: validates, enforces 2 verifications and human gate, and never applies (pending)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'planning-'));
  const good = join(dir, 'good.json');
  const human = join(dir, 'human.json');
  const bad = join(dir, 'bad.json');
  writeFileSync(good, JSON.stringify(base([newIssue])));
  writeFileSync(human, JSON.stringify(base([{ op: 'set_objective', text_md: 'x' }])));
  writeFileSync(bad, '{"schema_version":1}');
  const logs = [];
  const log = (l) => logs.push(l);
  assert.equal(await runAction([good], {}, log), 0);
  assert.equal(await runAction([bad], {}, log), 1);
  assert.equal(await runAction(['--apply', good], { PLANNING_VERIFICATIONS: '1' }, log), 1);
  assert.equal(await runAction(['--apply', human], { PLANNING_VERIFICATIONS: '2' }, log), 1);
  assert.equal(await runAction(['--apply', human], { PLANNING_VERIFICATIONS: '2', PLANNING_HUMAN_APPROVED: 'true' }, log), 0);
  assert.equal(await runAction(['--apply', good], { PLANNING_VERIFICATIONS: '2' }, log), 0);
  assert.ok(logs.some((l) => /apply -> pending_decision/.test(l)));
});

test('GitHub Action script: live catalog adds fork issues and the fork check', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'planning-live-'));
  const closeFork = join(dir, 'close.json');
  const noFork = join(dir, 'nofork.json');
  writeFileSync(closeFork, JSON.stringify(base([{ op: 'close_issue', id: 'gta6-forks/ScarlettX#3', reason: 'fixed upstream in 2b281039' }])));
  writeFileSync(noFork, JSON.stringify(base([{ ...newIssue, repo: 'someone/elsewhere' }])));
  const api = {
    '/api/tasks': { tasks: [{ id: 'gta6-forks/ScarlettX#3', kind: 'issue', status: 'open', filters: { readiness: 'ready' } }] },
    '/api/config': { task_repos: ['gta6-forks/ScarlettX', 'gta6-forks/Xbox2Windows'] },
  };
  const fetchImpl = async (u) => ({ ok: true, json: async () => api[new URL(u).pathname] });
  const logs = [];
  const log = (l) => logs.push(l);
  const env = { GTA6_COORDINATOR_URL: 'https://coord.test' };
  assert.equal(await runAction([closeFork], {}, log), 1, 'seed only: fork issue unknown');
  assert.equal(await runAction([closeFork], env, log, { fetchImpl }), 0, JSON.stringify(logs));
  assert.equal(await runAction([noFork], env, log, { fetchImpl }), 1);
  assert.ok(logs.some((l) => /has no main fork here/.test(l)));
  const down = async () => ({ ok: false, status: 503 });
  assert.equal(await runAction([closeFork], env, log, { fetchImpl: down }), 1);
  assert.ok(logs.some((l) => /live catalog unavailable/.test(l)));
});
