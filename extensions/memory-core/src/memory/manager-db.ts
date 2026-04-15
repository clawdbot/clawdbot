import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ensureDir, requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export function openMemoryDatabaseAtPath(dbPath: string, allowExtension: boolean): DatabaseSync {
  const dir = path.dirname(dbPath);
  ensureDir(dir);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath, { allowExtension });
  // busy_timeout is per-connection and resets to 0 on restart.
  // Set it on every open so concurrent processes retry instead of
  // failing immediately with SQLITE_BUSY.
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
