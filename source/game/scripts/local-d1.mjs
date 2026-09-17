import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
export function openDatabase(filename = ':memory:', migrations = new URL('../drizzle/', import.meta.url)) {
  const sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  sqlite.exec('CREATE TABLE IF NOT EXISTS _local_migrations(name TEXT PRIMARY KEY)');
  for (const name of readdirSync(migrations).filter(x => x.endsWith('.sql')).sort()) {
    if (sqlite.prepare('SELECT 1 FROM _local_migrations WHERE name=?').get(name)) continue;
    sqlite.exec('BEGIN IMMEDIATE');
    try { sqlite.exec(readFileSync(new URL(name, migrations), 'utf8')); sqlite.prepare('INSERT INTO _local_migrations VALUES (?)').run(name); sqlite.exec('COMMIT'); } catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  }
  function prepare(sql) {
    let bindings = [];
    const out = {
      bind(...values) { bindings = values; return out; },
      async first(column) { const row = sqlite.prepare(sql).get(...bindings); return row ? (column ? row[column] : { ...row }) : null; },
      async all() { return { results: sqlite.prepare(sql).all(...bindings).map(x => ({ ...x })), success: true }; },
      async run() { const r = sqlite.prepare(sql).run(...bindings); return { success: true, meta: { changes: Number(r.changes) } }; },
      execute() { const r = sqlite.prepare(sql).run(...bindings); return { success: true, meta: { changes: Number(r.changes) } }; },
    }; return out;
  }
  return { prepare, async batch(statements) { sqlite.exec('BEGIN IMMEDIATE'); try { const results = statements.map(s => s.execute()); sqlite.exec('COMMIT'); return results; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, close() { sqlite.close(); }, sqlite };
}
