import { isDeepStrictEqual } from "node:util";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../../infra/node-sqlite.js";
import type { PackageRecoveryTransaction } from "../../infra/package-update-recovery.js";
import { assertSqliteIntegrity } from "../../infra/sqlite-integrity.js";
import { validateUpdateCheckpointPreviousRuntimeDatabase } from "../../infra/update-checkpoint-runtime.js";
import type { UpdateRecoveryRecord } from "../../infra/update-run-recovery.js";
import { assertOpenClawStateDatabaseOwner } from "../../state/openclaw-state-db-maintenance.js";
import { assertSupportedStateSchemaVersion } from "../../state/openclaw-state-db-schema-version.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import type { UpdateCommandRecovery } from "./update-command-recovery.js";

/** Actual retained-runtime readback, shared by first publication and fresh replay.
 * A descriptor is never substituted for the executable's database-reader result. */
export function createUpdateCommandCheckpointReplayAccess(params: {
  databasePath: string;
  artifactRoot: string;
  transaction: PackageRecoveryTransaction;
  assertCurrent: () => void;
  timeoutMs?: number;
}): NonNullable<UpdateCommandRecovery["checkpointReplay"]>["access"] {
  const { databasePath, artifactRoot, transaction, assertCurrent, timeoutMs } = params;
  let validatedRuntime: UpdateRecoveryRecord["from"] | undefined;
  return {
    artifactRoot,
    validateStagedDatabase(db) {
      assertCurrent();
      const version = assertSupportedStateSchemaVersion(db, databasePath);
      assertOpenClawStateDatabaseOwner(db, { pathname: databasePath });
      if (
        executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<Pick<DB, "schema_meta">>(db)
            .selectFrom("schema_meta")
            .select("schema_version")
            .where("meta_key", "=", "primary"),
        )?.schema_version !== version
      ) {
        throw new Error("Restored schema metadata is inconsistent.");
      }
      assertSqliteIntegrity(db, databasePath);
      return undefined;
    },
    assertMatchingRuntime(runtime) {
      assertCurrent();
      if (!validatedRuntime || !isDeepStrictEqual(runtime, validatedRuntime)) {
        throw new Error("Previous runtime has not accepted the restored database.");
      }
      return undefined;
    },
    async prepareCanonicalWrite(record) {
      assertCurrent();
      const observed = await transaction.observe();
      assertCurrent();
      if (
        observed.status !== "verified" ||
        observed.observation.previous !== "live" ||
        observed.observation.candidate === "live"
      ) {
        throw new Error("Previous runtime custody changed.");
      }
      const db = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(databasePath), {
        readOnly: true,
      });
      try {
        const checked = await validateUpdateCheckpointPreviousRuntimeDatabase({
          database: db,
          runtime: record.from,
          assertCurrent: () => {
            assertCurrent();
            return undefined;
          },
          timeoutMs,
        });
        if (checked.status !== "verified") {
          throw new Error(checked.reason);
        }
        validatedRuntime = record.from;
      } finally {
        db.close();
      }
    },
    async closeCanonicalDatabase() {
      closeOpenClawStateDatabase();
    },
  };
}
