/** Doctor-owned staged relocation of legacy shared auth rows into shared SQLite state. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  noteCommittedSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnership,
  SHARED_AUTH_STORE_STATE_KEY,
} from "../agents/auth-profiles/path-resolve.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import {
  hasPendingSharedAuthCleanup,
  inspectSharedAuthLegacyRowsReadOnly,
  inspectSharedAuthLegacySourceFile,
  readSharedAuthLegacyRowsFromDatabase,
  SharedAuthStoreSourceInspectionError,
  type SharedAuthLegacyRows as AuthRows,
  type SharedAuthLegacyStateRow as StateRow,
  type SharedAuthLegacyStoreRow as StoreRow,
} from "../agents/auth-profiles/shared-store-bootstrap.js";
import {
  closeAuthProfileReadPool,
  resolveAuthProfileDatabaseOwnerId,
} from "../agents/auth-profiles/sqlite.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabaseByPath,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import {
  recordLegacyMigrationRun,
  recordLegacyMigrationSource,
} from "./state-migrations.receipts.js";
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
  "config_machine_state" | "migration_runs" | "migration_sources"
>;

type MigrationStage = "copied" | "ownership-flipped" | "completed";

type MigrationSnapshot = {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  sourceSize: number | null;
  sourceRows: AuthRows;
  now: number;
};

function sourceMigrationKey(sourcePath: string, sourceTable: string): string {
  return `shared-auth-store:${createHash("sha256")
    .update(path.resolve(sourcePath))
    .update("\0")
    .update(sourceTable)
    .digest("hex")}`;
}

function readSourceSnapshot(params: { env: NodeJS.ProcessEnv; sourcePath: string }): {
  rows: AuthRows;
  size: number | null;
} {
  const source = inspectSharedAuthLegacySourceFile(params.sourcePath);
  if (source.status === "missing") {
    return { rows: { store: null, state: null }, size: null };
  }
  try {
    const rows = runOpenClawAgentWriteTransaction(
      ({ db }) => readSharedAuthLegacyRowsFromDatabase(db),
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
  const cells = executeSqliteQuerySync(
    database,
    db
      .selectFrom("config_machine_state")
      .select(["state_key", "value_json", "updated_at_ms"])
      .where("state_key", "in", ["authProfiles.store", "authProfiles.state"]),
  ).rows;
  const store = cells.find((cell) => cell.state_key === "authProfiles.store");
  const state = cells.find((cell) => cell.state_key === "authProfiles.state");
  // Preserve historical row shapes: persisted receipt digests include these field names.
  return {
    store: store ? { store_json: store.value_json, updated_at: store.updated_at_ms } : null,
    state: state ? { state_json: state.value_json, updated_at: state.updated_at_ms } : null,
  };
}

function rowDigest(row: StoreRow | StateRow | null): string {
  return createHash("sha256").update(JSON.stringify(row)).digest("hex");
}

function rowsMatch<T extends StoreRow | StateRow>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function storeIsContained(sourceRow: StoreRow, targetRow: StoreRow): boolean {
  try {
    const source: unknown = JSON.parse(sourceRow.store_json);
    const target: unknown = JSON.parse(targetRow.store_json);
    if (
      !isRecord(source) ||
      !isRecord(target) ||
      typeof source.version !== "number" ||
      !Number.isFinite(source.version) ||
      source.version <= 0 ||
      !isRecord(source.profiles) ||
      !isRecord(target.profiles)
    ) {
      return false;
    }
    const targetProfiles = target.profiles;
    // Compare raw records, not runtime coercion: dropping malformed entries or unknown
    // fields would falsely certify that the only remaining copy can be deleted.
    return (
      isDeepStrictEqual({ ...source, profiles: targetProfiles }, target) &&
      Object.values(targetProfiles).every(isRecord) &&
      Object.entries(source.profiles).every(
        ([id, credential]) =>
          isRecord(credential) &&
          Object.hasOwn(targetProfiles, id) &&
          isDeepStrictEqual(credential, targetProfiles[id]),
      )
    );
  } catch {
    return false;
  }
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

function recordMigrationLedger(
  params: Omit<MigrationSnapshot, "env"> & {
    database: DatabaseSync;
    stage: MigrationStage;
  },
): void {
  const db = getNodeSqliteKysely<SharedAuthMigrationDatabase>(params.database);
  const entries = [
    {
      sourceTable: "auth_profile_store",
      targetTable: "auth_profile_stores",
      row: params.sourceRows.store,
    },
    {
      sourceTable: "auth_profile_state",
      targetTable: "auth_profile_state",
      row: params.sourceRows.state,
    },
  ].map((entry) => {
    const sourceKey = sourceMigrationKey(params.sourcePath, entry.sourceTable);
    // A crash after source cleanup leaves only the receipt as source evidence.
    // Never replace that evidence with a digest of the richer destination.
    const pending = entry.row
      ? undefined
      : executeSqliteQueryTakeFirstSync(
          params.database,
          db
            .selectFrom("migration_sources")
            .select(["source_sha256", "source_record_count", "source_size_bytes"])
            .where("source_key", "=", sourceKey)
            .where("removed_source", "=", 0),
        );
    return Object.assign(entry, {
      sourceKey,
      sourceSha256: pending?.source_sha256 ?? rowDigest(entry.row),
      sourceRecordCount: pending?.source_record_count ?? Number(entry.row !== null),
      sourceSizeBytes: pending?.source_size_bytes ?? params.sourceSize,
    });
  });
  const runHash = createHash("sha256");
  for (const entry of entries) {
    runHash.update(entry.sourceSha256);
  }
  const runId = `shared-auth-store:${runHash.digest("hex").slice(0, 24)}`;
  recordLegacyMigrationRun(params.database, {
    runId,
    startedAt: params.now,
    finishedAt: params.stage === "completed" ? params.now : null,
    status: params.stage,
    reportJson: JSON.stringify({
      source: MIGRATION_KIND,
      target: "auth_profile_stores,auth_profile_state",
      stage: params.stage,
      importedRecordCount: entries.reduce((count, entry) => count + entry.sourceRecordCount, 0),
    }),
    upsert: true,
  });
  for (const entry of entries) {
    recordLegacyMigrationSource(params.database, {
      sourceKey: entry.sourceKey,
      migrationKind: MIGRATION_KIND,
      sourcePath: params.sourcePath,
      targetTable: entry.targetTable,
      sourceSha256: entry.sourceSha256,
      sourceSizeBytes: entry.sourceSizeBytes,
      sourceRecordCount: entry.sourceRecordCount,
      runId,
      status: params.stage,
      importedAt: params.now,
      reportJson: JSON.stringify({
        source: entry.sourceTable,
        target: entry.targetTable,
        stage: params.stage,
        sourceSha256: entry.sourceSha256,
        importedRecordCount: entry.sourceRecordCount,
      }),
      upsert: true,
    });
  }
  if (params.stage === "completed") {
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("migration_sources")
        .set({ removed_source: 1 })
        .where(
          "source_key",
          "in",
          entries.map((entry) => entry.sourceKey),
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

function copyRowsToState(params: MigrationSnapshot): AuthRows {
  return runOpenClawStateWriteTransaction(
    ({ db: database, path: targetDatabasePath }) => {
      const db = getNodeSqliteKysely<SharedAuthMigrationDatabase>(database);
      const target = readTargetRows(database);
      if (
        params.sourceRows.store &&
        target.store &&
        !rowsMatch(params.sourceRows.store, target.store) &&
        !storeIsContained(params.sourceRows.store, target.store)
      ) {
        throw new Error(
          "shared auth credential rows conflict with the relocation target. Back up both auth databases, reconcile differing or missing profiles, then rerun openclaw doctor --fix.",
        );
      }
      if (
        params.sourceRows.state &&
        target.state &&
        !rowsMatch(params.sourceRows.state, target.state)
      ) {
        throw new Error(
          "shared auth state rows conflict with the relocation target. Back up both auth databases, reconcile the runtime state, then rerun openclaw doctor --fix.",
        );
      }
      if (params.sourceRows.store && !target.store) {
        executeSqliteQuerySync(
          database,
          db.insertInto("config_machine_state").values({
            state_key: "authProfiles.store",
            value_json: params.sourceRows.store.store_json,
            updated_at_ms: params.sourceRows.store.updated_at,
          }),
        );
      }
      if (params.sourceRows.state && !target.state) {
        executeSqliteQuerySync(
          database,
          db.insertInto("config_machine_state").values({
            state_key: "authProfiles.state",
            value_json: params.sourceRows.state.state_json,
            updated_at_ms: params.sourceRows.state.updated_at,
          }),
        );
      }
      const canonicalRows = readTargetRows(database);
      assertRowsMatch(
        {
          store: target.store ?? params.sourceRows.store,
          state: target.state ?? params.sourceRows.state,
        },
        canonicalRows,
        "copy",
      );
      rewriteAuthJsonMigrationReceipts(database, params.sourcePath, targetDatabasePath);
      recordMigrationLedger({ ...params, database, stage: "copied" });
      return canonicalRows;
    },
    { env: params.env },
    { operationLabel: "state-migration.shared-auth-copy" },
  );
}

function advanceMigration(
  params: MigrationSnapshot & {
    rows: AuthRows;
    stage: "ownership-flipped" | "completed";
  },
): boolean {
  const flipping = params.stage === "ownership-flipped";
  const flipped = flipping && resolveSharedAuthStoreOwnership(params.env).location !== "state-db";
  runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      assertRowsMatch(params.rows, readTargetRows(database), params.stage);
      if (flipping) {
        const db = getNodeSqliteKysely<SharedAuthMigrationDatabase>(database);
        const ownership = {
          value_json: JSON.stringify({ location: "state-db" }),
          updated_at_ms: params.now,
        };
        executeSqliteQuerySync(
          database,
          db
            .insertInto("config_machine_state")
            .values({ state_key: SHARED_AUTH_STORE_STATE_KEY, ...ownership })
            .onConflict((conflict) => conflict.column("state_key").doUpdateSet(ownership)),
        );
      }
      recordMigrationLedger({ ...params, database });
    },
    { env: params.env },
    {
      operationLabel: flipping
        ? "state-migration.shared-auth-ownership"
        : "state-migration.shared-auth-finalize",
    },
  );
  if (flipping) {
    noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, params.env);
  }
  return flipped;
}

function cleanupSourceRows(params: { env: NodeJS.ProcessEnv; sourcePath: string }): boolean {
  if (inspectSharedAuthLegacySourceFile(params.sourcePath).status === "missing") {
    return false;
  }
  try {
    const removed = runOpenClawAgentWriteTransaction(
      ({ db: database }) => {
        const db = getNodeSqliteKysely<SourceAuthDatabase>(database);
        const before = readSharedAuthLegacyRowsFromDatabase(database);
        executeSqliteQuerySync(
          database,
          db.deleteFrom("auth_profile_store").where("store_key", "=", SOURCE_STORE_KEY),
        );
        executeSqliteQuerySync(
          database,
          db.deleteFrom("auth_profile_state").where("state_key", "=", SOURCE_STORE_KEY),
        );
        const after = readSharedAuthLegacyRowsFromDatabase(database);
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

/** Detect relocation or unfinished cleanup only in the explicit Doctor repair path. */
export function detectSharedAuthStoreMigration(params: {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  doctorOnlyStateMigrations?: boolean;
}): SharedAuthStoreMigrationDetection {
  const env = { ...(params.env ?? process.env), OPENCLAW_STATE_DIR: params.stateDir };
  const sourcePath = path.join(resolveSharedMainAuthAgentDir(env), "openclaw-agent.sqlite");
  if (params.doctorOnlyStateMigrations !== true) {
    return { sourcePath, hasLegacy: false };
  }
  const ownership = resolveSharedAuthStoreOwnership(env);
  const hasLegacy =
    ownership.location === "legacy-main" || hasPendingSharedAuthCleanup(env, sourcePath);
  if (hasLegacy) {
    // Once shared ownership moves, main-agent rows are ordinary per-agent overrides.
    // Only the ownership marker or a pending receipt authorizes inspecting them as migration input.
    inspectSharedAuthLegacyRowsReadOnly(sourcePath);
  }
  return { sourcePath, hasLegacy };
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
      const snapshot = {
        env,
        sourcePath: params.detected.sourcePath,
        sourceSize: source.size,
        sourceRows: source.rows,
        now,
      };
      const rows = copyRowsToState(snapshot);
      const ownershipFlipped = advanceMigration({ ...snapshot, rows, stage: "ownership-flipped" });
      const sourceCleaned = cleanupSourceRows({ env, sourcePath: params.detected.sourcePath });
      const relocatedRows = rows.store !== null || rows.state !== null || sourceCleaned;
      advanceMigration({ ...snapshot, rows, stage: "completed" });
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
