import type { SubagentSpawnPreparation } from "../../../context-engine/types.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../../process/gateway-work-admission.js";
import {
  registerFailedLaunchRollback,
  runFailedLaunchRollback,
} from "../registry/subagent-failed-launch-rollback.js";
import {
  completeFailedLaunchContextEngineCleanup,
  markAcceptedRunTerminationPending,
  scheduleSubagentRegistrySweep,
  settleFailedQueuedSubagentLaunch,
} from "../registry/subagent-registry.js";
import { terminateAcceptedSubagentRun } from "./subagent-spawn-cleanup.js";
import { rollbackPreparedContextEngine } from "./subagent-spawn-context.js";

export async function terminateOrRetryFailedAcceptedSubagentLaunch(params: {
  childSessionKey: string;
  cleanupOwnerRunId: string;
  terminationOwner: NonNullable<
    import("../registry/subagent-registry.types.js").SubagentRunRecord["acceptedRunTermination"]
  >;
  contextEnginePreparation?: SubagentSpawnPreparation;
  failureError: string;
  onSessionCleanup?: (outcome: "deleted" | "changed") => void;
}): Promise<boolean> {
  const {
    childSessionKey,
    cleanupOwnerRunId,
    contextEnginePreparation,
    failureError,
    terminationOwner,
  } = params;
  const owner = terminationOwner;
  const termination = {
    childSessionKey,
    gatewayRunId: owner.gatewayRunId,
    expectedSessionId: owner.expectedSessionId,
    expectedLifecycleRevision: owner.expectedLifecycleRevision,
  };
  const allowSessionDelete = Boolean(owner.expectedSessionId && owner.expectedLifecycleRevision);
  let sessionCleanupOutcome: "deleted" | "changed" | undefined;
  if (!markAcceptedRunTerminationPending(cleanupOwnerRunId, owner)) {
    scheduleSubagentRegistrySweep({ delayMs: 0 });
    return false;
  }
  registerFailedLaunchRollback(
    cleanupOwnerRunId,
    contextEnginePreparation
      ? async () => await rollbackPreparedContextEngine(contextEnginePreparation)
      : undefined,
  );
  if (
    await terminateAcceptedSubagentRun({
      ...termination,
      allowSessionDelete,
      shouldRetry: () => false,
      onSessionCleanup: (outcome) => {
        sessionCleanupOutcome = outcome;
        params.onSessionCleanup?.(outcome);
      },
    })
  ) {
    try {
      if (
        settleFailedQueuedSubagentLaunch(cleanupOwnerRunId, failureError, {
          expectedTermination: owner,
          sessionCleanupOutcome,
        })
      ) {
        return true;
      }
    } catch {
      // The durable termination owner remains authoritative for the sweeper.
    }
    scheduleSubagentRegistrySweep({ delayMs: 0 });
    return false;
  }
  // The durable owner lets the tool return while exact termination retries.
  // One detached attempt accelerates cleanup without holding root admission
  // forever; the durable sweeper remains the retry owner after that attempt.
  void runWithGatewayIndependentRootWorkContinuation(async () => {
    try {
      const terminated = await terminateAcceptedSubagentRun({
        ...termination,
        allowSessionDelete,
        shouldRetry: () => false,
        onSessionCleanup: (outcome) => {
          sessionCleanupOutcome = outcome;
          params.onSessionCleanup?.(outcome);
        },
      });
      if (terminated) {
        try {
          const settled = settleFailedQueuedSubagentLaunch(cleanupOwnerRunId, failureError, {
            expectedTermination: owner,
            sessionCleanupOutcome,
          });
          if (settled && (await runFailedLaunchRollback(cleanupOwnerRunId))) {
            completeFailedLaunchContextEngineCleanup(cleanupOwnerRunId);
          }
        } catch {
          // The persisted termination owner remains authoritative for the sweeper.
        }
      }
    } finally {
      scheduleSubagentRegistrySweep({ delayMs: 0 });
    }
  }).catch(() => {
    // The persisted obligation is authoritative; the sweeper retries it.
  });
  return false;
}
