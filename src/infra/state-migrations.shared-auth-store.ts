// Doctor-owned staged relocation of legacy shared auth rows into shared SQLite state.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  noteCommittedSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnership,
  SHARED_AUTH_STORE_STATE_KEY,
} from "../agents/auth-profiles/path-resolve.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import {
  closeAuthProfileReadPool,
  resolveAuthProfileDatabaseOwnerId,
} from "../agents/auth-profiles/sqlite.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabaseByPath,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists as sqliteTableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import type { SharedAuthStoreMigrationDetection } from "./state-migrations.shared-auth-store.types.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const MIGRATION_KIND = "shared-auth-store-state-db";
const AUTH_JSON_MIGRATION_KIND = "auth-profile-json-to-sqlite-v2";
const SOURCE_STORE_KEY = "primary";
const TARGET_STORE_KEY = "shared";

type SourceAuthDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "auth_profile_store" | "auth_profile_state"
>;
type SharedAuthMigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "auth_profile_stores"
  | "auth_profile_state"
  | "config_machine_state"
  | "migration_runs"
  | "migration_sources"
>;

type StoreRow = { store_json: string; updated_at: number };
type StateRow = { state_json: string; updated_at: number };
type AuthRows = { store: StoreRow | null; state: StateRow | null };
type MigrationStage = "copied" | "ownership-flipped" | "completed";

class SharedAuthStoreSourceInspectionError extends Error {
  readonly code = "SHARED_AUTH_STORE_SOURCE_UNREADABLE" as const;
  readonly action = "openclaw doctor --fix" as const;
  readonly sourcePath: string;

  constructor(sourcePath: string, operation: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Cannot ${operation} legacy shared auth database ${sourcePath}: ${detail}`, { cause });
    this.name = "SharedAuthStoreSourceInspectionError";
    this.sourcePath = sourcePath;
  }
}

function sourceMigrationKey(sourcePath: string, sourceTable: string): string {
  return `shared-auth-store:${createHash("sha256")
    .update(path.resolve(sourcePath))
    .update("\0")
    .update(sourceTable)
    .digest("hex")}`;
}

function inspectSourceFile(
  sourcePath: string,
): { status: "missing" } | { status: "present"; size: number } {
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    throw new SharedAuthStoreSourceInspectionError(sourcePath, "inspect", error);
  }
  let target = entry;
  if (entry.isSymbolicLink()) {
    try {
      target = fs.statSync(sourcePath);
    } catch (error) {
      throw new SharedAuthStoreSourceInspectionError(sourcePath, "resolve", error);
    }
  }
  if (!target.isFile()) {
    throw new SharedAuthStoreSourceInspectionError(
      sourcePath,
      "open",
      new Error("path is not a regular file"),
    );
  }
  return { status: "present", size: target.size };
}

function readSourceRowsFromDatabase(database: DatabaseSync): AuthRows {
  const db = getNodeSqliteKysely<SourceAuthDatabase>(database);
  const store = sqliteTableExists(database, "auth_profile_store")
    ? (executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("auth_profile_store")
          .select(["store_json", "updated_at"])
          .where("store_key", "=", SOURCE_STORE_KEY),
      ) ?? null)
    : null;
  const state = sqliteTableExists(database, "auth_profile_state")
    ? (executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("auth_profile_state")
          .select(["state_json", "updated_at"])
          .where("state_key", "=", SOURCE_STORE_KEY),
      ) ?? null)
    : null;
  return { store, state };
}

function inspectSourceRowsReadOnly(sourcePath: string): AuthRows {
  const source = inspectSourceFile(sourcePath);
  if (source.status === "missing") {
    return { store: null, state: null };
  }
  let database: DatabaseSync;
  try {
    database = openNodeSqliteDatabase(sourcePath, { readOnly: true });
  } catch (error) {
    throw new SharedAuthStoreSourceInspectionError(sourcePath, "open", error);
  }
  try {
    return readSourceRowsFromDatabase(database);
  } catch (error) {
    throw new SharedAuthStoreSourceInspectionError(sourcePath, "read", error);
  } finally {
    database.close();
  }
}

function readSourceSnapshot(params: { env: NodeJS.ProcessEnv; sourcePath: string }): {
  rows: AuthRows;
  size: number | null;
} {
  const source = inspectSourceFile(params.sourcePath);
  if (source.status === "missing") {
    return { rows: { store: null, state: null }, size: null };
  }
  try {
    const rows = runOpenClawAgentWriteTransaction(
      ({ db }) => readSourceRowsFromDatabase(db),
      {
        agentId: resolveAuthProfileDatabaseOwnerId(path.dirname(params.sourcePath)),
        path: params.sourcePath,
        env: params.env,
      },
      { operationLabel: "state-migration.shared-auth-source-read" },
    );
    closeAuthProfileReadPool({ kind: "database", databasePath: params.sourcePath });
    closeOpenClawAgentDatabaseByPath(params.sourcePath);
    return { rows, size: fs.statSync(params.sourcePath).size };
  } catch (error) {
    throw new SharedAuthStoreSourceInspectionError(params.sourcePath, "read", error);
  }
}

function readTargetRows(database: DatabaseSync): AuthRows {
  const db = getNodeSqliteKysely<SharedAuthMigrationDatabase>(database);
  return {
    store:
      executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("auth_profile_stores")
          .select(["store_json", "updated_at"])
          .where("store_key", "=", TARGET_STORE_KEY),
      ) ?? null,
    state:
      executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("auth_profile_state")
          .select(["state_json", "updated_at"])
          .where("store_key", "=", TARGET_STORE_KEY),
      ) ?? null,
  };
}

function rowDigest(row: StoreRow | StateRow | null): string {
  return createHash("sha256").update(JSON.stringify(row)).digest("hex");
}

function rowsMatch<T extends StoreRow | StateRow>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertRowsMatch(expected: AuthRows, actual: AuthRows, label: string): void {
  if (
    (expected.store !== null &&
      (actual.store === null || !rowsMatch(expected.store, actual.store))) ||
    (expected.state !== null && (actual.state === null || !rowsMatch(expected.state, actual.state)))
  ) {
    throw new Error(`shared auth relocation ${label} verification failed`);
  }
}

function migrationRunId(rows: AuthRows): string {
  return `shared-auth-store:${createHash("sha256")
    .update(rowDigest(rows.store))
    .update(rowDigest(rows.state))
    .digest("hex")
    .slice(0, 24)}`;
}

function recordMigrationLedger(params: {
  database: DatabaseSync;
  sourcePath: string;
  sourceSize: number | null;
  rows: AuthRows;
  stage: MigrationStage;
  now: number;
}): void {
  const db = getNodeSqliteKysely<SharedAuthMigrationDatabase>(params.database);
  const runId = migrationRunId(params.rows);
  const removedSource = params.stage === "completed" ? 1 : 0;
  const runReport = JSON.stringify({
    source: MIGRATION_KIND,
    target: "auth_profile_stores,auth_profile_state",
    stage: params.stage,
    importedRecordCount: Number(params.rows.store !== null) + Number(params.rows.state !== null),
  });
  executeSqliteQuerySync(
    params.database,
    db
      .insertInto("migration_runs")
      .values({
        id: runId,
        started_at: params.now,
        finished_at: params.stage === "completed" ? params.now : null,
        status: params.stage,
        report_json: runReport,
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          finished_at: params.stage === "completed" ? params.now : null,
          status: params.stage,
          report_json: runReport,
        }),
      ),
  );
  for (const entry of [
    {
      sourceTable: "auth_profile_store",
      targetTable: "auth_profile_stores",
      row: params.rows.store,
    },
    {
      sourceTable: "auth_profile_state",
      targetTable: "auth_profile_state",
      row: params.rows.state,
    },
  ] as const) {
    const reportJson = JSON.stringify({
      source: entry.sourceTable,
      target: entry.targetTable,
      stage: params.stage,
      sourceSha256: rowDigest(entry.row),
      importedRecordCount: entry.row ? 1 : 0,
    });
    executeSqliteQuerySync(
      params.database,
      db
        .insertInto("migration_sources")
        .values({
          source_key: sourceMigrationKey(params.sourcePath, entry.sourceTable),
          migration_kind: MIGRATION_KIND,
          source_path: params.sourcePath,
          target_table: entry.targetTable,
          source_sha256: rowDigest(entry.row),
          source_size_bytes: params.sourceSize,
          source_record_count: entry.row ? 1 : 0,
          last_run_id: runId,
          status: params.stage,
          imported_at: params.now,
          removed_source: removedSource,
          report_json: reportJson,
        })
        .onConflict((conflict) =>
          conflict.column("source_key").doUpdateSet({
            source_sha256: rowDigest(entry.row),
            source_size_bytes: params.sourceSize,
            source_record_count: entry.row ? 1 : 0,
            last_run_id: runId,
            status: params.stage,
            imported_at: params.now,
            removed_source: removedSource,
            report_json: reportJson,
          }),
        ),
    );
  }
}

function rewriteAuthJsonMigrationReceipts(
  database: DatabaseSync,
  sourceDatabasePath: string,
  targetDatabasePath: string,
): void {
  const db = getNodeSqliteKysely<SharedAuthMigrationDatabase>(database);
  const receipts = executeSqliteQuerySync(
    database,
    db
      .selectFrom("migration_sources")
      .select(["source_key", "last_run_id", "target_table", "report_json"])
      .where("migration_kind", "=", AUTH_JSON_MIGRATION_KIND),
  ).rows;
  for (const receipt of receipts) {
    let report: Record<string, unknown>;
    try {
      report = JSON.parse(receipt.report_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      typeof report.targetDatabasePath !== "string" ||
      path.resolve(report.targetDatabasePath) !== path.resolve(sourceDatabasePath) ||
      (receipt.target_table !== "auth_profile_store" &&
        receipt.target_table !== "auth_profile_state")
    ) {
      continue;
    }
    const targetTable =
      receipt.target_table === "auth_profile_store" ? "auth_profile_stores" : "auth_profile_state";
    const reportJson = JSON.stringify({
      ...report,
      relocatedFromDatabasePath: report.targetDatabasePath,
      targetDatabasePath,
      targetTable,
      targetStoreKey: TARGET_STORE_KEY,
    });
    executeSqliteQuerySync(
      database,
      db
        .updateTable("migration_sources")
        .set({ target_table: targetTable, report_json: reportJson })
        .where("source_key", "=", receipt.source_key),
    );
    executeSqliteQuerySync(
      database,
      db
        .updateTable("migration_runs")
        .set({ report_json: reportJson })
        .where("id", "=", receipt.last_run_id),
    );
  }
}

function copyRowsToState(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  sourceSize: number | null;
  sourceRows: AuthRows;
  now: number;
}): AuthRows {
  return runOpenClawStateWriteTransaction(
    ({ db: database, path: targetDatabasePath }) => {
      const db = getNodeSqliteKysely<SharedAuthMigrationDatabase>(database);
      const target = readTargetRows(database);
      if (
        params.sourceRows.store &&
        target.store &&
        !rowsMatch(params.sourceRows.store, target.store)
      ) {
        throw new Error("shared auth credential rows conflict with the relocation target");
      }
      if (
        params.sourceRows.state &&
        target.state &&
        !rowsMatch(params.sourceRows.state, target.state)
      ) {
        throw new Error("shared auth state rows conflict with the relocation target");
      }
      if (params.sourceRows.store && !target.store) {
        executeSqliteQuerySync(
          database,
          db.insertInto("auth_profile_stores").values({
            store_key: TARGET_STORE_KEY,
            store_json: params.sourceRows.store.store_json,
            updated_at: params.sourceRows.store.updated_at,
          }),
        );
      }
      if (params.sourceRows.state && !target.state) {
        executeSqliteQuerySync(
          database,
          db.insertInto("auth_profile_state").values({
            store_key: TARGET_STORE_KEY,
            state_json: params.sourceRows.state.state_json,
            updated_at: params.sourceRows.state.updated_at,
          }),
        );
      }
      const canonicalRows = readTargetRows(database);
      assertRowsMatch(params.sourceRows, canonicalRows, "copy");
      rewriteAuthJsonMigrationReceipts(database, params.sourcePath, targetDatabasePath);
      recordMigrationLedger({
        database,
        sourcePath: params.sourcePath,
        sourceSize: params.sourceSize,
        rows: canonicalRows,
        stage: "copied",
        now: params.now,
      });
      return canonicalRows;
    },
    { env: params.env },
    { operationLabel: "state-migration.shared-auth-copy" },
  );
}

function flipOwnership(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  sourceSize: number | null;
  rows: AuthRows;
  now: number;
}): boolean {
  const flipped = resolveSharedAuthStoreOwnership(params.env).location !== "state-db";
  runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      assertRowsMatch(params.rows, readTargetRows(database), "ownership");
      const db = getNodeSqliteKysely<SharedAuthMigrationDatabase>(database);
      executeSqliteQuerySync(
        database,
        db
          .insertInto("config_machine_state")
          .values({
            state_key: SHARED_AUTH_STORE_STATE_KEY,
            value_json: JSON.stringify({ location: "state-db" }),
            updated_at_ms: params.now,
          })
          .onConflict((conflict) =>
            conflict.column("state_key").doUpdateSet({
              value_json: JSON.stringify({ location: "state-db" }),
              updated_at_ms: params.now,
            }),
          ),
      );
      recordMigrationLedger({ ...params, database, stage: "ownership-flipped" });
    },
    { env: params.env },
    { operationLabel: "state-migration.shared-auth-ownership" },
  );
  noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, params.env);
  return flipped;
}

function cleanupSourceRows(params: { env: NodeJS.ProcessEnv; sourcePath: string }): boolean {
  if (inspectSourceFile(params.sourcePath).status === "missing") {
    return false;
  }
  try {
    const removed = runOpenClawAgentWriteTransaction(
      ({ db: database }) => {
        const db = getNodeSqliteKysely<SourceAuthDatabase>(database);
        const before = readSourceRowsFromDatabase(database);
        executeSqliteQuerySync(
          database,
          db.deleteFrom("auth_profile_store").where("store_key", "=", SOURCE_STORE_KEY),
        );
        executeSqliteQuerySync(
          database,
          db.deleteFrom("auth_profile_state").where("state_key", "=", SOURCE_STORE_KEY),
        );
        const after = readSourceRowsFromDatabase(database);
        if (after.store || after.state) {
          throw new Error("legacy shared auth rows remain after cleanup");
        }
        return before.store !== null || before.state !== null;
      },
      {
        agentId: resolveAuthProfileDatabaseOwnerId(path.dirname(params.sourcePath)),
        path: params.sourcePath,
        env: params.env,
      },
      { operationLabel: "state-migration.shared-auth-cleanup" },
    );
    closeAuthProfileReadPool({ kind: "database", databasePath: params.sourcePath });
    closeOpenClawAgentDatabaseByPath(params.sourcePath);
    return removed;
  } catch (error) {
    throw new SharedAuthStoreSourceInspectionError(params.sourcePath, "clean", error);
  }
}

function finalizeMigration(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  sourceSize: number | null;
  rows: AuthRows;
  now: number;
}): void {
  runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      assertRowsMatch(params.rows, readTargetRows(database), "cleanup");
      recordMigrationLedger({ ...params, database, stage: "completed" });
    },
    { env: params.env },
    { operationLabel: "state-migration.shared-auth-finalize" },
  );
}

function hasPendingCleanup(env: NodeJS.ProcessEnv, sourcePath: string): boolean {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db: database }) => {
        const db = getNodeSqliteKysely<SharedAuthMigrationDatabase>(database);
        const row = executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("migration_sources")
            .select("source_key")
            .where("migration_kind", "=", MIGRATION_KIND)
            .where("source_path", "=", sourcePath)
            .where("removed_source", "=", 0)
            .limit(1),
        );
        return Boolean(row);
      },
      { env },
    ) ?? false
  );
}

/** Detect relocation or unfinished cleanup only in the explicit Doctor repair path. */
export function detectSharedAuthStoreMigration(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): SharedAuthStoreMigrationDetection {
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const sourcePath = path.join(resolveSharedMainAuthAgentDir(env), "openclaw-agent.sqlite");
  if (params.doctorOnlyStateMigrations !== true) {
    return { sourcePath, hasLegacy: false };
  }
  const ownership = resolveSharedAuthStoreOwnership(env);
  const sourceRows = inspectSourceRowsReadOnly(sourcePath);
  return {
    sourcePath,
    hasLegacy:
      ownership.location === "legacy-main" ||
      sourceRows.store !== null ||
      sourceRows.state !== null ||
      hasPendingCleanup(env, sourcePath),
  };
}

/** Converge copy, ownership, and cleanup while excluding live Gateway writers. */
export async function migrateSharedAuthStore(params: {
  detected: SharedAuthStoreMigrationDetection;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}): Promise<MigrationMessages> {
  if (!params.detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  return await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "legacy shared auth store",
    releaseLabel: "Shared auth store",
    errorLabel: "Failed relocating the shared auth store",
    run: async (env) => {
      const now = params.now?.() ?? Date.now();
      const source = readSourceSnapshot({ env, sourcePath: params.detected.sourcePath });
      const rows = copyRowsToState({
        env,
        sourcePath: params.detected.sourcePath,
        sourceSize: source.size,
        sourceRows: source.rows,
        now,
      });
      const ownershipFlipped = flipOwnership({
        env,
        sourcePath: params.detected.sourcePath,
        sourceSize: source.size,
        rows,
        now,
      });
      const sourceCleaned = cleanupSourceRows({ env, sourcePath: params.detected.sourcePath });
      const relocatedRows = rows.store !== null || rows.state !== null || sourceCleaned;
      finalizeMigration({
        env,
        sourcePath: params.detected.sourcePath,
        sourceSize: source.size,
        rows,
        now,
      });
      return {
        changes: [
          ...(ownershipFlipped && relocatedRows
            ? ["Relocated shared auth profiles into shared SQLite state."]
            : []),
          ...(sourceCleaned && !ownershipFlipped
            ? ["Completed legacy shared auth row cleanup."]
            : []),
        ],
        warnings: [],
        ...(ownershipFlipped && rows.store !== null
          ? {
              notices: ["The main agent no longer owns shared credentials and can now be deleted."],
            }
          : {}),
      };
    },
  });
}
