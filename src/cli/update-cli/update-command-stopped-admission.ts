import { platform } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { resolveConfigPath, resolveStateDir } from "../../config/paths.js";
import { resolveSystemdServiceName } from "../../daemon/systemd-service-files.js";
import { reopenPackageUpdateTransaction } from "../../infra/package-update-recovery.js";
import { reopenUpdateCheckpoint } from "../../infra/update-checkpoint.js";
import {
  assertExactUpdateRecoveryClaim,
  claimUpdateRecovery,
  type UpdateRecoveryRecord,
} from "../../infra/update-run-recovery.js";
import { readUpdateCommandNativeObservation } from "./update-command-native-observation.js";
import {
  UpdateCommandRecoveryPendingError,
  type UpdateCommandRecovery,
} from "./update-command-recovery.js";
import { isGatewayServiceManagementAllowedForUpdate } from "./update-command-service-plan.js";
import { withUpdateCommandSourceOwnership } from "./update-command-source-ownership.js";

/** Select evidence only. A journaled stop is not proof that the service stopped.
 * The caller must acquire the original installation executor, then validate the
 * sources, package and effective native owner before reclaiming this record.
 * A sealed restore is selected here but reclaimed only by its publication owner. */
export function isPendingStoppedServiceReplay(
  record: UpdateRecoveryRecord,
  env: NodeJS.ProcessEnv,
): boolean {
  const { source, nativeManager, package: pkg } = record;
  const stop = nativeManager?.effects.at(-1);
  const suppress = nativeManager?.effects.at(-2);
  const restart = record.effects.at(-1);
  const sealed = Boolean(
    record.restore?.planSha256 &&
    record.restore.phase !== "preparing" &&
    record.restore.checkpointId === record.checkpoint?.ref.checkpointId &&
    restart?.kind === "checkpoint-restore" &&
    restart.state === "intent" &&
    restart.runtime === "previous" &&
    restart.resourceId === record.checkpoint?.ref.checkpointId &&
    record.effects.every((effect) => effect === restart || effect.state !== "intent") &&
    record.effects.some(
      (effect) => effect.kind === "package-restore" && effect.state === "observed",
    ) &&
    nativeManager?.effects.every((effect) => effect.state !== "intent") &&
    stop?.action === "stop" &&
    stop.state === "observed",
  );
  return Boolean(
    platform() === "linux" &&
    isGatewayServiceManagementAllowedForUpdate(env) &&
    source &&
    source.stateDir === resolveStateDir(env) &&
    source.configPath === resolveConfigPath(env) &&
    source.profile === (env.OPENCLAW_PROFILE?.trim() || null) &&
    nativeManager?.identity.platform === "linux" &&
    nativeManager.identity.scope === "user" &&
    nativeManager.identity.runId === record.runId &&
    nativeManager.identity.stateDir === source.stateDir &&
    nativeManager.identity.configPath === source.configPath &&
    nativeManager.identity.profile === source.profile &&
    nativeManager.identity.unitName === `${resolveSystemdServiceName(env)}.service` &&
    record.primaryFailure &&
    record.checkpoint &&
    record.preimages &&
    record.afterImages?.length &&
    !record.terminal &&
    !record.preparationAborted &&
    record.handoff?.state !== "prepared" &&
    pkg?.descriptor.previous &&
    pkg.descriptor.liveRoot === record.from.root &&
    pkg.descriptor.previous.version === record.from.version &&
    pkg.descriptor.transactionId === record.transactionId &&
    (sealed ||
      (!record.restore &&
        restart?.kind === "service-restart" &&
        restart.runtime === "candidate" &&
        restart.state === "intent" &&
        suppress?.action === "suppress" &&
        suppress.state === "observed" &&
        !suppress.after.enabled &&
        stop?.action === "stop" &&
        stop.state === "intent")) &&
    stop?.after.exists &&
    stop.after.loaded &&
    !stop.after.enabled &&
    stop.after.stopped,
  );
}

/** No package hook is allowed to mutate while selecting the retained root. */
export async function verifyStoppedServiceReplayPackage(
  record: UpdateRecoveryRecord,
  timeoutMs?: number,
): Promise<void> {
  const descriptor = record.package!.descriptor;
  const refuse = () =>
    new UpdateCommandRecoveryPendingError(
      "Retained stopped service package does not match its original transaction.",
    );
  const opened = await reopenPackageUpdateTransaction({
    descriptor,
    expectedLiveRoot: record.from.root,
    expectedBinDir: descriptor.binDir,
    expectedTransactionId: record.transactionId,
    hooks: {
      transactionId: record.transactionId,
      beforeEffect: async () => {
        throw refuse();
      },
      persistDescriptor: async () => {
        throw refuse();
      },
    },
    timeoutMs,
  });
  if (
    opened.status !== "ready" ||
    opened.observed.observation.previous !== (record.restore ? "live" : "retained") ||
    opened.observed.observation.candidate !== (record.restore ? "displaced" : "live") ||
    ![record.restore ? "previous" : "candidate", "both"].includes(
      opened.observed.observation.launchers,
    )
  ) {
    throw refuse();
  }
}

/** Use the existing guarded definition inspection only while the NEW executor
 * and original source locks are live. Do not claim a row, dispatch a native
 * action or start restoration until stopped facts are independently verified. */
export async function claimStoppedServiceReplayAdmission(params: {
  recovery: UpdateCommandRecovery;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<void> {
  const { recovery, env, timeoutMs } = params;
  const expected = recovery.getRecord();
  if (expected.restore || !isPendingStoppedServiceReplay(expected, env)) {
    throw new UpdateCommandRecoveryPendingError("Retained stopped service admission changed.");
  }
  await withUpdateCommandSourceOwnership({ recovery, env, mutation: true }, async (source) => {
    const assertCurrent = () =>
      assertExactUpdateRecoveryClaim(
        expected,
        { assertCurrent: source.assertCurrent },
        recovery.options,
      );
    await reopenUpdateCheckpoint(expected.checkpoint!.ref, {
      artifactRoot: source.artifactRoot,
      binding: expected.checkpoint!.binding,
    });
    await verifyStoppedServiceReplayPackage(expected, timeoutMs);
    await source.verifySources();
    assertCurrent();
    const actual = await readUpdateCommandNativeObservation({
      record: expected,
      env,
      timeoutMs,
      definitionPaths: source.definitionPaths,
      assertCurrent,
      inspectOwnedUnit: assertCurrent,
    });
    await source.verifySources();
    assertCurrent();
    await verifyStoppedServiceReplayPackage(expected, timeoutMs);
    await source.verifySources();
    assertCurrent();
    // File and package checks above await I/O. Close with a fresh native read
    // while the SAME source locks and exact executor are still held; the row
    // claim below is synchronous and cannot outlive this admission interval.
    const closing = await readUpdateCommandNativeObservation({
      record: expected,
      env,
      timeoutMs,
      definitionPaths: source.definitionPaths,
      assertCurrent,
      inspectOwnedUnit: assertCurrent,
    });
    assertCurrent();
    if (
      !isDeepStrictEqual(actual, closing) ||
      !isDeepStrictEqual(actual.identity, expected.nativeManager!.identity) ||
      !isDeepStrictEqual(actual.facts, expected.nativeManager!.effects.at(-1)!.after)
    ) {
      throw new UpdateCommandRecoveryPendingError(
        "Retained service is not the original stopped native owner.",
      );
    }
    recovery.onRecord(claimUpdateRecovery(expected, { assertCurrent }, recovery.options));
  });
}
