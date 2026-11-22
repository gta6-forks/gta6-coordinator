// Store interface used by the services (synchronous, so a whole operation fits in one transaction):
//   exec(sql, ...params) -> { rowsWritten }
//   all(sql, ...params)  -> rows[]
//   one(sql, ...params)  -> row | null
//   tx(fn)               -> runs fn atomically (nested calls join the outer transaction)
//
// Production: Durable Object SQLite storage (ctx.storage.sql + ctx.storage.transactionSync).
// Tests: test/helpers/node-store.js implements the same interface over node:sqlite.

export function createDurableObjectStore(storage) {
  let depth = 0;
  const sql = storage.sql;
  return {
    exec(query, ...params) {
      const cursor = sql.exec(query, ...params);
      cursor.toArray();
      return { rowsWritten: cursor.rowsWritten };
    },
    all(query, ...params) {
      return sql.exec(query, ...params).toArray();
    },
    one(query, ...params) {
      return sql.exec(query, ...params).toArray()[0] ?? null;
    },
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      try {
        return storage.transactionSync(fn);
      } finally {
        depth--;
      }
    },
  };
}

export function isUniqueViolation(err) {
  return /UNIQUE constraint failed/i.test(String(err?.message ?? err));
}

export function recordEvent(store, now, actor, type, data = {}) {
  store.exec('INSERT INTO events (at, actor, type, data_json) VALUES (?, ?, ?, ?)', now, actor ?? null, type, JSON.stringify(data));
}

export function getMeta(store, key, fallback = null) {
  const row = store.one('SELECT value_json FROM meta WHERE key = ?', key);
  return row ? JSON.parse(row.value_json) : fallback;
}

export function setMeta(store, key, value) {
  store.exec(
    'INSERT INTO meta (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
    key,
    JSON.stringify(value),
  );
}
