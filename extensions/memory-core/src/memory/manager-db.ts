// Memory Core plugin module implements manager db behavior.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import {
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  dropMemoryPathFtsTriggers,
  ensureDir,
  ensureMemoryChunkProvenance,
  ensureMemoryIndexSchema,
  ensureMemoryRecallMetadataSchema,
  ensureMemoryPathFtsTriggers,
  loadSqliteVecExtension,
  MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
  MEMORY_INDEX_PATHS_FTS_TABLE,
  MEMORY_INDEX_DERIVED_TABLES,
  MEMORY_INDEX_STATE_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  openOpenClawAgentDatabaseReadOnly,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  ensureOpenClawAgentDatabaseSchema,
  openNodeSqliteDatabase,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { withMemoryWorkspaceLock } from "../memory-workspace-lock.js";
import { waitForMemoryReindexLock } from "./manager-reindex-lock.js";
import { markMemoryVectorIndexClean } from "./manager-vector-rebuild-state.js";

const MEMORY_REINDEX_SCHEMA = "memory_reindex";
const MEMORY_INDEX_STATE_ID = 1;
const READ_ONLY_MEMORY_DATABASES = new WeakMap<DatabaseSync, () => void>();
const MEMORY_DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
const MEMORY_REINDEX_ENTRY_SUFFIXES = ["-wal", "-shm", "-journal", ""] as const;
const MEMORY_REINDEX_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEMORY_DATABASE_REMOVE_ATTEMPTS = 10;
const MEMORY_DATABASE_REMOVE_RETRY_MS = 50;
const TRANSIENT_FILE_ERROR_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

function resolveMemoryReindexBaseName(
  databaseBaseName: string,
  entryName: string,
): string | undefined {
  for (const suffix of MEMORY_REINDEX_ENTRY_SUFFIXES) {
    if (!entryName.endsWith(suffix)) {
      continue;
    }
    const baseName = entryName.slice(0, entryName.length - suffix.length);
    const prefix = `${databaseBaseName}.memory-reindex-`;
    if (
      baseName.startsWith(prefix) &&
      MEMORY_REINDEX_UUID_PATTERN.test(baseName.slice(prefix.length))
    ) {
      return baseName;
    }
  }
  return undefined;
}

function tableExists(db: DatabaseSync, schema: string, tableName: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { ok?: unknown } | undefined;
  return row?.ok === 1;
}

export { tableExists as memoryDatabaseTableExists };

function readTableSql(db: DatabaseSync, schema: string, tableName: string): string | null {
  const row = db
    .prepare(`SELECT sql FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { sql?: unknown } | undefined;
  return typeof row?.sql === "string" && row.sql.trim() ? row.sql : null;
}

function hasSqliteVecExtension(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("SELECT vec_version() AS version").get() as
      | { version?: unknown }
      | undefined;
    return typeof row?.version === "string" && row.version.trim().length > 0;
  } catch {
    return false;
  }
}

export function readMemoryDatabaseRevision(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT revision FROM memory_index_state WHERE id = ?")
    .get(MEMORY_INDEX_STATE_ID) as { revision?: unknown } | undefined;
  if (typeof row?.revision !== "number" || !Number.isSafeInteger(row.revision)) {
    throw new Error("Memory index revision is missing or invalid");
  }
  return row.revision;
}

export class MemoryIndexRevisionConflictError extends Error {}

/** Reset derived content without replacing the shared agent database or its schema. */
export async function resetMemoryDatabase(params: {
  targetDb: DatabaseSync;
  dbPath: string;
  workspaceDir: string;
  vectorExtensionPath?: string;
}): Promise<boolean> {
  const db = params.targetDb;
  const lock = await waitForMemoryReindexLock(params.dbPath);
  try {
    return await withMemoryWorkspaceLock(params.workspaceDir, async () => {
      if (tableExists(db, "main", MEMORY_INDEX_VECTOR_TABLE) && !hasSqliteVecExtension(db)) {
        const loaded = await loadSqliteVecExtension({
          db,
          extensionPath: params.vectorExtensionPath,
        });
        if (!loaded.ok) {
          throw new Error(
            `Memory reset requires sqlite-vec to clear the vector index: ${loaded.error}`,
          );
        }
      }
      return runSqliteImmediateTransactionSync(db, () => {
        const tables = MEMORY_INDEX_DERIVED_TABLES.filter((table) =>
          tableExists(db, "main", table),
        );
        if (
          !tables.some(
            (table) =>
              table !== MEMORY_INDEX_STATE_TABLE &&
              db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get(),
          )
        ) {
          return false;
        }
        const revision = readMemoryDatabaseRevision(db);
        const schema = tables.flatMap(
          (table) =>
            db
              .prepare(
                "SELECT type, name, sql FROM main.sqlite_schema WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY name",
              )
              // SAFETY: SQLite's catalog has text type/name/sql; the query excludes null SQL.
              .all(table) as Array<{ type: string; name: string; sql: string }>,
        );
        // Drop triggers before their targets; recreate every table before its indexes/triggers.
        // Keeping exact FTS/vector definitions also protects already-open manager handles.
        for (const entry of schema.filter((candidate) => candidate.type === "trigger")) {
          db.exec(`DROP TRIGGER "${entry.name.replaceAll('"', '""')}"`);
        }
        for (const table of tables) {
          db.exec(`DROP TABLE main.${table}`);
        }
        for (const type of ["table", "index", "trigger"]) {
          for (const entry of schema.filter((candidate) => candidate.type === type)) {
            db.exec(entry.sql);
          }
        }
        // Missing metadata requests a rebuild; never reuse an old revision (ABA).
        db.prepare(`INSERT INTO ${MEMORY_INDEX_STATE_TABLE} (id, revision) VALUES (?, ?)`).run(
          MEMORY_INDEX_STATE_ID,
          revision + 1,
        );
        return true;
      });
    });
  } finally {
    lock.release();
  }
}

function replaceVirtualTable(params: {
  db: DatabaseSync;
  tableName: "memory_index_chunks_fts" | "memory_index_chunks_vec";
  columns: string;
  ignoreDropErrorWhenSourceMissing?: boolean;
}): void {
  const { db, tableName, columns } = params;
  const createSql = readTableSql(db, MEMORY_REINDEX_SCHEMA, tableName);
  if (!createSql) {
    try {
      db.exec(`DROP TABLE IF EXISTS main.${tableName}`);
    } catch (err) {
      if (!params.ignoreDropErrorWhenSourceMissing) {
        throw err;
      }
    }
    return;
  }
  db.exec(`DROP TABLE IF EXISTS main.${tableName}`);
  db.exec(createSql);
  db.exec(
    `INSERT INTO main.${tableName} (${columns}) ` +
      `SELECT ${columns} FROM ${MEMORY_REINDEX_SCHEMA}.${tableName}`,
  );
}

function replaceMemoryPathFtsTable(db: DatabaseSync): void {
  const createSql = readTableSql(db, MEMORY_REINDEX_SCHEMA, MEMORY_INDEX_PATHS_FTS_TABLE);
  db.exec(`DROP TABLE IF EXISTS main.${MEMORY_INDEX_PATHS_FTS_TABLE}`);
  if (!createSql) {
    return;
  }
  db.exec(createSql);
  // Bulk publication already suspends row triggers. Rebuild from the copied
  // stable source ids so later singleton deletes remain direct rowid lookups.
  db.exec(
    `INSERT INTO main.${MEMORY_INDEX_PATHS_FTS_TABLE} (rowid, path, source) ` +
      `SELECT id, path, source FROM main.memory_index_sources`,
  );
}

/** Publish a completed shadow memory index without replacing the shared agent database file. */
export async function publishMemoryDatabaseTables(params: {
  targetDb: DatabaseSync;
  sourcePath: string;
  metaKey: string;
  expectedRevision: number;
  vectorExtensionPath?: string;
  vectorIndexComplete?: boolean;
}): Promise<number> {
  ensureMemoryRecallMetadataSchema(params.targetDb);
  // Existing pre-provenance databases lack the provenance table the publish
  // below writes to; ensure it (idempotent) alongside the recall columns.
  ensureMemoryChunkProvenance(params.targetDb);
  params.targetDb.prepare(`ATTACH DATABASE ? AS ${MEMORY_REINDEX_SCHEMA}`).run(params.sourcePath);
  try {
    if (
      tableExists(params.targetDb, MEMORY_REINDEX_SCHEMA, "memory_index_chunks_vec") &&
      !hasSqliteVecExtension(params.targetDb)
    ) {
      const loaded = await loadSqliteVecExtension({
        db: params.targetDb,
        extensionPath: params.vectorExtensionPath,
      });
      if (!loaded.ok) {
        throw new Error(
          `Failed to load sqlite-vec before publishing the full memory reindex: ` +
            (loaded.error ?? "unknown sqlite-vec load error"),
        );
      }
    }
    return runSqliteImmediateTransactionSync(
      params.targetDb,
      () => {
        const liveRevision = readMemoryDatabaseRevision(params.targetDb);
        if (liveRevision !== params.expectedRevision) {
          throw new MemoryIndexRevisionConflictError(
            `Memory index changed while full reindex was building ` +
              `(expected revision ${params.expectedRevision}, found ${liveRevision}); retry the full reindex.`,
          );
        }
        const publishesPathFts = tableExists(
          params.targetDb,
          MEMORY_REINDEX_SCHEMA,
          MEMORY_INDEX_PATHS_FTS_TABLE,
        );
        // Bulk source replacement must not fire one FTS5 scan per old row.
        // Restore the schema-owned triggers only after the derived table is replaced.
        dropMemoryPathFtsTriggers(params.targetDb);
        params.targetDb
          .prepare("DELETE FROM main.memory_index_meta WHERE key = ?")
          .run(params.metaKey);
        params.targetDb
          .prepare(
            `INSERT INTO main.memory_index_meta (key, value)
           SELECT key, value FROM ${MEMORY_REINDEX_SCHEMA}.memory_index_meta WHERE key = ?`,
          )
          .run(params.metaKey);

        params.targetDb.exec(`
        DELETE FROM main.memory_index_sources;
        INSERT INTO main.memory_index_sources (id, path, source, hash, mtime, size)
        SELECT id, path, source, hash, mtime, size
        FROM ${MEMORY_REINDEX_SCHEMA}.memory_index_sources;

        DELETE FROM main.memory_index_chunks;
        INSERT INTO main.memory_index_chunks (
          id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
        )
        SELECT
          id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
        FROM ${MEMORY_REINDEX_SCHEMA}.memory_index_chunks;

        DELETE FROM main.${MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE};
        INSERT INTO main.${MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE} (
          chunk_id, importance, triggers, project_key
        )
        SELECT chunk_id, importance, triggers, project_key
        FROM ${MEMORY_REINDEX_SCHEMA}.${MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE};

        DELETE FROM main.memory_index_chunk_provenance;
        INSERT INTO main.memory_index_chunk_provenance (
          chunk_id, origin_class, session_kind, observed_at, supersedes_key
        )
        SELECT chunk_id, origin_class, session_kind, observed_at, supersedes_key
        FROM ${MEMORY_REINDEX_SCHEMA}.memory_index_chunk_provenance;
      `);

        replaceVirtualTable({
          db: params.targetDb,
          tableName: "memory_index_chunks_fts",
          columns: "text, id, path, source, model, start_line, end_line",
        });
        replaceMemoryPathFtsTable(params.targetDb);
        if (publishesPathFts) {
          ensureMemoryPathFtsTriggers(params.targetDb);
        }
        replaceVirtualTable({
          db: params.targetDb,
          tableName: "memory_index_chunks_vec",
          columns: "id, embedding",
          // A vector-disabled connection may not have sqlite-vec loaded and cannot
          // drop an old virtual table. Missing vector metadata forces a strict
          // rebuild before that table can be queried again.
          ignoreDropErrorWhenSourceMissing: true,
        });
        if (params.vectorIndexComplete) {
          markMemoryVectorIndexClean(params.targetDb);
        }
        return readMemoryDatabaseRevision(params.targetDb);
      },
      { operationLabel: "memory.index.publish" },
    );
  } finally {
    params.targetDb.exec(`DETACH DATABASE ${MEMORY_REINDEX_SCHEMA}`);
  }
}

async function removeMemoryDatabaseFile(filePath: string): Promise<void> {
  for (let attempt = 1; attempt <= MEMORY_DATABASE_REMOVE_ATTEMPTS; attempt += 1) {
    try {
      await fs.promises.rm(filePath, { force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!TRANSIENT_FILE_ERROR_CODES.has(code) || attempt === MEMORY_DATABASE_REMOVE_ATTEMPTS) {
        throw err;
      }
      await sleep(MEMORY_DATABASE_REMOVE_RETRY_MS * attempt);
    }
  }
}

/** Remove one closed shadow memory database and its journal-mode sidecars. */
export async function removeMemoryDatabaseFiles(dbPath: string): Promise<void> {
  for (const suffix of MEMORY_DATABASE_FILE_SUFFIXES) {
    await removeMemoryDatabaseFile(`${dbPath}${suffix}`);
  }
}

/** Remove crash-left shadows while the caller owns the exclusive reindex lease. */
export async function cleanupMemoryReindexTempFiles(dbPath: string): Promise<void> {
  const dir = path.dirname(dbPath);
  const databaseBaseName = path.basename(dbPath);
  const shadowBaseNames = new Set<string>();
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const shadowBaseName = resolveMemoryReindexBaseName(databaseBaseName, entry.name);
    if (shadowBaseName) {
      shadowBaseNames.add(shadowBaseName);
    }
  }

  for (const shadowBaseName of shadowBaseNames) {
    await removeMemoryDatabaseFiles(path.join(dir, shadowBaseName));
  }
}

export function openMemoryDatabaseAtPath(
  dbPath: string,
  allowExtension: boolean,
  agentId?: string,
): DatabaseSync {
  ensureDir(path.dirname(dbPath));
  const db = openNodeSqliteDatabase(dbPath, { allowExtension });
  try {
    configureMemorySqliteWalMaintenance(db, {
      busyTimeoutMs: 5000,
      databasePath: dbPath,
    });
    if (agentId) {
      ensureOpenClawAgentDatabaseSchema(db, { agentId, path: dbPath, register: true });
    }
    return db;
  } catch (err) {
    try {
      closeMemorySqliteWalMaintenance(db);
      db.close();
    } catch {}
    throw err;
  }
}

function openUninitializedMemoryDatabase(allowExtension: boolean): DatabaseSync {
  const database = openNodeSqliteDatabase(":memory:", { allowExtension });
  try {
    ensureMemoryIndexSchema({ cacheEnabled: true, db: database, ftsEnabled: true });
    database.exec("PRAGMA query_only = ON");
    READ_ONLY_MEMORY_DATABASES.set(database, () => database.close());
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/** Open an existing memory index through the agent database query-only owner. */
export function openMemoryDatabaseReadOnlyAtPath(
  dbPath: string,
  allowExtension: boolean,
  agentId: string,
): DatabaseSync {
  const opened = openOpenClawAgentDatabaseReadOnly({ agentId, path: dbPath }, { allowExtension });
  if (!opened.found) {
    if (opened.reason === "database-missing") {
      return openUninitializedMemoryDatabase(allowExtension);
    }
    throw new Error(`Memory index database schema is missing: ${dbPath}`);
  }
  const { database } = opened;
  if (!tableExists(database.db, "main", MEMORY_INDEX_STATE_TABLE)) {
    database.close();
    return openUninitializedMemoryDatabase(allowExtension);
  }
  READ_ONLY_MEMORY_DATABASES.set(database.db, database.close);
  return database.db;
}

export function closeMemoryDatabase(db: DatabaseSync): void {
  const closeReadOnly = READ_ONLY_MEMORY_DATABASES.get(db);
  if (closeReadOnly) {
    READ_ONLY_MEMORY_DATABASES.delete(db);
    closeReadOnly();
    return;
  }
  closeMemorySqliteWalMaintenance(db);
  db.close();
}

export function isMemoryDatabaseReadOnly(db: DatabaseSync): boolean {
  return READ_ONLY_MEMORY_DATABASES.has(db);
}
