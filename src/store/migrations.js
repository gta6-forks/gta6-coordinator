// Versioned schema migrations for the Coordinator Durable Object (SQLite storage backend).
// Each entry runs once, inside a transaction, in order. Never edit an applied migration: append a new one.
// (v1 has not been applied anywhere yet; it was last edited before the first deploy.)
export const MIGRATIONS = [
  {
    version: 1,
    name: 'init',
    statements: [
      `CREATE TABLE participants (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('google','anonymous')),
        google_sub TEXT UNIQUE,
        email TEXT,
        display_name TEXT NOT NULL,
        public_alias TEXT NOT NULL,
        profile_json TEXT,
        created_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE tokens (
        hash TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL REFERENCES participants(id),
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL CHECK (origin IN ('catalog','coordinator')),
        data_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK (status IN ('open','in_review','needs_replan','approved','done','cancelled')),
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE reservations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        participant_id TEXT NOT NULL REFERENCES participants(id),
        state TEXT NOT NULL CHECK (state IN ('active','released','expired','completed','cancelled')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        renewals INTEGER NOT NULL DEFAULT 0,
        closed_at INTEGER
      )`,
      `CREATE UNIQUE INDEX one_active_reservation_per_task ON reservations(task_id) WHERE state = 'active'`,
      `CREATE UNIQUE INDEX one_active_reservation_per_participant ON reservations(participant_id) WHERE state = 'active'`,
      `CREATE TABLE idempotency (
        participant_id TEXT NOT NULL,
        key TEXT NOT NULL,
        op TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (participant_id, key)
      )`,
      `CREATE TABLE completions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        reservation_id TEXT NOT NULL REFERENCES reservations(id),
        participant_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE reviews (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        completion_id TEXT NOT NULL REFERENCES completions(id),
        executor_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        pr_url TEXT,
        workspace_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('integrating','integration_failed','expired','verifying','awaiting_ci','ready_to_merge','changes_requested','merged')),
        ci_conclusion TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE verifications (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES reviews(id),
        slot INTEGER NOT NULL CHECK (slot IN (1,2)),
        verifier_id TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK (verdict IN ('approve','reject')),
        commit_sha TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (review_id, slot),
        UNIQUE (review_id, verifier_id)
      )`,
      `CREATE TABLE merge_intents (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL UNIQUE REFERENCES reviews(id),
        status TEXT NOT NULL,
        adapter_response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE proposals (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        validation_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL UNIQUE REFERENCES reservations(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        participant_id TEXT NOT NULL REFERENCES participants(id),
        state TEXT NOT NULL CHECK (state IN ('requested','ready','integrating','integrated','integration_failed','revoking','revoked','failed','deleted')),
        repo_full_name TEXT,
        integration_repo TEXT,
        task_branch TEXT,
        base_sha TEXT,
        head_sha TEXT,
        last_error TEXT,
        credentials_issued INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revoked_at INTEGER,
        delete_after INTEGER
      )`,
      `CREATE INDEX workspaces_state ON workspaces(state)`,
      `CREATE TABLE usage_reports (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL REFERENCES participants(id),
        report_key TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        reservation_id TEXT REFERENCES reservations(id),
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_version TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        measurement TEXT NOT NULL CHECK (measurement IN ('reported_actual','estimated','unknown')),
        method TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low','none')),
        created_at INTEGER NOT NULL,
        UNIQUE (participant_id, report_key)
      )`,
      `CREATE INDEX usage_reports_task ON usage_reports(task_id)`,
      `CREATE TABLE commits (
        repo TEXT NOT NULL,
        sha TEXT NOT NULL,
        participant_id TEXT,
        task_id TEXT,
        source TEXT NOT NULL CHECK (source IN ('github_push','completion_head')),
        at INTEGER NOT NULL,
        PRIMARY KEY (repo, sha)
      )`,
      `CREATE TABLE meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)`,
      `CREATE TABLE rate_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)`,
      `CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        actor TEXT,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    name: 'google_links',
    statements: [
      // One-time codes that let an anonymous participant attach a Google identity to the SAME token.
      `CREATE TABLE google_links (
        code_hash TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL REFERENCES participants(id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      )`,
    ],
  },
  {
    version: 3,
    name: 'upstream_reconciliation',
    statements: [
      // Last observed state of each ORIGINAL repository. A failed check never overwrites the last good snapshot.
      `CREATE TABLE upstream_repos (
        repo TEXT PRIMARY KEY,
        branch TEXT,               -- tracked branch: UPSTREAM_BRANCHES override, else the default branch
        default_branch TEXT,
        head_sha TEXT,
        head_committed_at TEXT,
        head_message TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        last_success_at INTEGER,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        next_check_after INTEGER
      )`,
      // Per task: automatic signals/evidence against the upstream, plus the planner verdict currently in force.
      `CREATE TABLE upstream_task_checks (
        task_id TEXT PRIMARY KEY,
        upstream_repo TEXT,
        auto_status TEXT NOT NULL,
        auto_reasons_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        baseline_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        basis_sha TEXT,
        checked_at INTEGER NOT NULL,
        changed_at INTEGER NOT NULL,
        verdict_id TEXT
      )`,
      // Append-only history of planner verdicts (never deleted or edited).
      `CREATE TABLE upstream_verdicts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('valid','resolved_upstream','obsolete','partially_met','needs_replan')),
        basis_sha TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX upstream_verdicts_task ON upstream_verdicts(task_id, created_at)`,
      `CREATE TABLE upstream_http_cache (url TEXT PRIMARY KEY, etag TEXT, body_json TEXT NOT NULL, fetched_at INTEGER NOT NULL)`,
    ],
  },
];

export function migrate(store) {
  store.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const applied = new Set(store.all('SELECT version FROM schema_migrations').map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    store.tx(() => {
      for (const s of m.statements) store.exec(s);
      store.exec('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, Date.now());
    });
  }
}
