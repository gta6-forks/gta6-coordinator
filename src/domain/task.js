import { validate } from '../schema/validate.js';
import { taskSchema } from '../schema/schemas.js';
import { parseTaskId } from '../util.js';

const ENFORCED = new Set(['confirmed', 'inferred']);

/** Validates a raw task and returns { task, errors }. Adds derived `executable` and `filters`. */
export function normalizeTask(raw) {
  const errors = validate(taskSchema, raw);
  if (errors.length) return { task: null, errors };

  const t = structuredClone(raw);
  const parsed = parseTaskId(t.id);
  if (!parsed) errors.push('$.id: unparseable');
  if (parsed?.kind === 'github') {
    if (t.repo !== parsed.repo) errors.push(`$.repo must be ${parsed.repo} for id ${t.id}`);
  }
  if (parsed?.kind === 'draft') {
    if (t.readiness !== 'draft') errors.push('$.readiness: draft:* ids must stay readiness=draft until a GitHub issue exists');
    if (t.repo && t.repo !== parsed.repo) errors.push(`$.repo must be ${parsed.repo}`);
  }
  if ((t.role === 'plan' || t.role === 'verify') && t.type !== 'strategic') errors.push('$.type: plan/verify tasks are strategic');
  if (t.kind === 'subissue' && !t.parent) errors.push('$.parent: subissue requires parent');
  if (t.kind === 'group' && t.role !== 'execute') errors.push('$.role: group issues only aggregate');
  if (t.depends_on.includes(t.id)) errors.push('$.depends_on: self dependency');
  if (t.role === 'verify' && !t.review) errors.push('$.review: verify tasks need review metadata');
  if (errors.length) return { task: null, errors };

  t.executable = t.kind !== 'group';
  t.filters = deriveFilters(t);
  return { task: t, errors: [] };
}

function phaseValue(phase, kind) {
  const req = phase.required.find((r) => r.kind === kind && ENFORCED.has(r.confidence));
  return req ? req.value : 'unspecified';
}

export function deriveFilters(t) {
  const impl = t.requirements.implementation;
  const val = t.requirements.validation;
  return {
    repo: t.repo ?? null,
    type: t.type,
    role: t.role,
    difficulty: t.difficulty,
    priority: t.priority,
    readiness: t.readiness,
    milestone: t.milestone ?? null,
    os: phaseValue(impl, 'os'),
    gpu: phaseValue(impl, 'gpu'),
    needs_game_files: { implementation: phaseValue(impl, 'game_files'), validation: phaseValue(val, 'game_files') },
  };
}

/** Returns a list of reasons why `profile` cannot satisfy the required (non-unspecified) items of a phase. */
export function profileMismatches(phase, profile) {
  const reasons = [];
  for (const req of phase.required) {
    if (!ENFORCED.has(req.confidence)) continue;
    if (req.kind === 'os') {
      const wanted = Array.isArray(req.value) ? req.value : [req.value];
      if (!profile?.os?.length) reasons.push('profile_missing_os');
      else if (!wanted.some((o) => profile.os.includes(o))) reasons.push(`requires_os:${wanted.join('|')}`);
    } else if (req.kind === 'gpu') {
      const v = req.value;
      const vendor = profile?.gpu_vendor;
      if (v === 'none') continue;
      if (!vendor || vendor === 'none') reasons.push(`requires_gpu:${v}`);
      else if (v !== 'any' && v !== 'physical' && vendor !== v) reasons.push(`requires_gpu:${v}`);
    } else if (req.kind === 'game_files') {
      if (req.value === 'yes' && !profile?.has_own_game_copy) reasons.push('requires_own_game_copy');
      if (req.value === 'unknown' && !profile?.has_own_game_copy && !profile?.accept_unknown_requirements) {
        reasons.push('game_files_requirement_unknown');
      }
    }
  }
  return reasons;
}

export function matchesFilters(task, filters = {}) {
  const f = task.filters;
  const one = (want, have) => want === undefined || (Array.isArray(want) ? want.includes(have) : want === have);
  if (!one(filters.repo, f.repo)) return false;
  if (!one(filters.type, f.type)) return false;
  if (!one(filters.role, f.role)) return false;
  if (!one(filters.difficulty, f.difficulty)) return false;
  if (!one(filters.priority, f.priority)) return false;
  if (!one(filters.milestone, f.milestone)) return false;
  if (filters.max_difficulty) {
    const order = { low: 0, medium: 1, high: 2 };
    if (order[f.difficulty] > order[filters.max_difficulty]) return false;
  }
  if (filters.os && f.os !== 'unspecified') {
    const want = Array.isArray(filters.os) ? filters.os : [filters.os];
    if (!f.os.some((o) => want.includes(o))) return false;
  }
  if (filters.gpu && f.gpu !== 'unspecified' && filters.gpu !== f.gpu) return false;
  if (filters.needs_game_files && f.needs_game_files.implementation !== filters.needs_game_files) return false;
  return true;
}
