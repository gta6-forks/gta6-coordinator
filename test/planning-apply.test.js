// Approved planning proposal -> issues in the main forks + catalog changes (fake GitHub planner).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { SEED } from '../src/generated/seed.js';
import { applyPlanningPr, forkFor, getOverrides } from '../src/services/planning-apply.js';
import { getTask } from '../src/services/catalog.js';
import { parseTaskBlock } from '../src/github/read-source.js';
import { baseEnv, clock, createNodeStore } from './helpers.js';

const FORKS = 'gta6-forks/Leonida,gta6-forks/Xbox2Windows,gta6-forks/ScarlettX,gta6-forks/rpf9-explorer,gta6-forks/americas-recomp';
const DRAFT = 'draft:breadbbbb/rpf9-explorer/bcpack-decoder';

class FakePlanner {
  constructor(files) {
    this.files = files;
    this.issues = [];
    this.calls = [];
  }
  async readToken() {
    return 'read';
  }
  async readProposalFiles() {
    return { merge_commit_sha: 'a'.repeat(40), files: structuredClone(this.files) };
  }
  async findIssueByMarker(repo, marker) {
    return this.issues.find((i) => i.repo === repo && i.body.includes(marker)) ?? null;
  }
  async createIssue(repo, { title, body }) {
    const number = this.issues.filter((i) => i.repo === repo).length + 1;
    const issue = { repo, number, id: 1000 + this.issues.length, title, body, state: 'open', html_url: `https://github.com/${repo}/issues/${number}` };
    this.issues.push(issue);
    this.calls.push(['create', repo, title]);
    return issue;
  }
  async getIssue(repo, number) {
    return this.issues.find((i) => i.repo === repo && i.number === number);
  }
  async updateIssue(repo, number, patch) {
    Object.assign(await this.getIssue(repo, number), patch);
    this.calls.push(['update', repo, number]);
  }
  async addSubIssue(repo, parent, childId) {
    this.calls.push(['sub', repo, parent, childId]);
  }
}

function taskTemplate() {
  const d = structuredClone(SEED.tasks.find((t) => t.id === DRAFT));
  for (const k of ['id', 'repo', 'fork_repo', 'title', 'url', 'github_kind']) delete d[k];
  return { ...d, readiness: 'ready', state: 'open', depends_on: [] };
}

function proposal() {
  return {
    schema_version: 1,
    id: 'split-bcpack',
    rationale_md: 'Split the BCPack decoder draft into two issues.',
    based_on: { roadmap_version: 1, snapshot_at: '2026-11-21T00:00:00Z' },
    operations: [
      { op: 'create_issue', ref: 'new:decoder', repo: 'breadbbbb/rpf9-explorer', replaces_draft: DRAFT, title: 'BCPack decoder', body_md: 'Decode BCPack.', task: taskTemplate() },
      { op: 'create_issue', ref: 'new:fixtures', repo: 'breadbbbb/rpf9-explorer', title: 'BCPack test fixtures', body_md: 'Synthetic fixtures.', task: taskTemplate() },
      { op: 'add_dependency', id: 'new:decoder', depends_on: 'new:fixtures' },
      { op: 'set_priority', id: 'R0Y00/Xbox2Windows#77', priority: 'p0' },
    ],
  };
}

async function world(files) {
  const store = createNodeStore();
  const planner = new FakePlanner(files);
  const app = createApp({ store, env: baseEnv({ TASK_REPOS: FORKS, COORDINATOR_REPO: 'gta6-forks/gta6-coordinator' }), now: clock(), planner });
  await app.ensureSeeded();
  return { app, ctx: app.ctx, planner };
}

test('fork mapping: upstream names map to the managed fork', () => {
  const env = { TASK_REPOS: FORKS };
  assert.equal(forkFor(env, 'breadbbbb/rpf9-explorer'), 'gta6-forks/rpf9-explorer');
  assert.equal(forkFor(env, 'gta6-forks/Leonida'), 'gta6-forks/Leonida');
  assert.equal(forkFor(env, 'someone/else'), null);
});

test('an approved proposal creates fork issues, retires the draft, resolves refs and is applied once', async () => {
  const { app, ctx, planner } = await world([{ path: 'planning/proposals/split-bcpack.json', proposal: proposal() }]);
  const out = await app.ctx.applyPlanning({ number: 7, url: 'https://github.com/gta6-forks/gta6-coordinator/pull/7' });
  const r = out.results[0];
  assert.equal(r.status, 'applied', JSON.stringify(r.log));
  assert.equal(planner.issues.length, 2);
  const decoder = planner.issues.find((i) => i.title === 'BCPack decoder');
  const block = parseTaskBlock(decoder.body);
  assert.equal(block.fork_repo, 'gta6-forks/rpf9-explorer');
  assert.deepEqual(block.depends_on, [r.created['new:fixtures']], 'dependency between two new issues is resolved to the real issue id');
  assert.equal(getOverrides(ctx.store)[DRAFT].state, 'closed', 'the replaced draft is closed');
  assert.equal(getTask(ctx.store, DRAFT).data.state, 'closed');
  assert.equal(getTask(ctx.store, 'R0Y00/Xbox2Windows#77').data.priority, 'p0', 'seed task changed through an override');

  const again = await app.ctx.applyPlanning({ number: 7, url: 'https://github.com/gta6-forks/gta6-coordinator/pull/7' });
  assert.equal(again.results[0].status, 'already_applied');
  assert.equal(planner.issues.length, 2, 'never duplicated');
});

test('invalid proposals and protected-objective changes are not applied', async () => {
  const bad = { ...proposal(), id: 'bad-one', operations: [{ op: 'set_priority', id: 'nope/nope#1', priority: 'p0' }] };
  const owner = { ...proposal(), id: 'objective', operations: [{ op: 'set_objective', text_md: 'New objective' }] };
  const { ctx, planner } = await world([
    { path: 'planning/proposals/bad-one.json', proposal: bad },
    { path: 'planning/proposals/objective.json', proposal: owner },
  ]);
  const out = await applyPlanningPr(ctx, planner, { number: 8, url: 'u' });
  assert.deepEqual(out.results.map((x) => x.status), ['invalid', 'needs_owner_authorization']);
  assert.equal(planner.issues.length, 0);
});

test('validator: upstream repo -> warning naming the fork; repo without a fork -> error', async () => {
  const { ctx } = await world([]);
  const { validateProposal, catalogSnapshot } = await import('../src/services/planning.js');
  const p = proposal();
  const ok = validateProposal(p, catalogSnapshot(ctx.store, ctx.env));
  assert.equal(ok.valid, true);
  assert.ok(ok.warnings.some((w) => /use gta6-forks\/rpf9-explorer/.test(w)));
  const bad = structuredClone(p);
  bad.operations[0].repo = 'someone/elsewhere';
  assert.ok(validateProposal(bad, catalogSnapshot(ctx.store, ctx.env)).errors.some((e) => /has no main fork/.test(e)));
});
