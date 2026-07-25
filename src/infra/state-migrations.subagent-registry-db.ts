import { createHash } from "node:crypto";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

const MIGRATION_KIND = "legacy-subagent-registry-json";

type SubagentRegistryMigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "migration_runs" | "migration_sources"
>;

type SubagentRegistryMigrationDecision = "receipt-authoritative" | "retired-source-discarded";

/** Records the irreversible retirement decision before Doctor removes the claimed file. */
export function recordLegacySubagentRegistryDiscard(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  sourceSha256: string;
  sourceSize: number;
}): {
  decision: SubagentRegistryMigrationDecision;
  sourceKey: string;
} {
  const sourceKey = `subagent-json:${createHash("sha256").update(params.sourcePath).digest("hex")}`;
  const now = Date.now();
  const runId = `${sourceKey}:${params.sourceSha256.slice(0, 16)}`;
  let decision: SubagentRegistryMigrationDecision = "retired-source-discarded";
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<SubagentRegistryMigrationDatabase>(db);
      const receipt = executeSqliteQueryTakeFirstSync(
        db,
        stateDb
          .selectFrom("migration_sources")
          .select("source_key")
          .where("source_key", "=", sourceKey),
      );
      if (receipt) {
        decision = "receipt-authoritative";
      }

      const reportJson = JSON.stringify({
        source: MIGRATION_KIND,
        target: "subagent_runs",
        decision,
        sourceSha256: params.sourceSha256,
        importedRecordCount: 0,
        reason: "retired transient state is never imported into the canonical SQLite registry",
      });
      executeSqliteQuerySync(
        db,
        stateDb
          .insertInto("migration_runs")
          .values({
            id: runId,
            started_at: now,
            finished_at: now,
            status: "completed",
            report_json: reportJson,
          })
          .onConflict((conflict) =>
            conflict.column("id").doUpdateSet({
              finished_at: now,
              status: "completed",
              report_json: reportJson,
            }),
          ),
      );
      executeSqliteQuerySync(
        db,
        stateDb
          .insertInto("migration_sources")
          .values({
            source_key: sourceKey,
            migration_kind: MIGRATION_KIND,
            source_path: params.sourcePath,
            target_table: "subagent_runs",
            source_sha256: params.sourceSha256,
            source_size_bytes: params.sourceSize,
            source_record_count: null,
            last_run_id: runId,
            status: "completed",
            imported_at: now,
            removed_source: 0,
            report_json: reportJson,
          })
          .onConflict((conflict) =>
            conflict.column("source_key").doUpdateSet({
              source_sha256: params.sourceSha256,
              source_size_bytes: params.sourceSize,
              source_record_count: null,
              last_run_id: runId,
              status: "completed",
              imported_at: now,
              removed_source: 0,
              report_json: reportJson,
            }),
          ),
      );
    },
    { env: params.env },
  );
  return { decision, sourceKey };
}

export function markLegacySubagentRegistrySourceRemoved(
  sourceKey: string,
  env: NodeJS.ProcessEnv,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<SubagentRegistryMigrationDatabase>(db);
      executeSqliteQuerySync(
        db,
        stateDb
          .updateTable("migration_sources")
          .set({ removed_source: 1 })
          .where("source_key", "=", sourceKey),
      );
    },
    { env },
  );
}
