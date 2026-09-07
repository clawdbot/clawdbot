import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withConfigWriteLock } from "../../config/write-lock.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import {
  checkpointContentMatches,
  inspectCheckpointFile,
} from "../../infra/update-checkpoint-files.js";
import { reopenUpdateCheckpointRestorePlan } from "../../infra/update-checkpoint-plan.js";
import {
  reopenUpdateCheckpointPreimages,
  reopenUpdateCheckpoint,
  type ReopenedUpdateCheckpoint,
} from "../../infra/update-checkpoint.js";
import { assertExactUpdateRecoveryClaim } from "../../infra/update-run-recovery.js";
import {
  UpdateCommandRecoveryPendingError,
  type UpdateCommandRecovery,
} from "./update-command-recovery.js";
import { inspectUpdateCommandSealedReplay } from "./update-command-replay-inspection.js";

type SourceOwnership = {
  artifactRoot: string;
  original: ReopenedUpdateCheckpoint;
  current: ReopenedUpdateCheckpoint;
  definitionPaths: string[];
  assertCurrent: () => void;
  verifySources: () => Promise<void>;
};

/** Reacquire the real source owners and compare exact original file generations.
 * No late snapshot can replace an original preimage. Callers must join admitted
 * effects before returning; assertions cannot escape this lexical interval.
 */
export async function withUpdateCommandSourceOwnership<T>(
  params: {
    recovery: UpdateCommandRecovery;
    env: NodeJS.ProcessEnv;
    mutation?: true;
    restored?: true;
    replay?: true;
  },
  operation: (source: SourceOwnership) => Promise<T>,
): Promise<T> {
  const { recovery, env } = params;
  const initial = recovery.getRecord();
  const { source, preimages } = initial;
  if (!source || !preimages) {
    throw new UpdateCommandRecoveryPendingError("Original source binding is missing.");
  }
  const artifactRoot = path.join(
    path.dirname(source.stateDir),
    `.${path.basename(source.stateDir)}-update-checkpoints`,
  );
  return await withGatewayServiceOperationLock(env, async (assertNative) => {
    let active = true;
    const assertCurrent = () => {
      if (!active) {
        throw new UpdateCommandRecoveryPendingError("Original source ownership has closed.");
      }
      assertNative();
      recovery.fence.assertCurrent();
    };
    try {
      const fence = { assertCurrent };
      const verifyRecord = async () => {
        assertCurrent();
        if (params.replay) {
          await inspectUpdateCommandSealedReplay(initial, env);
        } else {
          assertExactUpdateRecoveryClaim(initial, fence, recovery.options);
        }
        assertCurrent();
      };
      await verifyRecord();
      const original = await reopenUpdateCheckpointPreimages(preimages.ref, {
        artifactRoot,
        binding: preimages.binding,
      });
      const progress = initial.restore;
      const restoreEffect = initial.effects.findLast(
        (effect) => effect.kind === "checkpoint-restore",
      );
      if (
        params.restored &&
        (!initial.primaryFailure ||
          !initial.checkpoint ||
          progress?.phase !== "observed" ||
          !progress.planSha256 ||
          restoreEffect?.state !== "observed" ||
          restoreEffect.observedIdentity !== progress.planSha256)
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "Previous sources require completed checkpoint publication.",
        );
      }
      const latest =
        params.restored || params.replay
          ? initial.checkpoint
          : params.mutation
            ? (initial.afterImages?.at(-1)?.afterUpdate ?? initial.checkpoint)
            : undefined;
      const current = latest
        ? await reopenUpdateCheckpoint(latest.ref, { artifactRoot, binding: latest.binding })
        : original;
      const published =
        params.restored && progress?.planSha256 && initial.checkpoint
          ? await reopenUpdateCheckpointRestorePlan(
              {
                restoreId: progress.restoreId,
                checkpointId: progress.checkpointId,
                planPath: progress.planPath,
                planSha256: progress.planSha256,
              },
              { artifactRoot, binding: initial.checkpoint.binding },
            )
          : undefined;
      if (
        published &&
        (progress?.resourceCursor !== published.plan.resources.length - 1 ||
          !isDeepStrictEqual(published.plan.checkpointRef, initial.checkpoint?.ref))
      ) {
        throw new UpdateCommandRecoveryPendingError("Checkpoint publication is incomplete.");
      }
      await verifyRecord();
      const configFiles = current.manifest.resources
        .filter((r) => r.kind === "config")
        .map((r) => r.sourcePath)
        .filter((file) => file !== source.configPath)
        .toSorted();
      const files = [source.configPath, ...configFiles];
      const definitionPaths = current.manifest.resources
        .filter((r) => r.kind === "service")
        .map((r) => r.sourcePath);
      const verifySources = async () => {
        if (params.replay) {
          await verifyRecord();
          return;
        }
        for (const resource of current.manifest.resources) {
          if (resource.kind === "sqlite" || resource.restore !== "replace") {
            continue;
          }
          const observed = await inspectCheckpointFile(resource.sourcePath);
          assertCurrent();
          const restored = published?.plan.resources.find(
            (entry) => entry.sourcePath === resource.sourcePath,
          );
          // Publication renames the sealed replacement: only root ctime changes.
          // Require its exact inode, content, mode and descendants, not the old
          // captured inode and not a new snapshot of whatever happens to be live.
          const expected = restored?.after;
          const matches = published
            ? restored !== undefined &&
              checkpointContentMatches(observed, expected ?? null) &&
              (observed === null ||
                (expected !== null &&
                  expected !== undefined &&
                  observed.identity.dev === expected.identity.dev &&
                  observed.identity.ino === expected.identity.ino &&
                  observed.identity.size === expected.identity.size &&
                  observed.identity.mtimeMs === expected.identity.mtimeMs &&
                  observed.descendantIdentitySha256 === expected.descendantIdentitySha256))
            : isDeepStrictEqual(observed, resource.sourceState);
          if (!matches) {
            throw new UpdateCommandRecoveryPendingError(
              "Original source changed before native preparation or checkpoint capture.",
            );
          }
        }
      };
      const lockNext = async (index: number): Promise<T> => {
        const file = files[index];
        if (file !== undefined) {
          return await withConfigWriteLock(file, () => lockNext(index + 1), env, assertCurrent);
        }
        await verifyRecord();
        await verifySources();
        const result = await operation({
          artifactRoot,
          original,
          current,
          definitionPaths,
          assertCurrent,
          verifySources,
        });
        assertCurrent();
        return result;
      };
      return await lockNext(0);
    } finally {
      active = false;
    }
  });
}
