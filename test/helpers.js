// Test doubles: the same store interface as the Durable Object, backed by node:sqlite;
// a fake KV namespace; a fake Durable Object namespace; a controllable clock.
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';
import { createAnonymous, loginGoogle, setProfile } from '../src/services/auth.js';
import { syncCatalog } from '../src/services/catalog.js';

export function createNodeStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
  let depth = 0;
  const isQuery = (q) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(q) || /\bRETURNING\b/i.test(q);
  return {
    db,
    exec(query, ...params) {
      const stmt = db.prepare(query);
      if (isQuery(query)) {
        stmt.all(...params);
        return { rowsWritten: 0 };
      }
      const info = stmt.run(...params);
      return { rowsWritten: Number(info.changes) };
    },
    all(query, ...params) {
      return db.prepare(query).all(...params).map((r) => ({ ...r }));
    },
    one(query, ...params) {
      const r = db.prepare(query).get(...params);
      return r ? { ...r } : null;
    },
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        if (out && typeof out.then === 'function') throw new Error('transactions must be synchronous');
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      } finally {
        depth--;
      }
    },
  };
}

export class FakeKV {
  constructor() {
    this.map = new Map();
  }
  async get(key, type) {
    const v = this.map.get(key);
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key, value) {
    this.map.set(key, String(value));
  }
  async delete(key) {
    this.map.delete(key);
  }
}

export function clock(start = Date.UTC(2026, 10, 21, 12, 0, 0)) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

export const HOUR = 3600_000;

export function baseEnv(extra = {}) {
  return { TOKEN_PEPPER: 'test-pepper', RESERVATION_TTL_HOURS: '24', COORDINATOR_REPO: 'gta6/coordinator', ...extra };
}

/** App + ctx with the real seed catalog. */
export async function setup({ env = baseEnv(), tasks = null, roadmap = undefined } = {}) {
  const now = clock();
  const store = createNodeStore();
  const app = createApp({ store, env, now });
  if (tasks) syncCatalog(app.ctx, tasks, roadmap ?? { version: 1, milestones: [] });
  else await app.ensureSeeded();
  return { app, ctx: app.ctx, store, now, env };
}

export async function anon(ctx, profile = { os: ['windows'], gpu_vendor: 'none', has_own_game_copy: false }) {
  const { participant, token } = await createAnonymous(ctx, {});
  return { participant: profile ? setProfile(ctx, participant, profile) : participant, token };
}

let googleSeq = 0;
export async function google(ctx, profile = { os: ['windows', 'linux'], gpu_vendor: 'amd', has_own_game_copy: false }) {
  googleSeq++;
  const { participant, token } = await loginGoogle(ctx, { sub: `sub-${googleSeq}`, email: `u${googleSeq}@example.test`, email_verified: true, name: `User ${googleSeq}` });
  return { participant: profile ? setProfile(ctx, participant, profile) : participant, token };
}

export function sha(n) {
  return n.toString(16).padStart(40, 'a').slice(-40);
}

export function completion(overrides = {}) {
  return {
    pr_url: 'https://github.com/someone/Xbox2Windows/pull/12',
    commit_sha: sha(1),
    branch: 'fix/pe-empty-reloc',
    summary_md: 'Rejeita diretório de relocação vazio quando delta != 0.',
    deliverables: { code: ['tools/pe_map.cpp'], knowledge_md: [], tests: ['tests/intake/empty_reloc.py'], artifacts: [] },
    validation: { commands: [{ command: "ctest --preset dev -R 'static_exe_intake'", exit_code: 0 }], environment: { os: 'Windows 11 26100' } },
    ai_assisted: true,
    game_data_in_deliverables: false,
    ...overrides,
  };
}

export function verification(overrides = {}) {
  return {
    commit_sha: sha(1),
    verdict: 'approve',
    checks: [{ command: "ctest --preset dev -R 'static_exe_intake'", exit_code: 0 }],
    feedback_md: 'Reproduzido no commit indicado; teste novo falha antes e passa depois.',
    environment: { os: 'Windows 11 26100' },
    ...overrides,
  };
}

/** Minimal task factory for scheduler tests. */
export function task(id, overrides = {}) {
  const repo = id.includes('#') ? id.split('#')[0] : null;
  return {
    id,
    repo,
    github_kind: 'issue',
    url: null,
    title: `Task ${id}`,
    kind: 'issue',
    parent: null,
    type: 'operational',
    role: 'execute',
    difficulty: 'low',
    priority: 'p2',
    readiness: 'ready',
    state: 'open',
    milestone: null,
    depends_on: [],
    instructions_md: 'do it',
    requirements: {
      implementation: { required: [], optional: [], suggested: [] },
      validation: { required: [], optional: [], suggested: [] },
    },
    acceptance: [{ text: 'works', confidence: 'confirmed' }],
    deliverables: ['code'],
    sources: [{ kind: 'coordinator', ref: 'test' }],
    ...overrides,
  };
}
