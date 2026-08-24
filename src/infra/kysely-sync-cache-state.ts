// Shared per-database Kysely cache state, split from kysely-sync so lifecycle
// owners (sqlite-transaction) can clear caches without value-loading kysely.
// Doctor/setup closures cold-load transaction consumers; keep this file
// dependency-free beyond node:sqlite types.
import type { DatabaseSync } from "node:sqlite";

export const kyselyByDatabase = new WeakMap<DatabaseSync, unknown>();
export const queryErrorHandlerByDatabase = new WeakMap<DatabaseSync, (error: unknown) => void>();
// Cached statements retain their database. Per-instance lifecycle wrappers clear
// both caches before the native database handle closes.
export const statementCacheSymbol = Symbol("openclaw.kyselySyncStatementCache");

/** Drop cached Kysely state for a DatabaseSync. */
export function clearNodeSqliteKyselyCacheForDatabase(db: DatabaseSync): void {
  // Delete the database-owned cache before close so statements release their
  // native database backreferences instead of recreating the WeakMap leak.
  delete (db as DatabaseSync & { [statementCacheSymbol]?: unknown })[statementCacheSymbol];
  kyselyByDatabase.delete(db);
  queryErrorHandlerByDatabase.delete(db);
}
