import type { DatabaseSync } from "node:sqlite";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  assertUpdateRecoveryPublicationRecord,
  UpdateRecoveryConflictError,
  UpdateRecoveryRecordSchema,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";
import {
  validateUpdateRecoveryDatabaseBinding,
  type UpdateRecoveryDatabaseBinding,
} from "./update-run-recovery.js";

/** Roles come from the checkpoint's validated plan/file identities, never from a filename guess. */
export type UpdateRecoveryPublicationLocation = {
  role: "live-source" | "staged" | "displaced" | "live-restored";
  expected: UpdateRecoveryRecord;
  sourceBinding: UpdateRecoveryDatabaseBinding;
  stagedBinding: UpdateRecoveryDatabaseBinding;
};

/**
 * Validate one consistent, artifact-preserving read snapshot. The displaced row
 * must match the publication commitment retained in current recovery, not itself
 * or an arbitrary older revision. It is never returned as an executable claim.
 * All other rows/schema/implicit rowids remain bound by the original plan digest.
 */
export function validateUpdateRecoveryPublicationDatabase(
  db: DatabaseSync,
  params: UpdateRecoveryPublicationLocation,
): void {
  const expected = UpdateRecoveryRecordSchema.parse(params.expected);
  if (!expected.publication || !expected.restore?.planSha256) {
    throw new UpdateRecoveryConflictError();
  }
  const ownsRead = !db.isTransaction;
  if (ownsRead) {
    db.exec("BEGIN"); // sqlite-allow-raw -- Row commitment and database digest share one snapshot.
  }
  try {
    if (params.role === "live-restored") {
      validateUpdateRecoveryDatabaseBinding(db, expected, params.stagedBinding);
      return;
    }
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<Pick<DB, "config_machine_state">>(db)
        .selectFrom("config_machine_state")
        .select("value_json")
        .where("state_key", "=", "update.recovery." + expected.runId),
    );
    if (!row || Buffer.byteLength(row.value_json) > 1024 * 1024) {
      throw new UpdateRecoveryConflictError();
    }
    const publication = UpdateRecoveryRecordSchema.parse(JSON.parse(row.value_json));
    assertUpdateRecoveryPublicationRecord(expected, publication);
    // Until publication both source and staged must still be the exact current
    // intent. Only displaced is allowed to retain the committed older row.
    validateUpdateRecoveryDatabaseBinding(
      db,
      params.role === "displaced" ? publication : expected,
      params.role === "staged" ? params.stagedBinding : params.sourceBinding,
    );
  } finally {
    if (ownsRead) {
      db.exec("ROLLBACK"); // sqlite-allow-raw -- End read snapshot without mutation.
    }
  }
}

/** No migration, claim write, runtime cleanup, or writable open of the given family. */
export function validateUpdateRecoveryPublicationDatabaseAtPath(
  params: UpdateRecoveryPublicationLocation,
  options: OpenClawStateDatabaseOptions,
): void {
  const found = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
    validateUpdateRecoveryPublicationDatabase(db, params);
    return true;
  }, options);
  if (!found) {
    throw new UpdateRecoveryConflictError();
  }
}
