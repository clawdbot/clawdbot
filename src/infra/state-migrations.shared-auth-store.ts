import { createHash } from "node:crypto";
// Doctor-owned relocation of the legacy shared auth rows into shared SQLite state.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  noteCommittedSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnership,
  SHARED_AUTH_STORE_STATE_KEY,
  type SharedAuthStoreOwnership,
} from "../agents/auth-profiles/path-resolve.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import {
  closeAuthProfileReadPool,
  resolveAuthProfileDatabaseOwnerId,
} from "../agents/auth-profiles/sqlite.js";
import {
  closeOpenClawAgentDatabaseByPath,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const MIGRATION_KIND = "shared-auth-store-state-db";
const SOURCE_STORE_KEY = "primary";
const TARGET_STORE_KEY = "shared";
const ATTACHED_SOURCE = "legacy_shared_auth";

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

export type SharedAuthStoreMigrationDetection = {
  sourcePath: string;
  ownership: SharedAuthStoreOwnership;
  hasLegacy: boolean;
};

/** Detect relocation only in the explicit Doctor repair path. */
export function detectSharedAuthStoreMigration(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): SharedAuthStoreMigrationDetection {
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const ownership = resolveSharedAuthStoreOwnership(env);
  return {
    sourcePath: path.join(resolveSharedMainAuthAgentDir(env), "openclaw-agent.sqlite"),
    ownership,
    hasLegacy: params.doctorOnlyStateMigrations === true && ownership.location === "legacy-main",
  };
}

function rowDigest(row: StoreRow | StateRow | null): string {
  return createHash("sha256").update(JSON.stringify(row)).digest("hex");
}

function rowsMatch<T extends StoreRow | StateRow>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readSourceRows(
  database: DatabaseSync,
  attached: boolean,
): {
  store: StoreRow | null;
  state: StateRow | null;
} {
  if (!attached) {
    return { store: null, state: null };
  }
  const store = database
    .prepare(
      `SELECT store_json, updated_at FROM ${ATTACHED_SOURCE}.auth_profile_store WHERE store_key = ?`,
    )
    .get(SOURCE_STORE_KEY) as StoreRow | undefined;
  const state = database
    .prepare(
      `SELECT state_json, updated_at FROM ${ATTACHED_SOURCE}.auth_profile_state WHERE state_key = ?`,
    )
    .get(SOURCE_STORE_KEY) as StateRow | undefined;
  return { store: store ?? null, state: state ?? null };
}

function recordMigrationLedger(params: {
  database: DatabaseSync;
  sourcePath: string;
  sourceSize: number | null;
  store: StoreRow | null;
  state: StateRow | null;
  now: number;
}): void {
  const db = getNodeSqliteKysely<SharedAuthMigrationDatabase>(params.database);
  const combinedDigest = createHash("sha256")
    .update(rowDigest(params.store))
    .update(rowDigest(params.state))
    .digest("hex");
  const runId = `shared-auth-store:${combinedDigest.slice(0, 24)}`;
  const runReport = JSON.stringify({
    source: MIGRATION_KIND,
    target: "auth_profile_stores,auth_profile_state",
    ownership: "state-db",
    importedRecordCount: Number(params.store !== null) + Number(params.state !== null),
    removedSourceRows: true,
  });
  executeSqliteQuerySync(
    params.database,
    db
      .insertInto("migration_runs")
      .values({
        id: runId,
        started_at: params.now,
        finished_at: params.now,
        status: "completed",
        report_json: runReport,
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          finished_at: params.now,
          status: "completed",
          report_json: runReport,
        }),
      ),
  );
  for (const entry of [
    { sourceTable: "auth_profile_store", targetTable: "auth_profile_stores", row: params.store },
    { sourceTable: "auth_profile_state", targetTable: "auth_profile_state", row: params.state },
  ] as const) {
    const sourceKey = `shared-auth-store:${createHash("sha256")
      .update(path.resolve(params.sourcePath))
      .update("\0")
      .update(entry.sourceTable)
      .digest("hex")}`;
    const reportJson = JSON.stringify({
      source: entry.sourceTable,
      target: entry.targetTable,
      sourceSha256: rowDigest(entry.row),
      importedRecordCount: entry.row ? 1 : 0,
      removedSourceRows: true,
    });
    executeSqliteQuerySync(
      params.database,
      db
        .insertInto("migration_sources")
        .values({
          source_key: sourceKey,
          migration_kind: MIGRATION_KIND,
          source_path: params.sourcePath,
          target_table: entry.targetTable,
          source_sha256: rowDigest(entry.row),
          source_size_bytes: params.sourceSize,
          source_record_count: entry.row ? 1 : 0,
          last_run_id: runId,
          status: "completed",
          imported_at: params.now,
          removed_source: 1,
          report_json: reportJson,
        })
        .onConflict((conflict) =>
          conflict.column("source_key").doUpdateSet({
            source_sha256: rowDigest(entry.row),
            source_size_bytes: params.sourceSize,
            source_record_count: entry.row ? 1 : 0,
            last_run_id: runId,
            status: "completed",
            imported_at: params.now,
            removed_source: 1,
            report_json: reportJson,
          }),
        ),
    );
  }
}

function relocateSharedAuthRows(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  now: number;
}): void {
  const sourceExists = fs.existsSync(params.sourcePath);
  let sourceSize: number | null = null;
  if (sourceExists) {
    // Bootstrap the current per-agent schema before attaching it to the shared owner.
    runOpenClawAgentWriteTransaction(() => undefined, {
      agentId: resolveAuthProfileDatabaseOwnerId(path.dirname(params.sourcePath)),
      path: params.sourcePath,
      env: params.env,
    });
    closeAuthProfileReadPool({ kind: "database", databasePath: params.sourcePath });
    closeOpenClawAgentDatabaseByPath(params.sourcePath);
    sourceSize = fs.statSync(params.sourcePath).size;
  }

  const stateDatabase = openOpenClawStateDatabase({ env: params.env });
  if (stateDatabase.db.isTransaction) {
    throw new Error("shared auth relocation requires an outer shared-state transaction");
  }
  if (sourceExists) {
    stateDatabase.db.prepare(`ATTACH DATABASE ? AS ${ATTACHED_SOURCE}`).run(params.sourcePath);
  }
  try {
    runOpenClawStateWriteTransaction(
      ({ db: database }) => {
        const db = getNodeSqliteKysely<SharedAuthMigrationDatabase>(database);
        const source = readSourceRows(database, sourceExists);
        const targetStore =
          executeSqliteQueryTakeFirstSync(
            database,
            db
              .selectFrom("auth_profile_stores")
              .select(["store_json", "updated_at"])
              .where("store_key", "=", TARGET_STORE_KEY),
          ) ?? null;
        const targetState =
          executeSqliteQueryTakeFirstSync(
            database,
            db
              .selectFrom("auth_profile_state")
              .select(["state_json", "updated_at"])
              .where("store_key", "=", TARGET_STORE_KEY),
          ) ?? null;

        if (source.store && targetStore && !rowsMatch(source.store, targetStore)) {
          throw new Error("shared auth credential rows conflict with the relocation target");
        }
        if (source.state && targetState && !rowsMatch(source.state, targetState)) {
          throw new Error("shared auth state rows conflict with the relocation target");
        }
        if (!source.store && targetStore) {
          throw new Error(
            "shared auth relocation target has credentials absent from the legacy owner",
          );
        }
        if (!source.state && targetState) {
          throw new Error("shared auth relocation target has state absent from the legacy owner");
        }
        if (source.store && !targetStore) {
          executeSqliteQuerySync(
            database,
            db.insertInto("auth_profile_stores").values({
              store_key: TARGET_STORE_KEY,
              store_json: source.store.store_json,
              updated_at: source.store.updated_at,
            }),
          );
        }
        if (source.state && !targetState) {
          executeSqliteQuerySync(
            database,
            db.insertInto("auth_profile_state").values({
              store_key: TARGET_STORE_KEY,
              state_json: source.state.state_json,
              updated_at: source.state.updated_at,
            }),
          );
        }

        const verifiedStore =
          executeSqliteQueryTakeFirstSync(
            database,
            db
              .selectFrom("auth_profile_stores")
              .select(["store_json", "updated_at"])
              .where("store_key", "=", TARGET_STORE_KEY),
          ) ?? null;
        const verifiedState =
          executeSqliteQueryTakeFirstSync(
            database,
            db
              .selectFrom("auth_profile_state")
              .select(["state_json", "updated_at"])
              .where("store_key", "=", TARGET_STORE_KEY),
          ) ?? null;
        if (
          (source.store && (!verifiedStore || !rowsMatch(source.store, verifiedStore))) ||
          (source.state && (!verifiedState || !rowsMatch(source.state, verifiedState)))
        ) {
          throw new Error("shared auth relocation readback verification failed");
        }

        if (sourceExists) {
          database
            .prepare(`DELETE FROM ${ATTACHED_SOURCE}.auth_profile_store WHERE store_key = ?`)
            .run(SOURCE_STORE_KEY);
          database
            .prepare(`DELETE FROM ${ATTACHED_SOURCE}.auth_profile_state WHERE state_key = ?`)
            .run(SOURCE_STORE_KEY);
        }

        recordMigrationLedger({
          database,
          sourcePath: params.sourcePath,
          sourceSize,
          store: source.store,
          state: source.state,
          now: params.now,
        });
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
      },
      { env: params.env, database: stateDatabase },
      { operationLabel: "state-migration.shared-auth-store" },
    );
    noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, params.env);
  } finally {
    if (sourceExists) {
      stateDatabase.db.exec(`DETACH DATABASE ${ATTACHED_SOURCE}`);
    }
  }
}

/** Relocate shared auth while excluding live Gateway writers. */
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
      relocateSharedAuthRows({
        env,
        sourcePath: params.detected.sourcePath,
        now: params.now?.() ?? Date.now(),
      });
      return {
        changes: ["Relocated shared auth profiles into shared SQLite state."],
        warnings: [],
        notices: ["The main agent no longer owns shared credentials and can now be deleted."],
      };
    },
  });
}
