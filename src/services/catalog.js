import { normalizeTask } from '../domain/task.js';
import { getMeta, recordEvent, setMeta } from '../store/store.js';

export function loadTasks(store) {
  return store.all('SELECT id, origin, data_json, status, updated_at FROM tasks').map((r) => ({
    id: r.id,
    origin: r.origin,
    status: r.status,
    updated_at: r.updated_at,
    data: JSON.parse(r.data_json),
  }));
}

export function getTask(store, id) {
  const r = store.one('SELECT id, origin, data_json, status, updated_at FROM tasks WHERE id = ?', id);
  return r ? { id: r.id, origin: r.origin, status: r.status, updated_at: r.updated_at, data: JSON.parse(r.data_json) } : null;
}

export function findCycles(tasks) {
  const graph = new Map(tasks.map((t) => [t.id, t.depends_on ?? []]));
  const state = new Map();
  const cycles = [];
  const visit = (id, stack) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'active') {
      cycles.push([...stack.slice(stack.indexOf(id)), id]);
      return;
    }
    state.set(id, 'active');
    for (const dep of graph.get(id) ?? []) if (graph.has(dep)) visit(dep, [...stack, id]);
    state.set(id, 'done');
  };
  for (const id of graph.keys()) visit(id, []);
  return cycles;
}

/** Upserts catalog tasks from a source. Invalid tasks are reported and skipped; workflow status is preserved. */
export function syncCatalog(ctx, rawTasks, roadmap) {
  const errors = [];
  const valid = [];
  for (const raw of rawTasks) {
    const { task, errors: e } = normalizeTask(raw);
    if (task) valid.push(task);
    else errors.push({ id: raw?.id ?? null, errors: e });
  }
  const cycles = findCycles(valid);
  const inCycle = new Set(cycles.flat());
  const now = ctx.now();
  ctx.store.tx(() => {
    for (const t of valid) {
      if (inCycle.has(t.id)) continue;
      ctx.store.exec(
        `INSERT INTO tasks (id, origin, data_json, status, updated_at) VALUES (?, 'catalog', ?, 'open', ?)
         ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`,
        t.id,
        JSON.stringify(t),
        now,
      );
    }
    if (roadmap) setMeta(ctx.store, 'roadmap', roadmap);
    recordEvent(ctx.store, now, 'system', 'catalog.synced', { valid: valid.length - inCycle.size, invalid: errors.length, cycles });
  });
  return { synced: valid.length - inCycle.size, errors, cycles };
}

export function getRoadmap(store) {
  return getMeta(store, 'roadmap', null);
}
