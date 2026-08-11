import type { SubagentSpawnPreparation } from "../../../context-engine/types.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../../process/gateway-work-admission.js";
import {
  completeFailedLaunchContextEngineCleanup,
  scheduleSubagentRegistrySweep,
} from "../registry/subagent-registry.js";
import { terminateAcceptedSubagentRun } from "./subagent-spawn-cleanup.js";
import { rollbackPreparedContextEngine } from "./subagent-spawn-context.js";

export async function terminateOrRetryFailedAcceptedSubagentLaunch(params: {
  childSessionKey: string;
  gatewayRunId: string;
  expectedSessionId?: string;
  expectedLifecycleRevision?: string;
  cleanupOwnerRunId: string;
  contextEnginePreparation?: SubagentSpawnPreparation;
}): Promise<boolean> {
  const { cleanupOwnerRunId, contextEnginePreparation, ...termination } = params;
  if (await terminateAcceptedSubagentRun({ ...termination, shouldRetry: () => false })) {
    return true;
  }
  // The durable owner lets the tool return while exact termination retries.
  // Only then may rollback release context state used by the accepted child.
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    await terminateAcceptedSubagentRun(termination);
    if (await rollbackPreparedContextEngine(contextEnginePreparation)) {
      completeFailedLaunchContextEngineCleanup(cleanupOwnerRunId);
    }
    scheduleSubagentRegistrySweep({ delayMs: 0 });
  });
  return false;
}
