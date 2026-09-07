import { createHash } from "node:crypto";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
} from "./state-migrations.receipts.js";

const MIGRATION_KIND = "legacy-subagent-registry-json";

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
      const receipt = readLegacyMigrationReceiptFromDatabase(db, sourceKey);
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
      recordLegacyMigrationReceipt(db, {
        sourceKey,
        migrationKind: MIGRATION_KIND,
        sourcePath: params.sourcePath,
        targetTable: "subagent_runs",
        sourceSha256: params.sourceSha256,
        sourceSizeBytes: params.sourceSize,
        sourceRecordCount: null,
        runId,
        now,
        reportJson,
        upsert: true,
      });
    },
    { env: params.env },
  );
  return { decision, sourceKey };
}
