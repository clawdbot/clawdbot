import type { DatabaseSync } from "node:sqlite";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { UPDATE_RECOVERY_KEY_END, UPDATE_RECOVERY_KEY_PREFIX } from "./update-run-recovery-keys.js";
import {
  decodeUpdateRecovery,
  encodeUpdateRecovery,
  inspectUpdateRecovery,
  type UpdateRecoveryInspection,
  UpdateRecoveryConflictError,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";
import type { UpdateRecoveryFence, UpdateRecoveryRevision } from "./update-run-recovery.js";
type RecoveryDatabase = Pick<DB, "update_runs" | "config_machine_state">;

function readRecoveryRows(db: DatabaseSync) {
  if (!tableExists(db, "config_machine_state")) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<RecoveryDatabase>(db)
      .selectFrom("config_machine_state")
      .select(["state_key", "value_json"])
      .where("state_key", ">=", UPDATE_RECOVERY_KEY_PREFIX)
      .where("state_key", "<", UPDATE_RECOVERY_KEY_END)
      .orderBy("state_key", "asc"),
  ).rows;
}
export function readRecoveries(db: DatabaseSync): UpdateRecoveryRecord[] {
  return readRecoveryRows(db).map((row) =>
    decodeUpdateRecovery(row.value_json, row.state_key.slice(UPDATE_RECOVERY_KEY_PREFIX.length)),
  );
}
export function inspectRecoveries(db: DatabaseSync): UpdateRecoveryInspection[] {
  return readRecoveryRows(db).map((row) =>
    inspectUpdateRecovery(row.value_json, row.state_key.slice(UPDATE_RECOVERY_KEY_PREFIX.length)),
  );
}
export function writeRecovery<T>(
  fence: UpdateRecoveryFence,
  operation: (db: DatabaseSync) => T,
  options: OpenClawStateDatabaseOptions,
): T {
  assertRecoveryFence(fence);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertRecoveryFence(fence);
      const result = operation(db);
      assertRecoveryFence(fence);
      return result;
    },
    options,
    { operationLabel: "update.recovery" },
  );
}
export function requireRevision(
  db: DatabaseSync,
  expected: UpdateRecoveryRevision,
): { record: UpdateRecoveryRecord; raw: string } {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<RecoveryDatabase>(db)
      .selectFrom("config_machine_state")
      .select(["value_json", "updated_at_ms"])
      .where("state_key", "=", UPDATE_RECOVERY_KEY_PREFIX + expected.runId),
  );
  if (!row?.value_json) {
    throw new UpdateRecoveryConflictError();
  }
  const record = decodeUpdateRecovery(row.value_json, expected.runId);
  if (
    row.updated_at_ms !== record.updatedAtMs ||
    record.transactionId !== expected.transactionId ||
    record.revision !== expected.revision ||
    record.claimId !== expected.claimId
  ) {
    throw new UpdateRecoveryConflictError();
  }
  return { record, raw: row.value_json };
}
export function mutateRecovery(
  expected: UpdateRecoveryRevision,
  fence: UpdateRecoveryFence,
  mutate: (record: UpdateRecoveryRecord, db: DatabaseSync) => void,
  options: OpenClawStateDatabaseOptions,
  claimTransition = false,
  allowTerminal = false,
  allowNativePending = false,
): UpdateRecoveryRecord {
  return writeRecovery(
    fence,
    (db) => {
      const { record, raw } = requireRevision(db, expected);
      if (!claimTransition) {
        assertExecutingClaim(record);
      }
      if (
        record.nativeManager?.effects.at(-1)?.state === "intent" &&
        !claimTransition &&
        !allowNativePending
      ) {
        throw new UpdateRecoveryConflictError();
      }
      if (record.terminal && !allowTerminal) {
        throw new UpdateRecoveryConflictError();
      }
      mutate(record, db);
      record.revision++;
      record.updatedAtMs = Math.max(Date.now(), record.updatedAtMs + 1);
      const result = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<RecoveryDatabase>(db)
          .updateTable("config_machine_state")
          .set({ value_json: encodeUpdateRecovery(record), updated_at_ms: record.updatedAtMs })
          .where("state_key", "=", UPDATE_RECOVERY_KEY_PREFIX + record.runId)
          .where("value_json", "=", raw),
      );
      if (result.numAffectedRows !== 1n) {
        throw new UpdateRecoveryConflictError();
      }
      return record;
    },
    options,
  );
}
export function assertExecutingClaim(record: UpdateRecoveryRecord): void {
  if (record.handoff?.state === "prepared") {
    throw new UpdateRecoveryConflictError();
  }
}

export function assertRecoveryFence(fence: UpdateRecoveryFence): void {
  if (fence.assertCurrent() !== undefined) {
    throw new Error("Recovery exclusion must complete synchronously");
  }
}
