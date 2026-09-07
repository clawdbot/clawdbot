import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { reopenPackageUpdateTransaction } from "../../infra/package-update-recovery.js";
import {
  abortUpdatePreparation,
  assertUnstartedUpdatePreparation,
} from "../../infra/update-run-recovery-preparation.js";
import {
  assertExactUpdateRecoveryClaim,
  claimUpdateRecovery,
  type UpdateRecoveryRecord,
} from "../../infra/update-run-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { readUpdateCommandNativeObservation } from "./update-command-native-observation.js";
import { restoreUpdatePreparationNative } from "./update-command-preparation-native.js";
import {
  UpdateCommandRecoveryPendingError,
  type UpdateCommandRecovery,
} from "./update-command-recovery.js";
import { discoverUpdateCommandRecovery } from "./update-command-replay-inspection.js";
import { withUpdateCommandSourceOwnership } from "./update-command-source-ownership.js";

/** Reconcile only preparation before any package effect. A stop-only native
 * history must be restored with fresh observations under the same source owners.
 * A failed historical result is not a checkpoint, serving receipt, or rollback.
 * Retained artifacts stay intact and the next update requires a new invocation. */
export async function resumeUnstartedUpdatePreparation(params: {
  pending: UpdateRecoveryRecord;
  root: string;
  env: NodeJS.ProcessEnv;
  opts: UpdateCommandOptions;
  timeoutMs?: number;
}): Promise<boolean> {
  const { pending, env } = params;
  assertUnstartedUpdatePreparation(pending);
  if (params.root !== pending.from.root || (await fs.realpath(params.root)) !== pending.from.root) {
    throw new UpdateCommandRecoveryPendingError("Preparation belongs to a different installation.");
  }
  return await withOwnedManagedUpdateEnv(env, () =>
    withUpdateCommandExecutor(pending.runId, async (executor) => {
      const fence = await executor.enter(params.root);
      const checked = await discoverUpdateCommandRecovery(env);
      fence.assertCurrent();
      if (!isDeepStrictEqual(checked, pending)) {
        throw new UpdateCommandRecoveryPendingError(
          "Preparation changed during executor admission.",
        );
      }
      let record = claimUpdateRecovery(pending, fence, { env });
      const recovery: UpdateCommandRecovery = {
        fence,
        options: { env },
        getRecord: () => record,
        onRecord(next) {
          fence.assertCurrent();
          record = next;
        },
        assertReady() {
          throw new Error("Preparation cannot supply serving readiness");
        },
      };
      await withUpdateCommandSourceOwnership({ recovery, env }, async (source) => {
        const refuseEffect = () => {
          throw new Error("Preparation reconciliation cannot mutate packages");
        };
        const descriptor = record.package!.descriptor;
        const native = await readUpdateCommandNativeObservation({
          record,
          env,
          definitionPaths: source.definitionPaths,
          assertCurrent: source.assertCurrent,
          timeoutMs: params.timeoutMs,
        });
        if (
          !isDeepStrictEqual(native.identity, record.nativeManager!.identity) ||
          (record.nativeManager!.effects.length === 0 &&
            !isDeepStrictEqual(native.facts, record.nativeManager!.original))
        ) {
          throw new UpdateCommandRecoveryPendingError(
            "Original native state changed after preparation.",
          );
        }
        const opened = await reopenPackageUpdateTransaction({
          descriptor,
          expectedLiveRoot: params.root,
          expectedBinDir: descriptor.binDir,
          expectedTransactionId: record.transactionId,
          hooks: {
            transactionId: record.transactionId,
            persistDescriptor: refuseEffect,
            beforeEffect: refuseEffect,
          },
        });
        source.assertCurrent();
        if (
          opened.status !== "ready" ||
          !isDeepStrictEqual(opened.observed, record.package!.observed)
        ) {
          throw new UpdateCommandRecoveryPendingError("Prepared package identity has changed.");
        }
        await restoreUpdatePreparationNative({
          recovery,
          env,
          definitionPaths: source.definitionPaths,
          assertCurrent: source.assertCurrent,
          verifyUnchanged: async () => {
            const beforeStart = await opened.transaction.observe();
            source.assertCurrent();
            if (
              beforeStart.status !== "verified" ||
              !isDeepStrictEqual(beforeStart, record.package!.observed)
            ) {
              throw new UpdateCommandRecoveryPendingError(
                "Package changed before native restoration.",
              );
            }
            await source.verifySources();
          },
          timeoutMs: params.timeoutMs,
        });
        const closingPackage = await opened.transaction.observe();
        source.assertCurrent();
        if (
          closingPackage.status !== "verified" ||
          !isDeepStrictEqual(closingPackage, record.package!.observed)
        ) {
          throw new UpdateCommandRecoveryPendingError("Package changed during native restoration.");
        }
        const closingNative = await readUpdateCommandNativeObservation({
          record,
          env,
          definitionPaths: source.definitionPaths,
          assertCurrent: source.assertCurrent,
          timeoutMs: params.timeoutMs,
        });
        if (
          !isDeepStrictEqual(closingNative.identity, native.identity) ||
          !isDeepStrictEqual(closingNative.facts, record.nativeManager!.original)
        ) {
          throw new UpdateCommandRecoveryPendingError(
            "Native state changed during package inspection.",
          );
        }
        await source.verifySources();
        assertExactUpdateRecoveryClaim(record, { assertCurrent: source.assertCurrent }, { env });
        recovery.onRecord(
          abortUpdatePreparation(
            record,
            closingPackage,
            { assertCurrent: source.assertCurrent },
            { env },
          ),
        );
      });
      if (params.opts.json) {
        defaultRuntime.writeJson({
          status: "ok",
          reason: "preparation-reconciled",
          runId: pending.runId,
          updateStatus: "failed",
          nextAction: "Run update again to start a new attempt.",
        });
      } else {
        defaultRuntime.log(
          "Original package, sources and native state reconciled; the interrupted attempt was recorded as failed. Run update again to start a new attempt.",
        );
      }
      return true;
    }),
  );
}
