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
  // One detached attempt accelerates cleanup without holding root admission
  // forever; the durable sweeper remains the retry owner after that attempt.
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    const terminated = await terminateAcceptedSubagentRun({
      ...termination,
      shouldRetry: () => false,
    });
    if (terminated && (await rollbackPreparedContextEngine(contextEnginePreparation))) {
      completeFailedLaunchContextEngineCleanup(cleanupOwnerRunId);
    }
    scheduleSubagentRegistrySweep({ delayMs: 0 });
  });
  return false;
}
