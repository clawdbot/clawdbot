import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { resolveGatewayService } from "../../daemon/service.js";
import {
  recordUpdateRecoveryNativeIntent,
  recordUpdateRecoveryNativeObservation,
} from "../../infra/update-run-recovery-native.js";
import { assertExactUpdateRecoveryClaim } from "../../infra/update-run-recovery.js";
import { resolveGatewayRestartProbeContext } from "../daemon-cli/restart-health-probe.js";
import {
  inspectGatewayRestart,
  waitForGatewayHealthyRestart,
  waitForGatewayHttpReadiness,
} from "../daemon-cli/restart-health.js";
import { readUpdateCommandNativeObservation } from "./update-command-native-observation.js";
import {
  UpdateCommandRecoveryPendingError,
  type UpdateCommandRecovery,
} from "./update-command-recovery.js";
import { resolveUpdatedGatewayRestartPort } from "./update-command-service-plan.js";

/** Called only after package and original source validation, inside the real
 * installation/config/native owner interval. Never repeats the original stop,
 * mutates packages, or manufactures a checkpoint or serving-terminal receipt. */
export async function restoreUpdatePreparationNative(params: {
  recovery: UpdateCommandRecovery;
  env: NodeJS.ProcessEnv;
  definitionPaths: string[];
  assertCurrent: () => void;
  verifyUnchanged: () => Promise<void>;
  timeoutMs?: number;
}): Promise<void> {
  const { recovery, env } = params;
  const fence = {
    assertCurrent: () => {
      params.assertCurrent();
      assertExactUpdateRecoveryClaim(recovery.getRecord(), recovery.fence, recovery.options);
    },
  };
  const observe = () =>
    readUpdateCommandNativeObservation({
      record: recovery.getRecord(),
      env,
      definitionPaths: params.definitionPaths,
      assertCurrent: fence.assertCurrent,
      timeoutMs: params.timeoutMs,
    });
  const original = recovery.getRecord().nativeManager!;
  if (original.effects.length === 0) {
    return;
  }
  const pending = original.effects.at(-1)!;
  if (pending.action === "stop") {
    // A saved intent is not proof of stop. Fresh identity-bound readback must
    // establish its target before a compensating start can be journaled.
    const stopped = await recordUpdateRecoveryNativeObservation(
      recovery.getRecord(),
      pending.effectId,
      observe,
      fence,
      recovery.options,
    );
    recovery.onRecord(stopped.record);
    if (stopped.status !== "after") {
      throw new UpdateCommandRecoveryPendingError("Original stop is not independently observed.");
    }
  }
  const latest = recovery.getRecord().nativeManager!.effects.at(-1)!;
  const intent = await recordUpdateRecoveryNativeIntent(
    recovery.getRecord(),
    {
      effectId: latest.action === "restore" ? latest.effectId : randomUUID(),
      action: "restore",
      target: original.original,
      observe,
    },
    fence,
    recovery.options,
  );
  recovery.onRecord(intent.record);
  let failure: { error: unknown } | undefined;
  if (intent.status === "before") {
    try {
      // Journal readback awaits must not carry stale package or source facts into start.
      await params.verifyUnchanged();
      fence.assertCurrent();
      await resolveGatewayService().start({
        env,
        stdout: new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        }),
        assertCurrent: fence.assertCurrent,
        preserveAutoStart: true,
        preserveDefinition: true,
      });
    } catch (error) {
      failure = { error };
    }
  }
  const restored = await recordUpdateRecoveryNativeObservation(
    recovery.getRecord(),
    intent.record.nativeManager!.effects.at(-1)!.effectId,
    observe,
    fence,
    recovery.options,
  );
  recovery.onRecord(restored.record);
  if (failure || restored.status !== "after") {
    throw new UpdateCommandRecoveryPendingError("Native restoration remains pending readback.", {
      cause: failure?.error,
    });
  }

  // The original service must be healthy even on a retry whose restore was
  // already observed. HTTP alone carries no boot identity: sandwich it between
  // authenticated probes, without writing a serving receipt or update success.
  const from = recovery.getRecord().from;
  const service = resolveGatewayService();
  const command = await service.readCommand(env);
  fence.assertCurrent();
  const port = await resolveUpdatedGatewayRestartPort({ serviceEnv: env, serviceCommand: command });
  fence.assertCurrent();
  const context = await resolveGatewayRestartProbeContext(env);
  fence.assertCurrent();
  const probe = {
    service,
    port,
    env,
    expectedVersion: from.version,
    ...(from.buildId ? { expectedBuildId: from.buildId } : {}),
  };
  const first = await waitForGatewayHealthyRestart({ ...probe, requireRunningService: true });
  fence.assertCurrent();
  const http = await waitForGatewayHttpReadiness({
    config: context.config,
    port,
    attempts: 3,
    deadlineAt: Date.now() + 10_000,
    delayMs: 500,
  });
  fence.assertCurrent();
  const last = await inspectGatewayRestart({ ...probe, probeContext: context });
  fence.assertCurrent();
  if (
    http.readyz !== 200 ||
    !first.gatewayBootId ||
    first.gatewayBootId !== last.gatewayBootId ||
    [first, last].some(
      (health) =>
        !health.healthy ||
        health.runtime.status !== "running" ||
        health.gatewayVersion !== from.version ||
        health.gatewayBuildId !== from.buildId ||
        health.activatedPluginErrors?.length ||
        health.channelProbeErrors?.length,
    ) ||
    !isDeepStrictEqual((await observe()).facts, original.original)
  ) {
    throw new UpdateCommandRecoveryPendingError("Original runtime readiness remains unverified.");
  }
  fence.assertCurrent();
}
