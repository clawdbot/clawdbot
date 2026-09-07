import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { withConfigWriteLock } from "../../config/write-lock.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import { inspectCheckpointFile } from "../../infra/update-checkpoint-files.js";
import { reopenUpdateCheckpointPreimages } from "../../infra/update-checkpoint.js";
import {
  recordUpdateRecoveryNativeIntent,
  recordUpdateRecoveryNativeObservation,
} from "../../infra/update-run-recovery-native.js";
import { assertUpdateRecoveryPreimages } from "../../infra/update-run-recovery-preimage.js";
import { assertExactUpdateRecoveryClaim } from "../../infra/update-run-recovery.js";
import { readUpdateCommandNativeObservation } from "./update-command-native-observation.js";
import {
  UpdateCommandRecoveryPendingError,
  type UpdateCommandRecovery,
} from "./update-command-recovery.js";

type NativeEffect = (assertCurrent: () => void) => Promise<void>;
export type UpdateCommandNativePreparation = {
  suppress: (effect: NativeEffect) => Promise<void>;
  stop: (effect: NativeEffect) => Promise<void>;
};

/** Original file ownership and the native interval remain live through intent,
 * the actual daemon operation, and its independently observed acknowledgement.
 * A native error cannot authorize legacy compensation or artifact retirement.
 */
export async function withUpdateCommandNativePreparation<T>(
  params: {
    recovery: UpdateCommandRecovery;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
  operation: (native: UpdateCommandNativePreparation) => Promise<T>,
): Promise<T> {
  const recovery = params.recovery;
  const initial = recovery.getRecord();
  const { source, preimages } = initial;
  if (!source || !preimages || !initial.nativeManager) {
    throw new UpdateCommandRecoveryPendingError(
      "Native preparation requires bound original state.",
    );
  }
  const artifactRoot = path.join(
    path.dirname(source.stateDir),
    `.${path.basename(source.stateDir)}-update-checkpoints`,
  );
  return await withGatewayServiceOperationLock(params.env, async (assertNative) => {
    const assertCurrent = () => {
      assertNative();
      recovery.fence.assertCurrent();
    };
    const fence = { assertCurrent };
    assertExactUpdateRecoveryClaim(initial, fence, recovery.options);
    const original = await reopenUpdateCheckpointPreimages(preimages.ref, {
      artifactRoot,
      binding: preimages.binding,
    });
    assertExactUpdateRecoveryClaim(initial, fence, recovery.options);
    const configFiles = original.manifest.resources
      .filter((r) => r.kind === "config")
      .map((r) => r.sourcePath)
      .filter((file) => file !== source.configPath)
      .toSorted();
    const files = [source.configPath, ...configFiles];
    const definitionPaths = original.manifest.resources
      .filter((r) => r.kind === "service")
      .map((r) => r.sourcePath);
    const verifySources = async () => {
      for (const resource of original.manifest.resources) {
        const current = await inspectCheckpointFile(resource.sourcePath);
        assertCurrent();
        if (!isDeepStrictEqual(current, resource.sourceState)) {
          throw new UpdateCommandRecoveryPendingError(
            "Original source changed before native preparation.",
          );
        }
      }
    };
    const effects = new Set<Promise<void>>();
    let accepting = false;
    let active = true;
    const apply = async (action: "stop" | "suppress", effect: NativeEffect) => {
      if (!accepting) {
        throw new UpdateCommandRecoveryPendingError("Native preparation admission has closed.");
      }
      const pending = withGatewayServiceOperationLock(params.env, async (assertEffect) => {
        const assertOwned = () => {
          if (!active) {
            throw new UpdateCommandRecoveryPendingError("Native source ownership has closed.");
          }
          assertEffect();
          assertCurrent();
        };
        const current = recovery.getRecord();
        const actionFence = { assertCurrent: assertOwned };
        try {
          await assertUpdateRecoveryPreimages(current, artifactRoot, actionFence, recovery.options);
          await verifySources();
          assertExactUpdateRecoveryClaim(current, actionFence, recovery.options);
          const manager = current.nativeManager;
          if (!manager) {
            throw new UpdateCommandRecoveryPendingError("Native original binding was lost.");
          }
          const prior = manager.effects.at(-1);
          const before = prior?.after ?? manager.original;
          const target =
            action === "suppress"
              ? { ...before, enabled: false }
              : {
                  ...before,
                  stopped: true,
                  loaded: manager.identity.platform === "darwin" ? false : before.loaded,
                };
          const effectId =
            prior?.state === "intent" && prior.action === action ? prior.effectId : randomUUID();
          const observe = () =>
            readUpdateCommandNativeObservation({
              record: current,
              env: params.env,
              definitionPaths,
              assertCurrent: assertOwned,
              timeoutMs: params.timeoutMs,
            });
          const intent = await recordUpdateRecoveryNativeIntent(
            current,
            {
              effectId,
              action,
              target,
              observe,
            },
            actionFence,
            recovery.options,
          );
          recovery.onRecord(intent.record);
          let failed = false;
          let failure: unknown;
          if (intent.status === "before") {
            try {
              assertOwned();
              await effect(assertOwned);
            } catch (error) {
              failed = true;
              failure = error;
            }
          }
          assertOwned();
          await verifySources();
          const observed = await recordUpdateRecoveryNativeObservation(
            intent.record,
            effectId,
            observe,
            actionFence,
            recovery.options,
          );
          recovery.onRecord(observed.record);
          if (observed.status !== "after" || failed) {
            throw new UpdateCommandRecoveryPendingError(
              "Native preparation remains pending reconciliation.",
              { cause: failure },
            );
          }
        } catch (cause) {
          if (cause instanceof UpdateCommandRecoveryPendingError) {
            throw cause;
          }
          throw new UpdateCommandRecoveryPendingError(
            "Native preparation remains pending reconciliation.",
            { cause },
          );
        }
      });
      effects.add(pending);
      // Retain settled rejections too: a caught effect is still a failed native interval.
      return await pending;
    };
    const lockNext = async (index: number): Promise<T> => {
      const file = files[index];
      if (file !== undefined) {
        return await withConfigWriteLock(file, () => lockNext(index + 1), params.env);
      }
      assertExactUpdateRecoveryClaim(initial, fence, recovery.options);
      await verifySources();
      accepting = true;
      const [outcome] = await Promise.allSettled([
        Promise.resolve().then(() =>
          operation({
            stop: (effect) => apply("stop", effect),
            suppress: (effect) => apply("suppress", effect),
          }),
        ),
      ]);
      accepting = false;
      // Join admitted native work before releasing config/include locks. The
      // outer daemon lock alone cannot retain these inner source owners.
      const failures: unknown[] = [];
      while (effects.size) {
        const batch = [...effects];
        effects.clear();
        for (const result of await Promise.allSettled(batch)) {
          if (result.status === "rejected") {
            failures.push(result.reason);
          }
        }
      }
      active = false;
      if (failures.length) {
        throw new UpdateCommandRecoveryPendingError(
          "Native work did not settle under source ownership.",
          {
            cause: new AggregateError(
              outcome.status === "rejected" ? [outcome.reason, ...failures] : failures,
            ),
          },
        );
      }
      if (outcome.status === "rejected") {
        throw outcome.reason instanceof Error
          ? outcome.reason
          : new UpdateCommandRecoveryPendingError("Native preparation failed.", {
              cause: outcome.reason,
            });
      }
      return outcome.value;
    };
    return await lockNext(0);
  });
}
