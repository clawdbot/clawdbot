import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  prepareUpdateCheckpointRestore,
  reopenUpdateCheckpointRestorePlan,
  sealUpdateCheckpointRestoreSharedDatabase,
  verifyUpdateCheckpointRestore,
  type UpdateCheckpointRestorePlanRef,
} from "./update-checkpoint-restore.js";
import type { UpdateCheckpointReadAccess } from "./update-checkpoint.js";
import { validateUpdateRecoveryPublicationDatabaseAtPath } from "./update-run-recovery-publication.js";
import { UpdateRecoveryRecordSchema } from "./update-run-recovery-schema.js";
import {
  claimUpdateRecovery,
  prepareUpdateRecoveryCarryForward,
  recordUpdateRecoveryRestoreProgress,
  UpdateRecoveryConflictError,
  type UpdateRecoveryFence,
  type UpdateRecoveryRecord,
} from "./update-run-recovery.js";

type PublishedRecord = UpdateCheckpointReadAccess & {
  planRef: UpdateCheckpointRestorePlanRef;
  recoveryRecord: UpdateRecoveryRecord;
};

/**
 * Executor-owned bridge, never deserialized authority. The runtime assertion must
 * establish that the executor has reopened through the actual prior runtime;
 * checking a schema version or copying the supplied identity is insufficient.
 * No claim, database open, or lifecycle mutation occurs while creating it.
 */
export function createUpdateRecoveryCheckpointAdapter(params: {
  expected: UpdateRecoveryRecord;
  artifactRoot: string;
  database: OpenClawStateDatabaseOptions;
  fence: UpdateRecoveryFence;
  validateStagedDatabase: (db: DatabaseSync) => undefined;
  assertMatchingRuntime: (runtime: UpdateRecoveryRecord["from"]) => undefined;
  /**
   * Live publication owner opens ONLY the synchronous canonical writer aperture.
   * It validates the original bindings/exact record before and after the CAS and
   * closes issued handles before resolving. Awaited inspection/runtime readiness
   * must stay outside write. Omit only for a standalone, non-lease executor.
   */
  bindPublishedRecord?: (
    publication: PublishedRecord,
    write: (assertOwned: () => void) => UpdateRecoveryRecord,
  ) => Promise<PublishedRecord>;
}) {
  let current = UpdateRecoveryRecordSchema.parse(params.expected);
  if (!current.checkpoint || !current.afterImages?.length) {
    throw new UpdateRecoveryConflictError();
  }
  const checkpoint = current.checkpoint;
  const afterImage = current.afterImages.at(-1)!;
  let busy = false;
  let writeFailed = false;
  function assertUsable() {
    if (writeFailed) {
      throw new UpdateRecoveryConflictError();
    }
  }
  async function exclusively<T>(operation: () => Promise<T>): Promise<T> {
    if (busy || writeFailed) {
      throw new UpdateRecoveryConflictError();
    }
    busy = true;
    try {
      return await operation();
    } finally {
      busy = false;
    }
  }
  const databasePath = path.resolve(
    params.database.path ?? resolveOpenClawStateSqlitePath(params.database.env ?? process.env),
  );
  if (databasePath !== path.join(checkpoint.binding.stateDir, "state", "openclaw.sqlite")) {
    throw new UpdateRecoveryConflictError();
  }
  const database = { ...params.database, path: databasePath };
  const access = { artifactRoot: params.artifactRoot, binding: checkpoint.binding };
  const assertQuiescent = () => params.fence.assertCurrent();
  function requireSynchronous(result: unknown, label: string): void {
    if (result !== undefined) {
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
      }
      throw new TypeError(`${label} must be synchronous and return undefined`);
    }
  }
  const validateStagedDatabase = (db: DatabaseSync): undefined => {
    requireSynchronous(params.validateStagedDatabase(db), "validateStagedDatabase");
    return undefined;
  };

  function planRef(): UpdateCheckpointRestorePlanRef {
    const progress = current.restore;
    if (!progress?.planSha256 || progress.phase === "preparing") {
      throw new UpdateRecoveryConflictError();
    }
    return {
      restoreId: progress.restoreId,
      checkpointId: progress.checkpointId,
      planPath: progress.planPath,
      planSha256: progress.planSha256,
    };
  }

  async function readPlan(ref: UpdateCheckpointRestorePlanRef) {
    const progress = current.restore;
    if (
      !progress ||
      progress.restoreId !== ref.restoreId ||
      progress.checkpointId !== ref.checkpointId ||
      progress.planPath !== ref.planPath ||
      (progress.planSha256 !== null && progress.planSha256 !== ref.planSha256)
    ) {
      throw new UpdateRecoveryConflictError();
    }
    const reopened = await reopenUpdateCheckpointRestorePlan(ref, access);
    const shared = reopened.plan.resources[0];
    if (
      !isDeepStrictEqual(reopened.plan.checkpointRef, checkpoint.ref) ||
      !isDeepStrictEqual(reopened.plan.afterUpdateRef, afterImage.afterUpdate.ref) ||
      !shared?.sqlite ||
      !shared.recovery ||
      shared.sourcePath !== databasePath ||
      shared.recovery.sourceBinding.runId !== current.runId ||
      shared.recovery.sourceBinding.transactionId !== current.transactionId ||
      current.restore!.resourceCursor >= reopened.plan.resources.length
    ) {
      throw new UpdateRecoveryConflictError();
    }
    return { reopened, shared, recovery: shared.recovery };
  }

  async function inspect() {
    const ref = planRef();
    const bound = await readPlan(ref);
    const result = await verifyUpdateCheckpointRestore({
      ...access,
      planRef: ref,
      recoveryRecord: current,
    });
    return { ...bound, result };
  }

  // Only an observed publication permits canonical-only claim/progress writes.
  // Recheck the active row and every other DB row AFTER all awaited inspection
  // and runtime assertions, immediately before the synchronous CAS transaction.
  async function published() {
    const inspected = await inspect();
    const cursor = current.restore!.resourceCursor;
    if (
      inspected.result.status === "conflict" ||
      inspected.result.observations[0]?.observed !== "after" ||
      inspected.result.observations.some(
        (entry) => entry.resourceCursor < cursor && entry.observed !== "after",
      )
    ) {
      throw new UpdateRecoveryConflictError();
    }
    return inspected;
  }

  function assertWritable(
    recovery: Awaited<ReturnType<typeof readPlan>>["recovery"],
    fence: UpdateRecoveryFence,
  ) {
    fence.assertCurrent();
    requireSynchronous(params.assertMatchingRuntime(current.from), "assertMatchingRuntime");
    fence.assertCurrent();
    validateUpdateRecoveryPublicationDatabaseAtPath(
      { ...recovery, role: "live-restored", expected: current },
      database,
    );
    fence.assertCurrent();
  }

  async function writePublished(
    checked: Awaited<ReturnType<typeof published>>,
    write: (fence: UpdateRecoveryFence) => UpdateRecoveryRecord,
  ): Promise<UpdateRecoveryRecord> {
    assertUsable();
    const bind = params.bindPublishedRecord;
    if (!bind) {
      assertWritable(checked.recovery, params.fence);
      current = write(params.fence);
      return UpdateRecoveryRecordSchema.parse(current);
    }
    const publication: PublishedRecord = {
      ...access,
      planRef: planRef(),
      recoveryRecord: UpdateRecoveryRecordSchema.parse(current),
    };
    let active = true;
    let called = false;
    let invalid = false;
    let written: UpdateRecoveryRecord | undefined;
    try {
      const updated = await bind(structuredClone(publication), (assertOwned) => {
        if (!active || called || writeFailed) {
          writeFailed = true;
          invalid = true;
          throw new UpdateRecoveryConflictError();
        }
        called = true;
        const fence = {
          assertCurrent() {
            assertUsable();
            requireSynchronous(assertOwned(), "publication ownership");
            requireSynchronous(params.fence.assertCurrent(), "recovery exclusion");
            assertUsable();
          },
        };
        // The bridge may await verification. Repeat exact readback here, inside
        // its synchronous aperture, and pass BOTH authorities into the transaction.
        assertWritable(checked.recovery, fence);
        const next = write(fence);
        written = UpdateRecoveryRecordSchema.parse(next);
        return next;
      });
      if (
        writeFailed ||
        invalid ||
        !written ||
        !isDeepStrictEqual(updated, { ...publication, recoveryRecord: written })
      ) {
        throw new UpdateRecoveryConflictError();
      }
      requireSynchronous(params.fence.assertCurrent(), "recovery exclusion");
      assertUsable();
      current = written;
      return UpdateRecoveryRecordSchema.parse(current);
    } catch (error) {
      // A CAS may have committed before an outer verification/acknowledgement
      // failed. Never retry this adapter or adopt unverified returned evidence.
      // The next executor must reconcile the exact durable record read-only.
      writeFailed = true;
      throw error;
    } finally {
      active = false;
    }
  }

  return {
    get record(): UpdateRecoveryRecord {
      return UpdateRecoveryRecordSchema.parse(current);
    },
    /** First pass: checkpoint owns all resource validation and the frozen locator. */
    prepare: () =>
      exclusively(async () => {
        const progress = current.restore;
        if (progress && progress.phase !== "preparing") {
          throw new UpdateRecoveryConflictError();
        }
        return prepareUpdateCheckpointRestore({
          ...access,
          assertQuiescent,
          checkpointRef: checkpoint.ref,
          afterUpdateRef: afterImage.afterUpdate.ref,
          ...(progress
            ? {
                preparingPlan: {
                  restoreId: progress.restoreId,
                  checkpointId: progress.checkpointId,
                  planPath: progress.planPath,
                },
              }
            : {}),
          prepareSharedDatabase({ sourceDb, stagedDb, planIdentity }) {
            const carried = prepareUpdateRecoveryCarryForward({
              sourceDb,
              stagedDb,
              expected: current,
              nextProgress: {
                ...planIdentity,
                planSha256: null,
                phase: "preparing",
                resourceCursor: 0,
              },
              fence: params.fence,
              validateStagedDatabase,
            });
            current = carried.record;
            return carried;
          },
        });
      }),
    /** Second pass: exact immutable plan, both records, no publication here. */
    seal: (ref: UpdateCheckpointRestorePlanRef) =>
      exclusively(async () => {
        await readPlan(ref);
        current = await sealUpdateCheckpointRestoreSharedDatabase({
          ...access,
          assertQuiescent,
          planRef: ref,
          recoveryRecord: current,
          fence: params.fence,
          validateStagedDatabase,
        });
        return UpdateRecoveryRecordSchema.parse(current);
      }),
    /** Inspection is evidence only; callers may use it before any runtime open. */
    inspect: () =>
      exclusively(async () => {
        return (await inspect()).result;
      }),
    claimPublished: () =>
      exclusively(async () => {
        const checked = await published();
        return writePublished(checked, (fence) => claimUpdateRecovery(current, fence, database));
      }),
    observe: () =>
      exclusively(async () => {
        const checked = await published();
        const progress = current.restore!;
        if (checked.result.observations[progress.resourceCursor]?.observed !== "after") {
          throw new UpdateRecoveryConflictError();
        }
        return writePublished(checked, (fence) =>
          recordUpdateRecoveryRestoreProgress(
            current,
            { ...progress, phase: "observed" },
            fence,
            database,
          ),
        );
      }),
    next: () =>
      exclusively(async () => {
        const checked = await published();
        const progress = current.restore!;
        if (
          progress.phase !== "observed" ||
          // Persisted progress is not evidence that this resource is still restored.
          checked.result.observations[progress.resourceCursor]?.observed !== "after" ||
          progress.resourceCursor + 1 >= checked.reopened.plan.resources.length
        ) {
          throw new UpdateRecoveryConflictError();
        }
        return writePublished(checked, (fence) =>
          recordUpdateRecoveryRestoreProgress(
            current,
            { ...progress, resourceCursor: progress.resourceCursor + 1, phase: "intent" },
            fence,
            database,
          ),
        );
      }),
  };
}
