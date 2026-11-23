// Planning proposals: validated here (MCP), again in the GitHub Action (tools/validate-planning.mjs), and applied
// by the Worker (services/planning-apply.js) only after the planning PR got two reviews and was merged.
import { AppError, ISSUE_ID } from '../util.js';
import { validate } from '../schema/validate.js';
import { planningProposalSchema } from '../schema/schemas.js';
import { normalizeTask } from '../domain/task.js';
import { findCycles, getRoadmap, loadTasks } from './catalog.js';
import { recordEvent } from '../store/store.js';
import { effectiveStatus, upstreamConfig, upstreamIndex, upstreamReport } from './upstream.js';

/**
 * Pure validation shared by the MCP and the GitHub Action.
 * @param proposal parsed JSON
 * @param catalog { tasks: Array<{id, depends_on, kind, executable, readiness}>, roadmap }
 */
export function validateProposal(proposal, catalog) {
  const errors = validate(planningProposalSchema, proposal);
  const warnings = [];
  if (errors.length) return { valid: false, errors, warnings, requires_human_authorization: false, summary: {} };

  const byId = new Map(catalog.tasks.map((t) => [t.id, structuredClone(t)]));
  const created = new Map();
  const protectedMilestones = new Set((catalog.roadmap?.milestones ?? []).filter((m) => m.protected).map((m) => m.id));
  let requiresHuman = false;
  const counts = {};

  const exists = (id) => byId.has(id) || created.has(id);
  const resolve = (id) => created.get(id) ?? byId.get(id);

  proposal.operations.forEach((op, i) => {
    const at = `$.operations[${i}]`;
    counts[op.op] = (counts[op.op] ?? 0) + 1;
    switch (op.op) {
      case 'create_issue': {
        if (created.has(op.ref)) errors.push(`${at}.ref: duplicate ${op.ref}`);
        const draft = { ...op.task, id: `${op.repo}#1`, repo: op.repo, title: op.title };
        const { errors: taskErrors } = normalizeTask({
          readiness: 'ready', state: 'open', depends_on: [], sources: [{ kind: 'coordinator', ref: proposal.id }], ...draft,
        });
        for (const e of taskErrors) errors.push(`${at}.task${e.slice(1)}`);
        if (op.replaces_draft && !byId.has(op.replaces_draft)) errors.push(`${at}.replaces_draft: unknown ${op.replaces_draft}`);
        if (catalog.forks?.length && !catalog.forks.includes(op.repo)) {
          const fork = catalog.forks.find((x) => x.split('/')[1] === op.repo.split('/')[1]);
          if (fork) warnings.push(`${at}.repo: issues are created in the main fork; use ${fork} (${op.repo} is mapped to it)`);
          else errors.push(`${at}.repo: ${op.repo} has no main fork here; use one of ${catalog.forks.join(', ')}`);
        }
        created.set(op.ref, { id: op.ref, depends_on: [...(op.task.depends_on ?? [])], kind: op.task.kind ?? 'issue', executable: op.task.kind !== 'group' });
        break;
      }
      case 'close_issue':
      case 'set_priority':
      case 'set_readiness':
        if (!exists(op.id)) errors.push(`${at}.id: unknown ${op.id}`);
        if (op.op === 'set_readiness' && op.readiness === 'ready' && op.id.startsWith('draft:')) {
          errors.push(`${at}: a draft becomes ready only through create_issue with replaces_draft`);
        }
        break;
      case 'add_dependency':
      case 'remove_dependency': {
        for (const k of ['id', 'depends_on']) if (!exists(op[k])) errors.push(`${at}.${k}: unknown ${op[k]}`);
        const t = resolve(op.id);
        if (t) {
          const deps = new Set(t.depends_on ?? []);
          if (op.op === 'add_dependency') deps.add(op.depends_on);
          else deps.delete(op.depends_on);
          t.depends_on = [...deps];
        }
        break;
      }
      case 'add_subissue': {
        for (const k of ['parent', 'child']) if (!exists(op[k])) errors.push(`${at}.${k}: unknown ${op[k]}`);
        const parent = resolve(op.parent);
        if (parent && parent.executable !== false && parent.kind !== 'group') {
          errors.push(`${at}.parent: ${op.parent} is executable; only grouping issues (kind=group) can have sub-issues`);
        }
        if (op.parent === op.child) errors.push(`${at}: parent equals child`);
        break;
      }
      case 'roadmap_change':
        if (protectedMilestones.has(op.milestone)) requiresHuman = true;
        if (!(catalog.roadmap?.milestones ?? []).some((m) => m.id === op.milestone)) warnings.push(`${at}.milestone: new milestone ${op.milestone}`);
        break;
      case 'set_objective':
        requiresHuman = true;
        break;
      default:
        errors.push(`${at}.op: unsupported`);
    }
    if (op.op === 'close_issue' && ISSUE_ID.test(op.id) && (catalog.roadmap?.protected_tasks ?? []).includes(op.id)) requiresHuman = true;
  });

  // Upstream reconciliation (optional data: the GitHub Action may validate without it).
  const upstreamOf = (id) => byId.get(id)?.upstream_status ?? null;
  const DEAD = new Set(['resolved_upstream', 'obsolete']);
  // In `report` mode the automatic status is provisional and informational: it warns, it never rejects a proposal
  // (an applied PR must not fail on data the GitHub Action could not see). Enforcement modes turn these into errors.
  const enforcing = String(catalog.upstream?.mode ?? '').startsWith('enforce');
  const upstreamError = (msg) => (enforcing ? errors : warnings).push(msg);
  proposal.operations.forEach((op, i) => {
    const at = `$.operations[${i}]`;
    const target = op.op === 'create_issue' ? op.replaces_draft : ['set_priority', 'set_readiness', 'add_dependency', 'add_subissue'].includes(op.op) ? op.id ?? op.child : null;
    const st = target ? upstreamOf(target) : null;
    if (!st) return;
    if (DEAD.has(st)) upstreamError(`${at}: ${target} is ${st} upstream; close it (close_issue) instead of keeping it in stock`);
    else if (st === 'needs_review' || st === 'unchecked') warnings.push(`${at}: ${target} has not been revalidated against the upstream (${st}); check get_upstream_status first`);
    else if ((st === 'partially_met' || st === 'needs_replan') && op.op === 'set_readiness' && op.readiness === 'ready') {
      upstreamError(`${at}: ${target} is ${st} upstream; redefine it (create_issue with the remaining scope) before making it ready`);
    }
  });
  if (catalog.upstream?.stale_repos?.length) {
    warnings.push(`upstream snapshot older than the freshness limit for: ${catalog.upstream.stale_repos.join(', ')}`);
  }
  // Stock limit: open, ready, operational tasks per original repository.
  const max = catalog.upstream?.max_stock_per_repo;
  if (max) {
    const key = (repo) => String(repo ?? '').split('/')[1]?.toLowerCase() ?? '';
    const stock = new Map();
    for (const t of byId.values()) {
      if (t.status === 'open' && t.readiness === 'ready' && t.type === 'operational' && t.repo && !DEAD.has(t.upstream_status)) stock.set(key(t.repo), (stock.get(key(t.repo)) ?? 0) + 1);
    }
    const added = new Map();
    for (const op of proposal.operations) {
      if (op.op !== 'create_issue' || (op.task?.type ?? 'operational') !== 'operational' || op.task?.kind === 'group') continue;
      added.set(key(op.repo), (added.get(key(op.repo)) ?? 0) + 1);
    }
    for (const [repo, n] of added) {
      const total = (stock.get(repo) ?? 0) + n;
      if (total > max) upstreamError(`stock limit: ${repo} would have ${total} open ready tasks (max ${max}); revalidate or close existing ones first`);
    }
  }

  const graph = [...byId.values(), ...created.values()].map((t) => ({ id: t.id, depends_on: t.depends_on ?? [] }));
  for (const cycle of findCycles(graph)) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);

  return { valid: errors.length === 0, errors, warnings, requires_human_authorization: requiresHuman, summary: counts };
}

export function catalogSnapshot(store, env = null, now = Date.now()) {
  const cfg = upstreamConfig(env ?? {});
  const idx = env && cfg.mode !== 'off' ? upstreamIndex({ store, env, now: () => now }) : null;
  const tasks = loadTasks(store);
  return {
    forks: env ? String(env.TASK_REPOS ?? '').split(',').map((s) => s.trim()).filter(Boolean) : null,
    tasks: tasks.map((t) => ({
      id: t.id,
      depends_on: t.data.depends_on,
      kind: t.data.kind,
      executable: t.data.executable,
      readiness: t.data.readiness,
      repo: t.data.repo ?? null,
      type: t.data.type,
      status: t.status,
      ...(idx ? { upstream_status: effectiveStatus(idx, t).status } : {}),
    })),
    roadmap: getRoadmap(store),
    ...(idx
      ? {
          upstream: {
            mode: cfg.mode,
            max_stock_per_repo: cfg.maxStockPerRepo,
            stale_repos: [...idx.repos.values()].filter((r) => !r.last_success_at || now - r.last_success_at > cfg.staleMs).map((r) => r.repo),
          },
        }
      : {}),
  };
}

function requireStrategic(participant) {
  if (participant.kind !== 'google') throw new AppError('requires_google_login', 'planning is a strategic activity (Google login)', 403);
}

export function submitProposal(ctx, participant, proposal) {
  requireStrategic(participant);
  const result = validateProposal(proposal, catalogSnapshot(ctx.store, ctx.env, ctx.now()));
  const now = ctx.now();
  if (result.valid) {
    const existing = ctx.store.one('SELECT participant_id FROM proposals WHERE id = ?', proposal.id);
    if (existing && existing.participant_id !== participant.id) throw new AppError('proposal_id_taken', 'choose another proposal id', 409);
    ctx.store.exec(
      `INSERT INTO proposals (id, participant_id, data_json, validation_json, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, validation_json = excluded.validation_json`,
      proposal.id, participant.id, JSON.stringify(proposal), JSON.stringify(result), now,
    );
    recordEvent(ctx.store, now, participant.id, 'planning.proposal_validated', { id: proposal.id, summary: result.summary });
  }
  return {
    ...result,
    proposal_id: result.valid ? proposal.id : null,
    pr_instructions: result.valid
      ? {
          repository: ctx.env.COORDINATOR_REPO ?? '(coordinator repository not configured yet)',
          path: `planning/proposals/${proposal.id}.json`,
          note: 'Open a PR adding exactly this file. Two verifications + the planning Action are required before anything is applied.',
        }
      : null,
  };
}

export function planningContext(ctx, participant) {
  requireStrategic(participant);
  const tasks = loadTasks(ctx.store).map((t) => ({
    id: t.id,
    origin: t.origin,
    title: t.data.title,
    status: t.status,
    readiness: t.data.readiness,
    state: t.data.state,
    role: t.data.role,
    type: t.data.type,
    priority: t.data.priority,
    difficulty: t.data.difficulty,
    milestone: t.data.milestone ?? null,
    depends_on: t.data.depends_on,
    parent: t.data.parent ?? null,
    kind: t.data.kind,
  }));
  const reviews = ctx.store.all('SELECT id, task_id, commit_sha, pr_url, state, ci_conclusion, updated_at FROM reviews ORDER BY updated_at DESC LIMIT 200');
  const failures = ctx.store
    .all("SELECT v.review_id, v.slot, v.data_json FROM verifications v WHERE v.verdict = 'reject' ORDER BY v.created_at DESC LIMIT 100")
    .map((v) => ({ review_id: v.review_id, slot: v.slot, feedback_md: JSON.parse(v.data_json).feedback_md }));
  const active = ctx.store.one("SELECT COUNT(*) AS n FROM reservations WHERE state = 'active'").n;
  // The planner always sees the reconciliation with the ORIGINAL repositories (HEAD sha, last check, evidence).
  const upstream = upstreamConfig(ctx.env).mode === 'off' ? null : upstreamReport(ctx);
  return { roadmap: getRoadmap(ctx.store), tasks, reviews, failures, active_reservations: active, upstream, generated_at: new Date(ctx.now()).toISOString() };
}
