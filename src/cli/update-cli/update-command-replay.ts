import { isDeepStrictEqual } from "node:util";
import { reopenPackageUpdateTransaction } from "../../infra/package-update-recovery.js";
import { currentUpdateRecoveryNativeFacts } from "../../infra/update-run-recovery-native-schema.js";
import { createUpdateRecoveryPackageHooks } from "../../infra/update-run-recovery-package.js";
import {
  claimUpdateRecovery,
  recordUpdateRecoveryObservation,
} from "../../infra/update-run-recovery.js";
import { withOpenClawStateReplayPublication } from "../../state/openclaw-state-publication.js";
import { assertOpenClawStateReplayWritersStopped } from "../../state/openclaw-state-replay-drain.js";
import type { UpdateCommandOptions } from "./shared.js";
import { createUpdateCommandCheckpointReplayAccess } from "./update-command-checkpoint-replay.js";
import { readUpdateCommandNativeObservation } from "./update-command-native-observation.js";
import {
  replayUpdateCommandRecovery,
  UpdateCommandRecoveryPendingError,
} from "./update-command-recovery.js";
import { inspectUpdateCommandSealedReplay } from "./update-command-replay-inspection.js";
import { withUpdateCommandSourceOwnership } from "./update-command-source-ownership.js";

/** Resume the original sealed intent. No canonical lease acquisition, package
 * rollback, plan regeneration or history admission may precede reconciliation. */
export async function resumeSealedUpdateCommandRestore(
  opts: UpdateCommandOptions,
  timeoutMs?: number,
) {
  const { recovery, run } = opts;
  if (!recovery || !run || recovery.getRecord().runId !== run.runId) {
    throw new UpdateCommandRecoveryPendingError(
      "Sealed replay requires the actual admitted executor.",
    );
  }
  const expected = recovery.getRecord();
  if (!expected.package || !expected.nativeManager) {
    throw new UpdateCommandRecoveryPendingError(
      "Sealed replay lacks original package and native custody.",
    );
  }
  return await withUpdateCommandSourceOwnership(
    { recovery, env: run.env, replay: true },
    async (source) => {
      const assertCurrent = source.assertCurrent;
      const inspect = () => inspectUpdateCommandSealedReplay(expected, run.env);
      const initial = await inspect();
      assertCurrent();
      const native = await readUpdateCommandNativeObservation({
        record: expected,
        env: run.env,
        definitionPaths: source.definitionPaths,
        assertCurrent,
        timeoutMs,
      });
      assertCurrent();
      if (
        !native.facts.stopped ||
        expected.nativeManager!.effects.at(-1)?.state === "intent" ||
        !isDeepStrictEqual(native.identity, expected.nativeManager!.identity) ||
        !isDeepStrictEqual(native.facts, currentUpdateRecoveryNativeFacts(expected.nativeManager!))
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "Fresh replay cannot confirm the stopped native owner.",
        );
      }
      const owned = { ...recovery, fence: { assertCurrent } };
      const descriptor = expected.package!.descriptor;
      const opened = await reopenPackageUpdateTransaction({
        descriptor,
        expectedLiveRoot: expected.from.root,
        expectedBinDir: descriptor.binDir,
        expectedTransactionId: expected.transactionId,
        hooks: createUpdateRecoveryPackageHooks(owned),
        timeoutMs,
      });
      assertCurrent();
      if (
        opened.status !== "ready" ||
        opened.observed.observation.previous !== "live" ||
        opened.observed.observation.candidate === "live" ||
        !["previous", "both"].includes(opened.observed.observation.launchers)
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "Sealed replay has not retained the restored previous package.",
        );
      }
      owned.checkpointReplay = {
        withDatabaseFilePublication: (operation) =>
          withOpenClawStateReplayPublication(
            {
              databasePath: initial.databasePath,
              assertCurrent,
              async assertWritersStopped() {
                const checked = await inspect();
                assertCurrent();
                assertOpenClawStateReplayWritersStopped(
                  { path: checked.evidencePath, env: run.env },
                  assertCurrent,
                );
                // Inspection follows the read-only drainage read too; no late snapshot
                // can replace the immutable pre-publication binding.
                await inspect();
                assertCurrent();
              },
            },
            operation,
          ),
        access: createUpdateCommandCheckpointReplayAccess({
          databasePath: initial.databasePath,
          artifactRoot: source.artifactRoot,
          transaction: opened.transaction,
          assertCurrent,
          timeoutMs,
        }),
      };
      const result = await replayUpdateCommandRecovery({ ...opts, recovery: owned });
      assertCurrent();
      if (result.status !== "verified") {
        throw new UpdateCommandRecoveryPendingError("Sealed restoration remains unverified.");
      }
      let current = recovery.getRecord();
      if (current.claimId === expected.claimId) {
        // A fully observed final cursor can return without a driver CAS. Reclaim
        // only now, after real publication/runtime validation and owner settlement.
        current = claimUpdateRecovery(current, owned.fence, recovery.options);
        recovery.onRecord(current);
      }
      const restore = current.effects.at(-1);
      if (
        restore?.kind !== "checkpoint-restore" ||
        restore.state !== "intent" ||
        !current.restore?.planSha256
      ) {
        throw new UpdateCommandRecoveryPendingError("Sealed restoration lost its original intent.");
      }
      recovery.onRecord(
        recordUpdateRecoveryObservation(
          current,
          {
            effectId: restore.effectId,
            observedIdentity: current.restore.planSha256,
          },
          owned.fence,
          recovery.options,
        ),
      );
    },
  );
}
