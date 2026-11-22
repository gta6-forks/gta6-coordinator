// Applies an APPROVED planning proposal: the planning PR in the coordinator repository was reviewed twice and merged.
//   create_issue          -> a `gta6-task` issue in the main fork (idempotent: a hidden marker per proposal/ref)
//   other operations      -> edit the gta6-task block of a fork issue, or a catalog override for seed tasks
//   replaces_draft        -> the draft is closed and its dependents now depend on the new issue
//   roadmap/objective     -> recorded for the owner, never applied automatically (protected objective)
// Every step is recorded; a proposal is applied at most once (meta `planning_applied:<id>`).
import { getMeta, recordEvent, setMeta } from '../store/store.js';
import { getTask, loadTasks } from './catalog.js';
import { catalogSnapshot, validateProposal } from './planning.js';
import { parseTaskBlock } from '../github/read-source.js';
import { withTaskBlock } from '../github/planner.js';

const OVERRIDES = 'catalog_overrides';
const IDENTITY = ['id', 'repo', 'title', 'url', 'github_kind'];

export function getOverrides(store) {
  return getMeta(store, OVERRIDES, {});
}

/** Seed tasks carry the overrides written by applied proposals (priority, readiness, dependencies, parent, state). */
export function applyOverrides(tasks, overrides) {
  return tasks.map((t) => (overrides[t.id] ? { ...t, ...overrides[t.id] } : t));
}

export function managedRepos(env) {
  return String(env.TASK_REPOS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Main fork for a repository named in a proposal (upstream `owner/name` or the fork itself). */
export function forkFor(env, repo) {
  const forks = managedRepos(env);
  if (forks.includes(repo)) return repo;
  const name = String(repo).split('/')[1];
  return forks.find((f) => f.split('/')[1] === name) ?? null;
}

const issueRef = (env, id) => {
  const m = /^([^/]+\/[^#]+)#(\d+)$/.exec(id ?? '');
  return m && managedRepos(env).includes(m[1]) ? { repo: m[1], number: Number(m[2]) } : null;
};

/** Edits one task: a fork issue (its gta6-task block) or a seed task (catalog override). */
async function editTask(ctx, planner, id, mutate) {
  const ref = issueRef(ctx.env, id);
  if (ref) {
    const issue = await planner.getIssue(ref.repo, ref.number);
    const block = parseTaskBlock(issue.body) ?? {};
    const next = mutate(structuredClone(block));
    const patch = { body: withTaskBlock(issue.body, next) };
    if (next.state === 'closed' && issue.state !== 'closed') Object.assign(patch, { state: 'closed', state_reason: 'not_planned' });
    await planner.updateIssue(ref.repo, ref.number, patch);
    return 'issue';
  }
  const task = getTask(ctx.store, id);
  if (!task) throw new Error(`unknown task ${id}`);
  const overrides = getOverrides(ctx.store);
  const current = { ...task.data, ...(overrides[id] ?? {}) };
  const next = mutate(structuredClone(current));
  const changed = {};
  for (const k of ['priority', 'readiness', 'depends_on', 'parent', 'state', 'kind']) {
    if (JSON.stringify(next[k]) !== JSON.stringify(task.data[k])) changed[k] = next[k];
  }
  overrides[id] = changed;
  setMeta(ctx.store, OVERRIDES, overrides);
  return 'override';
}

function blockFor(op, fork, refs, proposalId) {
  const block = { ...op.task };
  for (const k of IDENTITY) delete block[k];
  block.fork_repo = fork;
  block.depends_on = (op.task.depends_on ?? []).map((d) => refs.get(d) ?? d);
  if (block.parent && refs.has(block.parent)) block.parent = refs.get(block.parent);
  block.sources = [...(op.task.sources ?? []), { kind: 'coordinator', ref: `proposal:${proposalId}` }];
  return block;
}

/**
 * @param planner GitHubPlanner (or a fake in tests)
 * @param pr { number, url }
 */
export async function applyPlanningPr(ctx, planner, pr) {
  const { files } = await planner.readProposalFiles(pr.number);
  const results = [];
  for (const file of files) {
    if (!file.proposal) {
      results.push({ path: file.path, status: 'invalid', errors: [file.error] });
      continue;
    }
    const proposal = file.proposal;
    const doneKey = `planning_applied:${proposal.id}`;
    if (getMeta(ctx.store, doneKey)) {
      results.push({ proposal_id: proposal.id, status: 'already_applied' });
      continue;
    }
    const check = validateProposal(proposal, catalogSnapshot(ctx.store, ctx.env));
    if (!check.valid) {
      recordEvent(ctx.store, ctx.now(), 'planner', 'planning.apply_rejected', { proposal_id: proposal.id, pr: pr.url, errors: check.errors.slice(0, 20) });
      results.push({ proposal_id: proposal.id, status: 'invalid', errors: check.errors });
      continue;
    }
    if (check.requires_human_authorization) {
      recordEvent(ctx.store, ctx.now(), 'planner', 'planning.needs_owner', { proposal_id: proposal.id, pr: pr.url });
      results.push({ proposal_id: proposal.id, status: 'needs_owner_authorization' });
      continue;
    }

    const refs = new Map();
    const log = [];
    const ops = proposal.operations;
    // 1) create the new issues (dependencies on refs created later are fixed in step 2)
    for (const op of ops.filter((o) => o.op === 'create_issue')) {
      const fork = forkFor(ctx.env, op.repo);
      if (!fork) {
        log.push({ op: op.op, ref: op.ref, status: 'error', detail: `no managed fork for ${op.repo}` });
        continue;
      }
      const marker = `<!-- gta6-proposal:${proposal.id}:${op.ref} -->`;
      let issue = await planner.findIssueByMarker(fork, marker);
      if (!issue) {
        const body = `${op.body_md}\n\n${marker}\n\n` + '```gta6-task\n' + JSON.stringify(blockFor(op, fork, refs, proposal.id), null, 2) + '\n```';
        issue = await planner.createIssue(fork, { title: op.title, body });
      }
      refs.set(op.ref, `${fork}#${issue.number}`);
      log.push({ op: op.op, ref: op.ref, status: 'created', id: `${fork}#${issue.number}`, url: issue.html_url });
    }
    // 2) rewrite blocks whose dependencies/parent pointed at refs created after them
    for (const op of ops.filter((o) => o.op === 'create_issue')) {
      const id = refs.get(op.ref);
      const fork = forkFor(ctx.env, op.repo);
      const pending = [...(op.task.depends_on ?? []), op.task.parent].some((d) => d && String(d).startsWith('new:'));
      if (!id || !pending) continue;
      await editTask(ctx, planner, id, () => blockFor(op, fork, refs, proposal.id));
    }
    const resolve = (id) => refs.get(id) ?? id;
    // 3) the remaining operations, in order
    for (const op of ops) {
      try {
        switch (op.op) {
          case 'create_issue':
            if (op.replaces_draft && refs.has(op.ref)) {
              const newId = refs.get(op.ref);
              await editTask(ctx, planner, op.replaces_draft, (t) => ({ ...t, state: 'closed' }));
              for (const dep of loadTasks(ctx.store).filter((t) => (t.data.depends_on ?? []).includes(op.replaces_draft))) {
                await editTask(ctx, planner, dep.id, (t) => ({ ...t, depends_on: [...new Set((t.depends_on ?? []).map((d) => (d === op.replaces_draft ? newId : d)))] }));
              }
              log.push({ op: 'replace_draft', draft: op.replaces_draft, by: newId, status: 'applied' });
            }
            break;
          case 'close_issue':
            log.push({ op: op.op, id: op.id, status: await editTask(ctx, planner, resolve(op.id), (t) => ({ ...t, state: 'closed' })) });
            break;
          case 'set_priority':
            log.push({ op: op.op, id: op.id, status: await editTask(ctx, planner, resolve(op.id), (t) => ({ ...t, priority: op.priority })) });
            break;
          case 'set_readiness':
            log.push({ op: op.op, id: op.id, status: await editTask(ctx, planner, resolve(op.id), (t) => ({ ...t, readiness: op.readiness })) });
            break;
          case 'add_dependency':
          case 'remove_dependency': {
            const target = resolve(op.depends_on);
            log.push({
              op: op.op,
              id: op.id,
              status: await editTask(ctx, planner, resolve(op.id), (t) => {
                const deps = new Set(t.depends_on ?? []);
                if (op.op === 'add_dependency') deps.add(target);
                else deps.delete(target);
                return { ...t, depends_on: [...deps] };
              }),
            });
            break;
          }
          case 'add_subissue': {
            const parent = resolve(op.parent);
            const child = resolve(op.child);
            const p = issueRef(ctx.env, parent);
            const c = issueRef(ctx.env, child);
            if (p && c && p.repo === c.repo) {
              const childIssue = await planner.getIssue(c.repo, c.number);
              await planner.addSubIssue(p.repo, p.number, childIssue.id);
              log.push({ op: op.op, parent, child, status: 'issue' });
            } else {
              log.push({ op: op.op, parent, child, status: await editTask(ctx, planner, child, (t) => ({ ...t, parent })) });
            }
            break;
          }
          case 'roadmap_change':
          case 'set_objective':
            recordEvent(ctx.store, ctx.now(), 'planner', 'planning.roadmap_note', { proposal_id: proposal.id, op });
            log.push({ op: op.op, status: 'recorded_for_owner' });
            break;
          default:
            log.push({ op: op.op, status: 'unsupported' });
        }
      } catch (err) {
        log.push({ op: op.op, status: 'error', detail: String(err.message ?? err).slice(0, 300) });
      }
    }
    setMeta(ctx.store, doneKey, { applied_at: ctx.now(), pr: pr.url, log });
    recordEvent(ctx.store, ctx.now(), 'planner', 'planning.applied', { proposal_id: proposal.id, pr: pr.url, created: [...refs.values()] });
    results.push({ proposal_id: proposal.id, status: 'applied', created: Object.fromEntries(refs), log });
  }
  return { pr: pr.url, results };
}
