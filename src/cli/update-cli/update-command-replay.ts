import { isDeepStrictEqual } from "node:util";
import { reopenPackageUpdateTransaction } from "../../infra/package-update-recovery.js";
import { reopenUpdateCheckpoint } from "../../infra/update-checkpoint.js";
import { currentUpdateRecoveryNativeFacts } from "../../infra/update-run-recovery-native-schema.js";
import { createUpdateRecoveryPackageHooks } from "../../infra/update-run-recovery-package.js";
import {
  assertExactUpdateRecoveryClaim,
  claimUpdateRecovery,
  recordUpdateRecoveryObservation,
} from "../../infra/update-run-recovery.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawStateReplayPublication } from "../../state/openclaw-state-publication.js";
import { assertOpenClawStateReplayWritersStopped } from "../../state/openclaw-state-replay-drain.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandAgentPublication } from "./update-command-agent-publication.js";
import { createUpdateCommandCheckpointReplayAccess } from "./update-command-checkpoint-replay.js";
import { readUpdateCommandNativeObservation } from "./update-command-native-observation.js";
import {
  replayUpdateCommandRecovery,
  UpdateCommandRecoveryPendingError,
} from "./update-command-recovery.js";
import { inspectUpdateCommandSealedReplay } from "./update-command-replay-inspection.js";
import { withUpdateCommandSourceOwnership } from "./update-command-source-ownership.js";

/** Publish the original checkpoint intent under fresh physical custody after
 * logical writers drain. A sealed plan is reconciled, never regenerated; a new
 * plan requires the exact canonical claim. Neither path acquires writer leases. */
export async function resumeUpdateCommandRestorePublication(
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
  const sealed = Boolean(expected.restore && expected.restore.phase !== "preparing");
  return await withUpdateCommandSourceOwnership(
    {
      recovery,
      env: run.env,
      ...(sealed ? { replay: true as const } : { mutation: true as const }),
    },
    async (source) => {
      const assertCurrent = source.assertCurrent;
      const inspect = async () => {
        if (sealed) {
          return inspectUpdateCommandSealedReplay(expected, run.env);
        }
        await source.verifySources();
        assertExactUpdateRecoveryClaim(expected, { assertCurrent }, recovery.options);
        const databasePath = resolveOpenClawStateSqlitePath(run.env);
        return { databasePath, evidencePath: databasePath };
      };
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
      const checkpoint =
        !sealed && expected.checkpoint
          ? await reopenUpdateCheckpoint(expected.checkpoint.ref, {
              artifactRoot: source.artifactRoot,
              binding: expected.checkpoint.binding,
            })
          : undefined;
      assertCurrent();
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
            (assertPublication, bindPublishedRecord) => {
              const assertOwned = () => {
                assertCurrent();
                assertPublication();
              };
              const publish = () => operation(assertOwned, bindPublishedRecord);
              if (sealed) {
                return publish();
              }
              if (!checkpoint) {
                throw new Error("Unsealed replay has no original checkpoint");
              }
              return withUpdateCommandAgentPublication(
                {
                  original: checkpoint,
                  current: source.current,
                  assertCurrent: assertOwned,
                },
                publish,
              );
            },
          ),
        access: createUpdateCommandCheckpointReplayAccess({
          databasePath: initial.databasePath,
          artifactRoot: source.artifactRoot,
          transaction: opened.transaction,
          assertCurrent,
          timeoutMs,
        }),
      };
      const result = await replayUpdateCommandRecovery(
        { ...opts, recovery: owned },
        { resumePreparing: true },
      );
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
