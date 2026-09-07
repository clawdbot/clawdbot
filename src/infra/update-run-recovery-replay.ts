import path from "node:path";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  restoreUpdateCheckpointResource,
  type UpdateCheckpointRestoreObservation,
  type UpdateCheckpointRestoreResult,
} from "./update-checkpoint-restore.js";
import { createUpdateRecoveryCheckpointAdapter } from "./update-run-recovery-checkpoint.js";
import {
  UpdateRecoveryConflictError,
  UpdateRecoveryRecordSchema,
} from "./update-run-recovery-schema.js";
import { assertExecutingClaim, assertRecoveryFence } from "./update-run-recovery-store.js";
import type { UpdateRecoveryRecord } from "./update-run-recovery.js";

type AdapterParams = Parameters<typeof createUpdateRecoveryCheckpointAdapter>[0];
type Inspection = Awaited<
  ReturnType<ReturnType<typeof createUpdateRecoveryCheckpointAdapter>["inspect"]>
>;
type ReplayResult =
  | { status: "preparing"; record: UpdateRecoveryRecord }
  | {
      status: "conflict";
      record: UpdateRecoveryRecord;
      observations: UpdateCheckpointRestoreObservation[];
    }
  | { status: "unavailable"; record: UpdateRecoveryRecord; result: UpdateCheckpointRestoreResult }
  | {
      status: "verified";
      record: UpdateRecoveryRecord;
      observations: UpdateCheckpointRestoreObservation[];
    };

// Complements (does not replace) executor-held cross-process exclusion. Two
// drivers using the same live fence must not interleave awaited filesystem work.
const activeDatabases = new Set<string>();

/**
 * Replay ONE already-sealed plan. No plan generation, runtime/daemon command,
 * terminal write, artifact deletion, or serving/restart authorization.
 * Create a fresh driver from read-only reconciled evidence after ANY return or
 * exception; a lost return is not permission to reuse stale in-memory progress.
 */
export function createUpdateRecoveryCheckpointReplay(
  params: AdapterParams & {
    /**
     * Called only after read-only publication reconciliation. The runtime owner
     * establishes actual prior-runtime readiness, without admission, history or
     * lease cleanup, and returns with database handles closed for reinspection.
     * No identity/schema-only fallback is supplied by recovery.
     */
    prepareCanonicalWrite: (record: UpdateRecoveryRecord) => Promise<void>;
    /** Established SQLite/runtime owner closes its handles after every write attempt. */
    closeCanonicalDatabase: () => Promise<void>;
  },
) {
  const initial = UpdateRecoveryRecordSchema.parse(params.expected);
  const adapter = createUpdateRecoveryCheckpointAdapter({ ...params, expected: initial });
  const databasePath = path.join(initial.checkpoint!.binding.stateDir, "state", "openclaw.sqlite");
  let used = false;
  const assertCurrent = () => {
    assertRecoveryFence(params.fence);
    const record = adapter.record;
    assertExecutingClaim(record);
    const intent = record.effects.at(-1);
    if (
      record.terminal ||
      record.nativeManager?.effects.at(-1)?.state === "intent" ||
      (record.nativeManager &&
        !(record.nativeManager.effects.at(-1)?.after ?? record.nativeManager.original).stopped) ||
      intent?.kind !== "checkpoint-restore" ||
      intent.state !== "intent" ||
      intent.runtime !== "previous" ||
      intent.resourceId !== record.checkpoint?.ref.checkpointId
    ) {
      throw new UpdateRecoveryConflictError();
    }
  };
  const conflict = (inspection: Inspection): ReplayResult => ({
    status: "conflict",
    record: adapter.record,
    observations: inspection.observations,
  });
  const reconciled = async () => {
    const inspection = await adapter.inspect();
    const cursor = adapter.record.restore!.resourceCursor;
    return {
      inspection,
      valid:
        inspection.status !== "conflict" &&
        inspection.observations.every(
          (observation) => observation.resourceCursor >= cursor || observation.observed === "after",
        ),
    };
  };
  function requireVoid(result: unknown) {
    if (result !== undefined) {
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
      }
      throw new TypeError("Runtime owner callback must complete without a value");
    }
  }
  const write = async (operation: () => Promise<UpdateRecoveryRecord>) => {
    const checked = await reconciled();
    if (!checked.valid || checked.inspection.observations[0]?.observed !== "after") {
      throw new UpdateRecoveryConflictError();
    }
    assertCurrent();
    try {
      requireVoid(await params.prepareCanonicalWrite(adapter.record));
      assertCurrent();
      // Adapter reinspects after the awaited runtime work, then checks exact
      // record + all nonactive rows after its synchronous runtime assertion.
      return await operation();
    } finally {
      requireVoid(await params.closeCanonicalDatabase());
    }
  };
  return {
    get record(): UpdateRecoveryRecord {
      return adapter.record;
    },
    async replay(): Promise<ReplayResult> {
      if (used || activeDatabases.has(databasePath)) {
        throw new UpdateRecoveryConflictError();
      }
      used = true;
      activeDatabases.add(databasePath);
      try {
        // An unsealed locator cannot authorize regeneration, replacement or a
        // claim write. Preparing retries belong to explicit adapter.prepare/seal.
        const progress = adapter.record.restore;
        if (!progress?.planSha256 || progress.phase === "preparing") {
          return { status: "preparing", record: adapter.record };
        }
        assertCurrent();
        let checked = await reconciled();
        if (!checked.valid) {
          return conflict(checked.inspection);
        }
        const resourceCount = checked.inspection.observations.length;
        if (resourceCount === 0) {
          throw new UpdateRecoveryConflictError();
        }
        let claimed = false;
        for (let remaining = resourceCount; remaining > 0; remaining--) {
          const record = adapter.record;
          const cursor = record.restore!.resourceCursor;
          const observation = checked.inspection.observations[cursor];
          if (
            !observation ||
            (record.restore!.phase === "observed" && observation.observed !== "after")
          ) {
            return conflict(checked.inspection);
          }
          if (record.restore!.phase === "intent") {
            // Apply also handles after-images: it reapplies fsync and the real
            // retained-runtime checks. In particular unavailable+after is NOT success.
            assertCurrent();
            const result = await restoreUpdateCheckpointResource({
              artifactRoot: params.artifactRoot,
              binding: record.checkpoint!.binding,
              planRef: {
                restoreId: progress.restoreId,
                checkpointId: progress.checkpointId,
                planPath: progress.planPath,
                planSha256: progress.planSha256,
              },
              resourceCursor: cursor,
              recoveryRecord: record,
              assertQuiescent: assertCurrent,
            });
            if (result.status === "unavailable") {
              return { status: "unavailable", record: adapter.record, result };
            }
            if (result.status === "conflict") {
              return { status: "conflict", record: adapter.record, observations: [result] };
            }
            // No record movement follows an ambiguous throw or unavailable.
            // Shared publication is now inspectable at its canonical path.
            if (!claimed) {
              await write(() => adapter.claimPublished());
              claimed = true;
            }
            await write(() => adapter.observe());
          }
          checked = await reconciled();
          if (!checked.valid || checked.inspection.observations[cursor]?.observed !== "after") {
            return conflict(checked.inspection);
          }
          if (cursor === resourceCount - 1) {
            assertCurrent();
            if (checked.inspection.status !== "verified") {
              return conflict(checked.inspection);
            }
            return {
              status: "verified",
              record: adapter.record,
              observations: checked.inspection.observations,
            };
          }
          if (!claimed) {
            await write(() => adapter.claimPublished());
            claimed = true;
          }
          await write(() => adapter.next());
          checked = await reconciled();
          if (!checked.valid) {
            return conflict(checked.inspection);
          }
        }
        throw new UpdateRecoveryConflictError();
      } finally {
        activeDatabases.delete(databasePath);
      }
    },
  };
}
