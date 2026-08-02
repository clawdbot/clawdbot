import type { SubagentSpawnPreparation } from "../context-engine/types.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { GatewayDrainingError } from "../process/gateway-work-admission.js";
import { summarizeSpawnError } from "./spawn-pipeline.js";
import {
  completeCollectorLaunchCleanup,
  settleFailedQueuedSubagentLaunch,
} from "./subagent-registry.js";
import { cleanupFailedSpawnBeforeAgentStart } from "./subagent-spawn-cleanup.js";
import { rollbackPreparedContextEngine } from "./subagent-spawn-context.js";
import { emitSessionLifecycleEvent } from "./subagent-spawn.runtime.js";

const log = createSubsystemLogger("agents/subagent-collector-launch-failure");
const COLLECTOR_LAUNCH_SETTLEMENT_MAX_ATTEMPTS = isFastTestRuntimeEnv() ? 3 : 30;

export async function handleCollectorLaunchStartFailure(params: {
  error: unknown;
  contextEnginePreparation?: SubagentSpawnPreparation;
  childSessionKey: string;
  childRunId: string;
  attachmentAbsDir?: string;
  threadBindingReady: boolean;
  launchTerminationConfirmed: boolean;
  requesterInternalKey: string;
}): Promise<boolean> {
  if (params.error instanceof GatewayDrainingError) {
    return false;
  }
  const launchError = summarizeSpawnError(params.error);
  const [contextRollback, sessionCleanup] = await Promise.allSettled([
    rollbackPreparedContextEngine(params.contextEnginePreparation),
    cleanupFailedSpawnBeforeAgentStart({
      childSessionKey: params.childSessionKey,
      ...(params.attachmentAbsDir ? { attachmentAbsDir: params.attachmentAbsDir } : {}),
      emitLifecycleHooks: params.threadBindingReady,
      deleteTranscript: true,
      waitForSessionDeletion: !params.launchTerminationConfirmed,
    }),
  ]);
  let settledLaunch = false;
  let lastSettlementError: unknown;
  for (let attempt = 1; attempt <= COLLECTOR_LAUNCH_SETTLEMENT_MAX_ATTEMPTS; attempt += 1) {
    try {
      settleFailedQueuedSubagentLaunch(params.childRunId, launchError);
      settledLaunch = true;
      break;
    } catch (error) {
      lastSettlementError = error;
      if (attempt >= COLLECTOR_LAUNCH_SETTLEMENT_MAX_ATTEMPTS) {
        break;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, isFastTestRuntimeEnv() ? 1 : 1_000);
        timer.unref?.();
      });
    }
  }
  if (!settledLaunch) {
    log.warn("collector launch failure settlement retry budget exhausted", {
      childRunId: params.childRunId,
      attempts: COLLECTOR_LAUNCH_SETTLEMENT_MAX_ATTEMPTS,
      error: lastSettlementError,
    });
  }
  const cleanupComplete =
    contextRollback.status === "fulfilled" &&
    contextRollback.value &&
    sessionCleanup.status === "fulfilled" &&
    sessionCleanup.value.attachmentsRemoved &&
    sessionCleanup.value.sessionDeleted;
  if (cleanupComplete) {
    emitSessionLifecycleEvent({
      sessionKey: params.childSessionKey,
      reason: "delete",
      parentSessionKey: params.requesterInternalKey,
    });
    completeCollectorLaunchCleanup(params.childRunId);
  }
  return true;
}
