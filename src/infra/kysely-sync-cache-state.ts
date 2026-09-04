// Shared per-database Kysely cache state, split from kysely-sync so lifecycle
// owners (sqlite-transaction) can clear caches without value-loading kysely.
// Doctor/setup closures cold-load transaction consumers; keep this file
// independent of the Kysely value graph.
import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export const { kyselyByDatabase, queryErrorHandlerByDatabase } = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteKyselyCacheState"),
  () => ({
    kyselyByDatabase: new WeakMap<DatabaseSync, unknown>(),
    queryErrorHandlerByDatabase: new WeakMap<DatabaseSync, (error: unknown) => void>(),
  }),
);
// Cached statements retain their database. Per-instance lifecycle wrappers clear
// both caches before close, including callers from transformed SDK module graphs.
export const statementCacheSymbol = Symbol.for("openclaw.kyselySyncStatementCache");

/** Register the lifecycle owner's handler for synchronous Kysely query failures. */
export function registerNodeSqliteKyselyQueryErrorHandler(
  db: DatabaseSync,
  handler: (error: unknown) => void,
): void {
  queryErrorHandlerByDatabase.set(db, handler);
}

/** Drop cached Kysely state for a DatabaseSync. */
export function clearNodeSqliteKyselyCacheForDatabase(db: DatabaseSync): void {
  // Delete the database-owned cache before close so statements release their
  // native database backreferences instead of recreating the WeakMap leak.
  delete (db as DatabaseSync & { [statementCacheSymbol]?: unknown })[statementCacheSymbol];
  kyselyByDatabase.delete(db);
  queryErrorHandlerByDatabase.delete(db);
}
