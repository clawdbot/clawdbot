import type { SubagentSpawnPreparation } from "../context-engine/types.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  GatewayDrainingError,
  runWithGatewayIndependentRootWorkContinuation,
} from "../process/gateway-work-admission.js";
import { summarizeSpawnError } from "./spawn-error.js";
import {
  completeCollectorLaunchCleanup,
  settleFailedQueuedSubagentLaunch,
  startQueuedSubagentRun,
} from "./subagent-registry.js";
import type { ProvisionalSessionCleanupIdentity } from "./subagent-spawn-cleanup-types.js";
import {
  cleanupFailedSpawnBeforeAgentStart,
  terminateAcceptedCollectorRun,
} from "./subagent-spawn-cleanup.js";
import {
  retainContextEnginePreparationRollback,
  rollbackPreparedContextEngine,
} from "./subagent-spawn-context.js";
import { readGatewayRunId } from "./subagent-spawn-gateway.js";
import { emitSessionLifecycleEvent } from "./subagent-spawn.runtime.js";
import { activateSwarmRun, type SwarmStartFailureDisposition } from "./swarm-scheduler.js";

const log = createSubsystemLogger("agents/subagent-collector-launch-failure");
const COLLECTOR_LAUNCH_SETTLEMENT_MAX_ATTEMPTS = isFastTestRuntimeEnv() ? 3 : 30;

export function activateCollectorLaunch(params: {
  groupId: string;
  childRunId: string;
  launchChildRun: () => Promise<unknown>;
  emitSpawnLifecycleHooks: (runId: string) => Promise<void>;
  contextEnginePreparation?: SubagentSpawnPreparation;
  childSessionKey: string;
  attachmentAbsDir?: string;
  sessionIdentity?: ProvisionalSessionCleanupIdentity;
  threadBindingReady: boolean;
  requesterInternalKey: string;
}): void {
  let launchTerminationConfirmed = false;
  activateSwarmRun({
    groupId: params.groupId,
    runId: params.childRunId,
    start: async () => {
      await runWithGatewayIndependentRootWorkContinuation(async () => {
        const response = await params.launchChildRun();
        const gatewayRunId = readGatewayRunId(response) ?? params.childRunId;
        try {
          if (!startQueuedSubagentRun(params.childRunId, gatewayRunId)) {
            throw new Error("collector registry row could not transition from queued to running");
          }
        } catch (error) {
          await terminateAcceptedCollectorRun({
            childSessionKey: params.childSessionKey,
            gatewayRunId,
            expectedSessionId: params.sessionIdentity?.expectedSessionId,
            expectedLifecycleRevision: params.sessionIdentity?.expectedLifecycleRevision,
          });
          launchTerminationConfirmed = true;
          throw error;
        }
        await params.emitSpawnLifecycleHooks(gatewayRunId);
      });
    },
    onStartFailure: async (error) =>
      await handleCollectorLaunchStartFailure({
        error,
        contextEnginePreparation: params.contextEnginePreparation,
        childSessionKey: params.childSessionKey,
        childRunId: params.childRunId,
        attachmentAbsDir: params.attachmentAbsDir,
        sessionIdentity: params.sessionIdentity,
        threadBindingReady: params.threadBindingReady,
        launchTerminationConfirmed,
        requesterInternalKey: params.requesterInternalKey,
      }),
  });
}

async function handleCollectorLaunchStartFailure(params: {
  error: unknown;
  contextEnginePreparation?: SubagentSpawnPreparation;
  childSessionKey: string;
  childRunId: string;
  attachmentAbsDir?: string;
  sessionIdentity?: ProvisionalSessionCleanupIdentity;
  threadBindingReady: boolean;
  launchTerminationConfirmed: boolean;
  requesterInternalKey: string;
}): Promise<SwarmStartFailureDisposition> {
  if (params.error instanceof GatewayDrainingError) {
    return "retry";
  }
  const launchError = summarizeSpawnError(params.error);
  const [contextRollback, sessionCleanup] = await Promise.allSettled([
    rollbackPreparedContextEngine(params.contextEnginePreparation),
    cleanupFailedSpawnBeforeAgentStart({
      childSessionKey: params.childSessionKey,
      ...(params.attachmentAbsDir ? { attachmentAbsDir: params.attachmentAbsDir } : {}),
      ...(params.sessionIdentity ? { expectedIdentity: params.sessionIdentity } : {}),
      emitLifecycleHooks: params.threadBindingReady,
      deleteTranscript: true,
      waitForSessionDeletion: !params.launchTerminationConfirmed,
    }),
  ]);
  const contextEnginePreparationRollbackPending =
    contextRollback.status !== "fulfilled" || !contextRollback.value;
  const retainedContextEnginePreparationRollback =
    contextEnginePreparationRollbackPending &&
    retainContextEnginePreparationRollback({
      runId: params.childRunId,
      preparation: params.contextEnginePreparation,
    });
  let settledLaunch = false;
  let lastSettlementError: unknown;
  for (let attempt = 1; attempt <= COLLECTOR_LAUNCH_SETTLEMENT_MAX_ATTEMPTS; attempt += 1) {
    try {
      settledLaunch = retainedContextEnginePreparationRollback
        ? settleFailedQueuedSubagentLaunch(params.childRunId, launchError, {
            contextEnginePreparationRollbackPending: true,
          })
        : settleFailedQueuedSubagentLaunch(params.childRunId, launchError);
      if (!settledLaunch) {
        lastSettlementError = new Error("collector launch failure had no durable queued owner");
      }
      if (settledLaunch) {
        break;
      }
    } catch (error) {
      lastSettlementError = error;
    }
    if (attempt >= COLLECTOR_LAUNCH_SETTLEMENT_MAX_ATTEMPTS) {
      break;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, isFastTestRuntimeEnv() ? 1 : 1_000);
      timer.unref?.();
    });
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
  if (settledLaunch && cleanupComplete) {
    emitSessionLifecycleEvent({
      sessionKey: params.childSessionKey,
      reason: "delete",
      parentSessionKey: params.requesterInternalKey,
    });
    completeCollectorLaunchCleanup(params.childRunId);
    return "release";
  }
  if (settledLaunch && params.launchTerminationConfirmed) {
    return "release";
  }
  return "hold";
}
