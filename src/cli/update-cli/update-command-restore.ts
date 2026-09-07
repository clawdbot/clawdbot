import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { reopenPackageUpdateTransaction } from "../../infra/package-update-recovery.js";
import { acquireGatewayLifecycleCoordinator } from "../../infra/state-database-coordinator.js";
import { currentUpdateRecoveryNativeFacts } from "../../infra/update-run-recovery-native-schema.js";
import { createUpdateRecoveryPackageHooks } from "../../infra/update-run-recovery-package.js";
import {
  assertExactUpdateRecoveryClaim,
  recordUpdateRecoveryIntent,
} from "../../infra/update-run-recovery.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { withAgentDatabaseMaintenanceLease } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import { readUpdateCommandNativeObservation } from "./update-command-native-observation.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import { resumeUpdateCommandRestorePublication } from "./update-command-replay.js";
import { withUpdateCommandSourceOwnership } from "./update-command-source-ownership.js";

/** Restore actual package and checkpoint resources under the existing publication
 * owner. A previous-runtime reader runs on committed private state before live
 * publication; neither its identity nor the saved cursor authorizes a restart.
 */
export async function restoreUpdateCommandFailure(
  opts: UpdateCommandOptions,
  timeoutMs?: number,
): Promise<void> {
  const recovery = opts.recovery;
  const run = opts.run;
  if (!recovery || !run) {
    throw new UpdateCommandRecoveryPendingError("Restoration requires the live admitted run.");
  }
  const expected = recovery.getRecord();
  if (
    !expected.primaryFailure ||
    !expected.checkpoint ||
    !expected.package ||
    !expected.nativeManager ||
    !expected.afterImages?.length
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Restoration lacks its original checkpoint and package owner.",
    );
  }
  const restored = expected.effects.findLast((effect) => effect.kind === "checkpoint-restore");
  if (
    restored?.state === "observed" &&
    restored.observedIdentity === expected.restore?.planSha256
  ) {
    return;
  }
  if (expected.restore || restored?.state === "intent") {
    closeOpenClawStateDatabase();
    await resumeUpdateCommandRestorePublication(opts, timeoutMs);
    return;
  }
  const pending = expected.effects.at(-1);
  const pendingPackage =
    pending?.state === "intent" &&
    pending.package &&
    ["activate", "restore"].includes(pending.package.intent.action)
      ? pending.package.intent
      : undefined;
  if (
    expected.effects.some(
      (effect) => effect.state === "intent" && effect.effectId !== pendingPackage?.effectId,
    )
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Reconcile interrupted restoration before starting a new publication.",
    );
  }
  const env = run.env;
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const gateway = acquireGatewayLifecycleCoordinator({ databasePath, busyTimeoutMs: 0 });
  try {
    await withPluginLifecycleLease(
      { env, schemaPolicy: "existing", waitMs: timeoutMs ?? 30_000 },
      (plugin) =>
        withAgentDatabaseMaintenanceLease({ env, schemaPolicy: "existing" }, (maintenance) =>
          withUpdateCommandSourceOwnership({ recovery, env, mutation: true }, async (source) => {
            const assertCurrent = () => {
              source.assertCurrent();
              plugin.assertOwned();
              maintenance.assertOwned();
            };
            const fence = { assertCurrent };
            assertExactUpdateRecoveryClaim(expected, fence, recovery.options);
            const native = await readUpdateCommandNativeObservation({
              record: expected,
              env,
              definitionPaths: source.definitionPaths,
              assertCurrent,
              timeoutMs,
            });
            assertCurrent();
            if (
              !native.facts.stopped ||
              !isDeepStrictEqual(native.identity, expected.nativeManager!.identity) ||
              !isDeepStrictEqual(
                native.facts,
                currentUpdateRecoveryNativeFacts(expected.nativeManager!),
              )
            ) {
              throw new UpdateCommandRecoveryPendingError(
                "Restoration requires independently confirmed native shutdown.",
              );
            }
            const owned = { ...recovery, fence };
            const descriptor = expected.package!.descriptor;
            const opened = await reopenPackageUpdateTransaction({
              descriptor,
              expectedLiveRoot: expected.from.root,
              expectedBinDir: descriptor.binDir,
              expectedTransactionId: expected.transactionId,
              hooks: createUpdateRecoveryPackageHooks(owned),
              pendingEffect: pendingPackage,
              timeoutMs,
            });
            assertCurrent();
            if (opened.status !== "ready") {
              throw new UpdateCommandRecoveryPendingError(
                "Previous package custody is unavailable.",
                { cause: new Error(opened.reason) },
              );
            }
            if (pendingPackage?.action === "activate") {
              const reconciled = await opened.transaction.reconcile();
              assertCurrent();
              if (reconciled.status !== "verified") {
                throw new UpdateCommandRecoveryPendingError(
                  "Interrupted package activation remains unverified.",
                  { cause: new Error(reconciled.reason) },
                );
              }
            }
            const packageResult = await opened.transaction.rollback();
            assertCurrent();
            if (
              packageResult.status !== "verified" ||
              packageResult.observation.previous !== "live" ||
              packageResult.observation.candidate === "live" ||
              !["previous", "both"].includes(packageResult.observation.launchers)
            ) {
              throw new UpdateCommandRecoveryPendingError(
                "Previous package restoration remains unverified.",
                {
                  cause:
                    packageResult.status === "verified"
                      ? undefined
                      : new Error(packageResult.reason),
                },
              );
            }
            await source.verifySources();
            recovery.onRecord(
              recordUpdateRecoveryIntent(
                recovery.getRecord(),
                {
                  effectId: randomUUID(),
                  kind: "checkpoint-restore",
                  runtime: "previous",
                  resourceId: expected.checkpoint!.ref.checkpointId,
                },
                fence,
                recovery.options,
              ),
            );
          }),
        ),
    );
    // Package work has drained and released its logical owners. Preparation and
    // publication use the same physically fenced replay path as a fresh process;
    // neither frozen lease rows nor paused heartbeats authorize that interval.
    closeOpenClawStateDatabase();
    await resumeUpdateCommandRestorePublication(opts, timeoutMs);
  } finally {
    gateway.release();
  }
}
