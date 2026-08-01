import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
/**
 * Subagent registry lifecycle transitions.
 *
 * Completes/fails task runs, clears delivery state, emits lifecycle events, and cleans attached resources.
 */
import type { AcceptedSessionSpawn } from "./accepted-session-spawn.js";
import { createSubagentRegistryLifecycleCleanupBase } from "./subagent-registry-lifecycle-cleanup-base.js";
import { createSubagentRegistryLifecycleCleanup } from "./subagent-registry-lifecycle-cleanup.js";
import { createSubagentRegistryLifecycleCommon } from "./subagent-registry-lifecycle-common.js";
import { createSubagentRegistryLifecycleCompletion } from "./subagent-registry-lifecycle-completion.js";
import {
  createSubagentRegistryLifecycleState,
  type SubagentRegistryLifecycleParams,
} from "./subagent-registry-lifecycle-contracts.js";
import { createSubagentRegistryLifecycleDelivery } from "./subagent-registry-lifecycle-delivery.js";
import { createSubagentRegistryLifecycleRequesterWake } from "./subagent-registry-lifecycle-requester-wake.js";
import { settleRequesterTurnAfterSessionSpawns } from "./subagent-registry-requester-yield.js";
import type { SubagentCompletionRequest } from "./subagent-registry.types.js";

export function createSubagentRegistryLifecycleController(params: SubagentRegistryLifecycleParams) {
  const state = createSubagentRegistryLifecycleState();
  const common = createSubagentRegistryLifecycleCommon(params, state);
  const delivery = createSubagentRegistryLifecycleDelivery(params, state, common);
  const requesterWake = createSubagentRegistryLifecycleRequesterWake(params, state, common);
  const cleanupBase = createSubagentRegistryLifecycleCleanupBase(
    params,
    state,
    common,
    delivery,
    requesterWake,
  );
  const cleanup = createSubagentRegistryLifecycleCleanup(
    params,
    state,
    common,
    delivery,
    requesterWake,
    cleanupBase,
  );
  const completion = createSubagentRegistryLifecycleCompletion(
    params,
    state,
    common,
    delivery,
    cleanupBase,
    cleanup,
  );
  const completeSubagentRun = async (completeParams: SubagentCompletionRequest) => {
    // Task finalization can make the run disappear from suspension blockers
    // before browser/MCP retirement and cleanup delivery hand off. Own this
    // entire transition as an independent root so that boundary stays atomic.
    // Callers can detach while retaining parent ALS, so nesting is intentional.
    await runWithGatewayIndependentRootWorkAdmission(async () => {
      await completion.completeSubagentRunAttempt(completeParams);
    });
  };

  return {
    clearScheduledResumeTimers: common.clearScheduledResumeTimers,
    completeCleanupBookkeeping: cleanup.completeCleanupBookkeeping,
    completeSubagentRun,
    finalizeResumedAnnounceGiveUp: cleanup.finalizeResumedAnnounceGiveUp,
    refreshFrozenResultFromSession: delivery.refreshFrozenResultFromSession,
    settleRequesterTurnAfterSessionSpawns: (args: {
      requesterSessionKey: string;
      requesterTurnRunId: string;
      requesterYielded: boolean;
      acceptedSessionSpawns: readonly AcceptedSessionSpawn[];
    }) =>
      settleRequesterTurnAfterSessionSpawns({
        ...args,
        runs: params.runs,
        persistOrThrow: (...runIds) => params.persistOrThrow(...runIds),
        schedule: (runId, entry) => {
          if (state.scheduledRequesterSettleWakeRuns.has(runId)) {
            state.pendingRequesterSettleWakeRearms.add(runId);
            return;
          }
          requesterWake.scheduleRequesterSettleWake(runId, entry);
        },
      }),
    resumeRequesterSettleWake: requesterWake.scheduleRequesterSettleWake,
    startSubagentAnnounceCleanupFlow: cleanup.startSubagentAnnounceCleanupFlow,
  };
}
