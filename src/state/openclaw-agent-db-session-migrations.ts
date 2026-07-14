import type { DatabaseSync } from "node:sqlite";

export function readSqliteTableColumns(db: DatabaseSync, tableName: string): Set<string> | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`invalid SQLite table identifier: ${tableName}`);
  }
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  if (!table) {
    return null;
  }
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name?: unknown;
  }>;
  return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

export function migrateSessionEntryStatusProjection(
  db: DatabaseSync,
  readStatus: (entryJson: unknown) => string | null,
): void {
  const columns = readSqliteTableColumns(db, "session_entries");
  if (!columns) {
    return;
  }
  if (!columns.has("status")) {
    db.exec(
      "ALTER TABLE session_entries ADD COLUMN status TEXT CHECK (status IS NULL OR status IN ('running', 'done', 'failed', 'killed', 'timeout'));",
    );
  }
  const rows = db.prepare("SELECT session_key, entry_json FROM session_entries").all() as Array<{
    entry_json?: unknown;
    session_key?: unknown;
  }>;
  const update = db.prepare("UPDATE session_entries SET status = ? WHERE session_key = ?");
  for (const row of rows) {
    if (typeof row.session_key === "string") {
      update.run(readStatus(row.entry_json), row.session_key);
    }
  }
}
