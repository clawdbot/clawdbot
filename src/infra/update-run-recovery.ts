import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { assertSqliteIntegrity } from "./sqlite-integrity.js";
import { ensureUpdateRunLedgerSchema } from "./update-run-ledger.js";
import { appendUpdateRecoveryAfterImage } from "./update-run-recovery-after-image.js";
import { UPDATE_RECOVERY_KEY_END, UPDATE_RECOVERY_KEY_PREFIX } from "./update-run-recovery-keys.js";
import {
  UpdateRecoveryRecordSchema,
  decodeUpdateRecovery,
  encodeUpdateRecovery,
  UpdateRecoveryConflictError,
  UpdateRecoveryRequiredError,
  parseUpdateRecoveryCheckpoint,
  sealUpdateRecoveryPublication,
  UpdateRecoveryRestoreProgressSchema,
  type UpdateRecoveryAfterImage,
  type UpdateRecoveryRestoreProgress,
  type UpdateRecoveryEffect,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";
import {
  assertSeparateUpdateRecoveryDatabases,
  digestUpdateRecoveryDatabase,
} from "./update-run-recovery-snapshot.js";
import {
  readRecoveries,
  writeRecovery,
  requireRevision,
  mutateRecovery,
  assertExecutingClaim,
} from "./update-run-recovery-store.js";

export {
  UpdateRecoveryConflictError,
  UpdateRecoveryRequiredError,
} from "./update-run-recovery-schema.js";
export type {
  UpdateRecoveryRecord,
  UpdateRecoveryAfterImage,
  UpdateRecoveryEffect,
  UpdateRecoveryRestoreProgress,
} from "./update-run-recovery-schema.js";
type RecoveryDatabase = Pick<DB, "update_runs" | "config_machine_state">;

/** Current executor-held exclusion, never deserialized. CAS does not authorize effects. */
export type UpdateRecoveryFence = { assertCurrent: () => void };
export type UpdateRecoveryRevision = Pick<
  UpdateRecoveryRecord,
  "runId" | "transactionId" | "revision" | "claimId"
>;

/** Correlation only. The receiving runtime must independently reacquire authority. */
export type UpdateRecoveryHandoff = UpdateRecoveryRevision & { handoffId: string };

/** Must run before general database open, admission writes, or runtime migration. */
export function loadUpdateRecoveries(
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord[] {
  return (
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => readRecoveries(db),
      options,
    ) ?? []
  );
}
export function loadUpdateRecovery(
  runId: string,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord | undefined {
  return loadUpdateRecoveries(options).find((record) => record.runId === runId);
}
/** Detection only; finalization owns reconciliation and matching-runtime replay. */
export function assertNoPendingUpdateRecovery(options: OpenClawStateDatabaseOptions = {}): void {
  const pending = loadUpdateRecoveries(options).find(
    (record) => !record.terminal || record.effects.some((effect) => effect.state === "intent"),
  );
  if (pending) {
    throw new UpdateRecoveryRequiredError(pending);
  }
}
export function beginUpdateRecovery(
  input: Pick<UpdateRecoveryRecord, "runId" | "from" | "to">,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord {
  return writeRecovery(
    fence,
    (db) => {
      const pending = readRecoveries(db).find(
        (record) => !record.terminal || record.effects.some((effect) => effect.state === "intent"),
      );
      if (pending) {
        throw new UpdateRecoveryRequiredError(pending);
      }
      const row = executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<RecoveryDatabase>(db)
          .selectFrom("update_runs")
          .select("status")
          .where("run_id", "=", input.runId),
      );
      if (!row || row.status !== "running") {
        throw new Error("Recovery requires an existing running update history record");
      }
      const now = Date.now();
      const env = options.env ?? process.env;
      const stateDir = resolveStateDir(env);
      const record: UpdateRecoveryRecord = {
        ...input,
        source: { stateDir, configPath: resolveConfigPath(env, stateDir) },
        transactionId: randomUUID(),
        revision: 0,
        claimId: randomUUID(),
        claimKind: "initial",
        handoff: null,
        createdAtMs: now,
        updatedAtMs: now,
        effects: [],
        restore: null,
        verification: null,
        primaryFailure: null,
      };
      const raw = encodeUpdateRecovery(record);
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<RecoveryDatabase>(db)
          .insertInto("config_machine_state")
          .values({
            state_key: UPDATE_RECOVERY_KEY_PREFIX + input.runId,
            value_json: raw,
            updated_at_ms: now,
          }),
      );
      return decodeUpdateRecovery(raw, input.runId);
    },
    options,
  );
}
/**
 * Bind the actual reopened checkpoint before any update effects. The consumer
 * awaits capture/reopen against current owned state/config/runtime, then passes
 * ref + manifest.binding here under the post-stop schema/exclusion fence. This
 * only persists verified facts; replay must reopen the immutable artifact again.
 * If early preimages were bound, also pass the reopened manifest.preimageRef;
 * neither an early artifact nor an unrelated full capture can replace them.
 */
export function bindUpdateRecoveryCheckpoint(
  expected: UpdateRecoveryRevision,
  checkpoint: NonNullable<UpdateRecoveryRecord["checkpoint"]>,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord {
  return mutateRecovery(
    expected,
    fence,
    (record) => {
      record.checkpoint = parseUpdateRecoveryCheckpoint(record, checkpoint);
    },
    options,
  );
}

/**
 * Persist owner-reopened after-image facts before releasing the mutation interval
 * or starting another effect. The caller must await checkpoint capture/reopen
 * with writer-retained outputs, then revalidate live exclusion. A late snapshot,
 * matching IDs, or this record cannot establish mutation provenance/authority.
 * Replay reopens each retained artifact again. No artifact cleanup occurs here.
 */
export function bindUpdateRecoveryAfterImage(
  expected: UpdateRecoveryRevision,
  input: Omit<UpdateRecoveryAfterImage, "boundAtRevision">,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord {
  return mutateRecovery(
    expected,
    fence,
    (record) => appendUpdateRecoveryAfterImage(record, input),
    options,
  );
}

/** Call only after read-only effect reconciliation and reacquiring current exclusion. */
export function claimUpdateRecovery(
  expected: UpdateRecoveryRevision,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord {
  return mutateRecovery(
    expected,
    fence,
    (record) => {
      record.claimId = randomUUID();
      record.claimKind = "recovery";
      record.handoff = null;
      // A receipt from a previous executor is history, not proof of this boot.
      record.verification = null;
    },
    options,
    true,
    true,
  );
}

/** Recheck this together with live exclusion immediately before an external effect. */
export function assertUpdateRecoveryClaim(
  expected: UpdateRecoveryRevision,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): void {
  fence.assertCurrent();
  const checked = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
    assertExecutingClaim(requireRevision(db, expected).record);
    return true;
  }, options);
  if (!checked) {
    throw new UpdateRecoveryConflictError();
  }
  fence.assertCurrent();
}

/**
 * Persist before starting the candidate continuation. Preparing fences the parent
 * even if it reloads the row. A failed spawn is recovered through the ordinary
 * read-only reconciliation/reclaim path, never by reusing the parent's claim.
 */
export function prepareUpdateRecoveryHandoff(
  expected: UpdateRecoveryRevision,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): { record: UpdateRecoveryRecord; handoff: UpdateRecoveryHandoff } {
  const handoffId = randomUUID();
  const record = mutateRecovery(
    expected,
    fence,
    (current) => {
      if (current.effects.some((effect) => effect.state === "intent")) {
        throw new Error("Reconcile outstanding effects before transferring update finalization");
      }
      current.claimId = randomUUID();
      current.verification = null;
      current.handoff = { handoffId, state: "prepared" };
    },
    options,
  );
  return {
    record,
    handoff: {
      runId: record.runId,
      transactionId: record.transactionId,
      revision: record.revision,
      claimId: record.claimId,
      handoffId,
    },
  };
}

/** Accept once after read-only reconciliation and fresh candidate/authority validation. */
export function acceptUpdateRecoveryHandoff(
  handoff: UpdateRecoveryHandoff,
  runtime: UpdateRecoveryRecord["to"],
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord {
  return mutateRecovery(
    handoff,
    fence,
    (record) => {
      if (
        record.handoff?.state !== "prepared" ||
        record.handoff.handoffId !== handoff.handoffId ||
        record.to.root !== runtime.root ||
        record.to.nodePath !== runtime.nodePath ||
        record.to.version !== runtime.version ||
        record.to.buildId !== runtime.buildId
      ) {
        throw new UpdateRecoveryConflictError();
      }
      record.claimId = randomUUID();
      record.claimKind = "handoff";
      record.handoff.state = "accepted";
      record.verification = null;
    },
    options,
    true,
  );
}
/** Commit intent before performing the named external effect. */
export function recordUpdateRecoveryIntent(
  expected: UpdateRecoveryRevision,
  effect: Omit<UpdateRecoveryEffect, "state" | "observedIdentity">,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord {
  return mutateRecovery(
    expected,
    fence,
    (record) => {
      if (
        record.effects.some(
          (entry) => entry.state === "intent" || entry.effectId === effect.effectId,
        )
      ) {
        throw new Error(
          "Reconcile the outstanding recovery effect before recording another intent",
        );
      }
      if (
        effect.package ||
        (record.package &&
          ["package-activation", "package-restore", "retirement"].includes(effect.kind))
      ) {
        throw new UpdateRecoveryConflictError();
      }
      if (effect.kind === "package-activation" && !record.checkpoint) {
        throw new Error("Package activation requires a durable checkpoint binding");
      }
      record.effects.push({ ...effect, state: "intent", observedIdentity: null });
      if (effect.kind !== "retirement") {
        record.verification = null;
      }
    },
    options,
  );
}
/** Observation comes from the resource owner, including after process death. */
export function recordUpdateRecoveryObservation(
  expected: UpdateRecoveryRevision,
  observation: { effectId: string; observedIdentity: string },
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord {
  return mutateRecovery(
    expected,
    fence,
    (record) => {
      const effect = record.effects.at(-1);
      if (effect?.package) {
        throw new UpdateRecoveryConflictError();
      }
      if (!effect || effect.effectId !== observation.effectId || effect.state !== "intent") {
        throw new UpdateRecoveryConflictError();
      }
      effect.state = "observed";
      effect.observedIdentity = observation.observedIdentity;
    },
    options,
  );
}
/** Keep the primary update failure even if later restoration also fails. */
export function recordUpdateRecoveryFailure(
  expected: UpdateRecoveryRevision,
  failure: NonNullable<UpdateRecoveryRecord["primaryFailure"]>,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord {
  return mutateRecovery(
    expected,
    fence,
    (record) => {
      record.primaryFailure ??= failure;
      record.verification = null;
    },
    options,
  );
}

/**
 * Persist the actual producer receipt after the final observed restart. The
 * restart owner supplies bootId as its observedIdentity. This only binds facts;
 * finalization still requires current lifecycle authority and fresh verification
 * after repair, restore, restart, abort, or transcript reset/rewrite.
 */
export function recordUpdateRecoveryVerification(
  expected: UpdateRecoveryRevision,
  verification: Omit<NonNullable<UpdateRecoveryRecord["verification"]>, "effectId">,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord {
  return mutateRecovery(
    expected,
    fence,
    (record) => {
      const { runtime, receipt } = verification;
      const identity = runtime === "candidate" ? record.to : record.from;
      const restart = record.effects.at(-1);
      if (
        !restart ||
        restart.kind !== "service-restart" ||
        restart.state !== "observed" ||
        restart.runtime !== runtime ||
        restart.observedIdentity !== receipt.gateway.bootId ||
        receipt.runId !== record.runId ||
        receipt.gateway.version !== identity.version ||
        receipt.gateway.buildId !== identity.buildId
      ) {
        throw new Error("Serving verification does not match the final observed update runtime");
      }
      record.verification = { ...verification, effectId: restart.effectId };
    },
    options,
  );
}

function advanceRestoreProgress(
  record: UpdateRecoveryRecord,
  input: UpdateRecoveryRestoreProgress,
): void {
  const next = UpdateRecoveryRestoreProgressSchema.parse(input);
  const effect = record.effects.at(-1);
  if (
    !effect ||
    effect.kind !== "checkpoint-restore" ||
    effect.state !== "intent" ||
    effect.runtime !== "previous" ||
    effect.resourceId !== next.checkpointId
  ) {
    throw new Error("Restore progress requires the matching checkpoint restoration intent");
  }
  const prior = record.restore;
  if (!prior) {
    if (next.resourceCursor !== 0 || next.phase === "observed") {
      throw new UpdateRecoveryConflictError();
    }
  } else {
    const sameResource = next.resourceCursor === prior.resourceCursor;
    const allowedPhase =
      prior.phase === "preparing"
        ? next.phase === "preparing" || next.phase === "intent"
        : prior.phase === "intent"
          ? next.phase === "intent" || next.phase === "observed"
          : next.phase === "observed";
    if (
      prior.restoreId !== next.restoreId ||
      prior.checkpointId !== next.checkpointId ||
      prior.planPath !== next.planPath ||
      (prior.planSha256 !== null && prior.planSha256 !== next.planSha256) ||
      (sameResource
        ? !allowedPhase
        : next.resourceCursor !== prior.resourceCursor + 1 ||
          prior.phase !== "observed" ||
          next.phase !== "intent")
    ) {
      throw new UpdateRecoveryConflictError();
    }
  }
  record.restore = next;
  record.verification = null;
}

/**
 * Advance a sealed plan after read-only resource reconciliation. Before shared
 * database publication use carry-forward so BOTH copies contain the next intent.
 * After publication, reopen only through the matching runtime and update this
 * single authoritative copy; never recopy history or user state from the old DB.
 * The caller obtains observation from the checkpoint owner, not from the cursor.
 */
export function recordUpdateRecoveryRestoreProgress(
  expected: UpdateRecoveryRevision,
  nextProgress: UpdateRecoveryRestoreProgress,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): UpdateRecoveryRecord {
  return mutateRecovery(
    expected,
    fence,
    (record) => {
      if (!record.restore || record.restore.phase === "preparing") {
        throw new UpdateRecoveryConflictError();
      }
      advanceRestoreProgress(record, nextProgress);
    },
    options,
  );
}

/** Immutable plan binding; the exact active record is validated separately. */
export type UpdateRecoveryDatabaseBinding = {
  runId: string;
  transactionId: string;
  sha256: string;
};

function assertExactRecovery(db: DatabaseSync, expected: UpdateRecoveryRecord): void {
  const { raw } = requireRevision(db, expected);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<RecoveryDatabase>(db)
      .selectFrom("config_machine_state")
      .select("updated_at_ms")
      .where("state_key", "=", UPDATE_RECOVERY_KEY_PREFIX + expected.runId),
  );
  if (raw !== encodeUpdateRecovery(expected) || row?.updated_at_ms !== expected.updatedAtMs) {
    throw new UpdateRecoveryConflictError();
  }
}

/**
 * Read-only snapshot; use an artifact-preserving handle BEFORE claim/admission.
 * No schema migration, WAL setup, cleanup, or general runtime open occurs here.
 * Every other row is bound, including all history and unrelated machine state.
 */
export function readUpdateRecoveryDatabaseBinding(
  db: DatabaseSync,
  expected: UpdateRecoveryRecord,
): UpdateRecoveryDatabaseBinding {
  const ownsRead = !db.isTransaction;
  if (ownsRead) {
    db.exec("BEGIN"); // sqlite-allow-raw -- One consistent read-only snapshot.
  }
  try {
    assertExactRecovery(db, expected);
    assertSqliteIntegrity(db, "update recovery database binding");
    return {
      runId: expected.runId,
      transactionId: expected.transactionId,
      sha256: digestUpdateRecoveryDatabase(db, expected.runId),
    };
  } finally {
    if (ownsRead) {
      db.exec("ROLLBACK"); // sqlite-allow-raw -- Close read snapshot without writes.
    }
  }
}

export function validateUpdateRecoveryDatabaseBinding(
  db: DatabaseSync,
  expected: UpdateRecoveryRecord,
  binding: UpdateRecoveryDatabaseBinding,
): void {
  const actual = readUpdateRecoveryDatabaseBinding(db, expected);
  if (
    actual.runId !== binding.runId ||
    actual.transactionId !== binding.transactionId ||
    actual.sha256 !== binding.sha256
  ) {
    throw new UpdateRecoveryConflictError();
  }
}

/** Preserve the physical SQLite family while reconciling before any writer opens. */
export function validateUpdateRecoveryDatabaseBindingAtPath(
  expected: UpdateRecoveryRecord,
  binding: UpdateRecoveryDatabaseBinding,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const found = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
    validateUpdateRecoveryDatabaseBinding(db, expected, binding);
    return true;
  }, options);
  if (!found) {
    throw new UpdateRecoveryConflictError();
  }
}

/**
 * Copy current update-owned state/history into an unpublished checkpoint copy.
 * These are two local commits, NOT an atomic cross-database transaction. The
 * caller must not publish after an error; a partial stage is not a recovery fact.
 * Both successful commits carry the same intent/revision, and both bindings must
 * be checked again with the exact current record immediately before publication.
 * The caller owns closure of handles/SQLite families and matching-runtime reopen.
 */
export function prepareUpdateRecoveryCarryForward(params: {
  sourceDb: DatabaseSync;
  stagedDb: DatabaseSync;
  expected: UpdateRecoveryRecord;
  nextProgress: UpdateRecoveryRestoreProgress;
  fence: UpdateRecoveryFence;
  // The checkpoint owner supplies the actual matching-older-runtime validator.
  validateStagedDatabase: (db: DatabaseSync) => void;
}): {
  record: UpdateRecoveryRecord;
  sourceBinding: UpdateRecoveryDatabaseBinding;
  stagedBinding: UpdateRecoveryDatabaseBinding;
} {
  const { sourceDb, stagedDb, expected, fence } = params;
  fence.assertCurrent();
  assertSeparateUpdateRecoveryDatabases(sourceDb, stagedDb);
  // An absent old machine-state owner cannot be invented as a downgrade shim.
  if (!tableExists(stagedDb, "config_machine_state")) {
    throw new Error("Checkpoint schema cannot preserve update recovery state");
  }
  const record = UpdateRecoveryRecordSchema.parse(expected);
  assertExecutingClaim(record);
  advanceRestoreProgress(record, params.nextProgress);
  record.revision++;
  record.updatedAtMs = Math.max(Date.now(), record.updatedAtMs + 1);
  sealUpdateRecoveryPublication(record);
  const raw = encodeUpdateRecovery(record);
  let sourceBinding: UpdateRecoveryDatabaseBinding;
  let stagedBinding: UpdateRecoveryDatabaseBinding;
  sourceDb.exec("BEGIN IMMEDIATE"); // sqlite-allow-raw -- Fenced snapshot/copy primitive.
  try {
    stagedDb.exec("BEGIN IMMEDIATE"); // sqlite-allow-raw -- Private unpublished copy.
    assertExactRecovery(sourceDb, expected);
    fence.assertCurrent();
    // Preserve preexisting checkpoint history too; current rows win on collision.
    ensureUpdateRunLedgerSchema(stagedDb);
    for (const db of [sourceDb, stagedDb]) {
      // Unknown triggers could mutate non-update rows while copying owned facts.
      if (
        db
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND tbl_name IN ('update_runs', 'config_machine_state') LIMIT 1",
          )
          .get()
      ) {
        throw new Error("Checkpoint update-owned tables have unsupported mutation triggers");
      }
    }
    const sourceBefore = readUpdateRecoveryDatabaseBinding(sourceDb, expected);
    const source = getNodeSqliteKysely<RecoveryDatabase>(sourceDb);
    const stage = getNodeSqliteKysely<RecoveryDatabase>(stagedDb);
    const histories = executeSqliteQuerySync(
      sourceDb,
      source.selectFrom("update_runs").selectAll(),
    ).rows;
    for (const row of histories) {
      executeSqliteQuerySync(
        stagedDb,
        stage
          .insertInto("update_runs")
          .values(row)
          .onConflict((conflict) => conflict.column("run_id").doUpdateSet(row)),
      );
    }
    const recoveries = executeSqliteQuerySync(
      sourceDb,
      source
        .selectFrom("config_machine_state")
        .selectAll()
        .where("state_key", ">=", UPDATE_RECOVERY_KEY_PREFIX)
        .where("state_key", "<", UPDATE_RECOVERY_KEY_END),
    ).rows;
    executeSqliteQuerySync(
      stagedDb,
      stage
        .deleteFrom("config_machine_state")
        .where("state_key", ">=", UPDATE_RECOVERY_KEY_PREFIX)
        .where("state_key", "<", UPDATE_RECOVERY_KEY_END)
        .where(
          "state_key",
          "not in",
          recoveries.map((row) => row.state_key),
        ),
    );
    for (const row of recoveries) {
      // Decode all carried operational rows; corrupt facts must not be published.
      decodeUpdateRecovery(row.value_json, row.state_key.slice(UPDATE_RECOVERY_KEY_PREFIX.length));
      executeSqliteQuerySync(
        stagedDb,
        stage
          .insertInto("config_machine_state")
          .values(row)
          .onConflict((conflict) => conflict.column("state_key").doUpdateSet(row)),
      );
    }
    for (const db of [sourceDb, stagedDb]) {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<RecoveryDatabase>(db)
          .updateTable("config_machine_state")
          .set({ value_json: raw, updated_at_ms: record.updatedAtMs })
          .where("state_key", "=", UPDATE_RECOVERY_KEY_PREFIX + record.runId),
      );
    }
    params.validateStagedDatabase(stagedDb);
    assertSqliteIntegrity(stagedDb, "update recovery staged database");
    sourceBinding = readUpdateRecoveryDatabaseBinding(sourceDb, record);
    if (sourceBinding.sha256 !== sourceBefore.sha256) {
      throw new UpdateRecoveryConflictError();
    }
    stagedBinding = readUpdateRecoveryDatabaseBinding(stagedDb, record);
    fence.assertCurrent();
    stagedDb.exec("COMMIT"); // sqlite-allow-raw -- Stage cannot be published yet.
    fence.assertCurrent();
    sourceDb.exec("COMMIT"); // sqlite-allow-raw -- Complete matching source intent.
  } catch (error) {
    if (stagedDb.isTransaction) {
      stagedDb.exec("ROLLBACK"); // sqlite-allow-raw -- Discard uncommitted private copy.
    }
    if (sourceDb.isTransaction) {
      sourceDb.exec("ROLLBACK"); // sqlite-allow-raw -- Preserve source on copy failure.
    }
    throw error;
  }
  return { record: decodeUpdateRecovery(raw, record.runId), sourceBinding, stagedBinding };
}

/** Exact current row and timestamp for a package effect immediately after awaited observation. */
export function assertExactUpdateRecoveryClaim(
  expected: UpdateRecoveryRecord,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): void {
  assertUpdateRecoveryClaim(expected, fence, options);
  const found = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
    assertExactRecovery(db, expected);
    return true;
  }, options);
  if (!found) {
    throw new UpdateRecoveryConflictError();
  }
  if (fence.assertCurrent() !== undefined) {
    throw new Error("Recovery exclusion must complete synchronously");
  }
}
