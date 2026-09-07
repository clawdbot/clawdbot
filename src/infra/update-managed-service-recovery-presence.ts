import fs from "node:fs";
import { assertOpenClawStateDatabaseOwner } from "../state/openclaw-state-db-maintenance.js";
import { assertSupportedStateSchemaVersion } from "../state/openclaw-state-db-schema-version.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "./kysely-sync-cache-state.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { prepareSqliteReadOnlyLocationSyncInProcess } from "./sqlite-readonly-location.js";
import { UPDATE_RECOVERY_KEY_PREFIX } from "./update-run-recovery-keys.js";

/** Presence only, never recovery or native-effect authority. The retained helper
 * checks a private copy after persistence or joined updater exit. Missing,
 * displaced, corrupt or forward-schema state cannot authorize legacy cleanup.
 */
export function hasManagedUpdateRecoveryRecord(pathname: string, runId: string): boolean {
  if (!pathname || !runId) {
    throw new Error("Managed recovery inspection requires its admitted state and run.");
  }
  const original = fs.lstatSync(pathname);
  if (!original.isFile()) {
    throw new Error("Managed recovery state is not a regular file.");
  }
  const prepared = prepareSqliteReadOnlyLocationSyncInProcess(pathname);
  try {
    const db = openNodeSqliteDatabase(prepared.location, { readOnly: true });
    try {
      const version = assertSupportedStateSchemaVersion(db, pathname);
      assertOpenClawStateDatabaseOwner(db, { pathname });
      assertSqliteIntegrity(db, pathname);
      const queries =
        getNodeSqliteKysely<Pick<DB, "update_runs" | "config_machine_state" | "schema_meta">>(db);
      const metadata = executeSqliteQueryTakeFirstSync(
        db,
        queries
          .selectFrom("schema_meta")
          .select("schema_version")
          .where("meta_key", "=", "primary"),
      );
      if (version < 1 || metadata?.schema_version !== version) {
        throw new Error("Managed recovery schema metadata is inconsistent.");
      }
      const run = executeSqliteQueryTakeFirstSync(
        db,
        queries.selectFrom("update_runs").select("run_id").where("run_id", "=", runId),
      );
      if (!run) {
        throw new Error("Managed recovery inspection lost its admitted run.");
      }
      const present =
        executeSqliteQueryTakeFirstSync(
          db,
          queries
            .selectFrom("config_machine_state")
            .select("state_key")
            .where("state_key", "=", UPDATE_RECOVERY_KEY_PREFIX + runId),
        ) !== undefined;
      const current = fs.lstatSync(pathname);
      if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino) {
        throw new Error("Managed recovery state changed during inspection.");
      }
      return present;
    } finally {
      clearNodeSqliteKyselyCacheForDatabase(db);
      db.close();
    }
  } finally {
    prepared.cleanup();
  }
}
