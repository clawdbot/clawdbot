import { isDeepStrictEqual } from "node:util";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  reopenUpdateCheckpointPreimages,
  type UpdateCheckpointRef,
  type UpdateCheckpointReadAccess,
} from "./update-checkpoint.js";
import {
  UpdateRecoveryConflictError,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";
import {
  assertExecutingClaim,
  assertRecoveryFence,
  mutateRecovery,
  requireRevision,
} from "./update-run-recovery-store.js";
import type { UpdateRecoveryFence, UpdateRecoveryRevision } from "./update-run-recovery.js";

function requireEarlyLifecycle(record: UpdateRecoveryRecord): void {
  assertExecutingClaim(record);
  if (
    record.checkpoint ||
    record.effects.length ||
    record.restore ||
    record.terminal ||
    record.primaryFailure
  ) {
    throw new UpdateRecoveryConflictError();
  }
}

function readCurrent(
  expected: UpdateRecoveryRevision,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions,
): UpdateRecoveryRecord {
  assertRecoveryFence(fence);
  const record = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => requireRevision(db, expected).record,
    options,
  );
  if (!record) {
    throw new UpdateRecoveryConflictError();
  }
  requireEarlyLifecycle(record);
  assertRecoveryFence(fence);
  return record;
}

function access(record: UpdateRecoveryRecord, artifactRoot: string): UpdateCheckpointReadAccess {
  if (!record.source) {
    throw new UpdateRecoveryConflictError();
  }
  return {
    artifactRoot,
    binding: {
      runId: record.runId,
      stateDir: record.source.stateDir,
      configPath: record.source.configPath,
      fromRuntime: {
        root: record.from.root,
        nodePath: record.from.nodePath,
        version: record.from.version,
      },
    },
  };
}

/**
 * Before stop/suppression, reopen the checkpoint owner's file-only artifact and
 * persist its exact ref/binding under the current claim. The caller owns source
 * exclusion throughout capture/reopen/binding; a late capture cannot prove
 * original bytes. No full-state checkpoint, lifecycle effect, or authority is
 * inferred from this slot. A different artifact cannot replace it on retry.
 */
export async function bindUpdateRecoveryPreimages(
  expected: UpdateRecoveryRevision,
  input: { ref: UpdateCheckpointRef; artifactRoot: string },
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): Promise<UpdateRecoveryRecord> {
  const current = readCurrent(expected, fence, options);
  const reopened = await reopenUpdateCheckpointPreimages(
    input.ref,
    access(current, input.artifactRoot),
  );
  return mutateRecovery(
    expected,
    fence,
    (record) => {
      requireEarlyLifecycle(record);
      if (!isDeepStrictEqual(record, current)) {
        throw new UpdateRecoveryConflictError();
      }
      const captured = { ref: reopened.ref, binding: reopened.manifest.binding };
      if (record.preimages) {
        if (
          !isDeepStrictEqual(
            { ref: record.preimages.ref, binding: record.preimages.binding },
            captured,
          )
        ) {
          throw new UpdateRecoveryConflictError();
        }
      } else {
        record.preimages = { ...captured, boundAtRevision: record.revision + 1 };
      }
    },
    options,
  );
}

/**
 * Await immediately before each early stop/suppression effect, while retaining
 * executor/source exclusion. Reopens original artifacts, not now-mutated live
 * sources. Rechecks exact current state after the await. Returned facts are not
 * transferable authority; reacquire and reconcile independently after reclaim.
 * Not valid after a full checkpoint or an ordinary update effect is recorded.
 */
export async function assertUpdateRecoveryPreimages(
  expected: UpdateRecoveryRevision,
  artifactRoot: string,
  fence: UpdateRecoveryFence,
  options: OpenClawStateDatabaseOptions = {},
): Promise<NonNullable<UpdateRecoveryRecord["preimages"]>> {
  const current = readCurrent(expected, fence, options);
  if (!current.preimages) {
    throw new UpdateRecoveryConflictError();
  }
  await reopenUpdateCheckpointPreimages(current.preimages.ref, access(current, artifactRoot));
  if (!isDeepStrictEqual(readCurrent(expected, fence, options), current)) {
    throw new UpdateRecoveryConflictError();
  }
  return current.preimages;
}
