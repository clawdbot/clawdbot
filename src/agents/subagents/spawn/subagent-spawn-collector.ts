import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  GatewayDrainingError,
  runWithGatewayIndependentRootWorkContinuation,
} from "../../../process/gateway-work-admission.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import { summarizeSpawnError } from "../../spawn-pipeline.js";
import {
  completeCollectorLaunchCleanup,
  getSubagentRunByRunId,
  settleFailedQueuedSubagentLaunch,
  startQueuedSubagentRun,
} from "../registry/subagent-registry.js";
import { activateSwarmRun } from "../swarm/swarm-scheduler.js";
import { retrySubagentCleanup, terminateAcceptedCollectorRun } from "./subagent-spawn-cleanup.js";
import { readGatewayRunId } from "./subagent-spawn-gateway.js";
import { emitSessionLifecycleEvent } from "./subagent-spawn.runtime.js";

export function activateCollectorSubagentRun(params: {
  swarmSchedulerGroupKey: string;
  childRunId: string;
  requesterAgentId: string;
  targetAgentId: string;
  childSessionKey: string;
  requesterInternalKey: string;
  cfg: OpenClawConfig;
  provisionalSessionIdentity: {
    expectedSessionId?: string;
    expectedLifecycleRevision?: string;
  };
  launchChildRun: () => Promise<{ response: unknown }>;
  emitSpawnLifecycleHooks: (runId: string) => Promise<void>;
  rollbackPreparedContext: () => Promise<boolean>;
  cleanupFailedSpawn: (
    waitForSessionDeletion?: boolean,
  ) => Promise<{ attachmentsRemoved: boolean; sessionDeleted: boolean }>;
}): void {
  let launchAcceptanceObserved = false;
  let launchTerminationConfirmed = false;
  activateSwarmRun({
    groupId: params.swarmSchedulerGroupKey,
    runId: params.childRunId,
    start: async () => {
      // Acceptance is sticky for this deterministic launch identity. A lost
      // response on a retry cannot prove the previously accepted run stopped.
      launchTerminationConfirmed = false;
      await runWithGatewayIndependentRootWorkContinuation(async () => {
        const launch = await params.launchChildRun();
        launchAcceptanceObserved = true;
        // Queued registration already owns the task row before either dispatch route starts.
        // Out-of-process Gateway tracking finds that exact runId and suppresses its CLI row.
        const gatewayRunId = readGatewayRunId(launch.response) ?? params.childRunId;
        recordSessionParticipantBestEffort({
          actor: { type: "agent", id: params.requesterAgentId },
          agentId: params.targetAgentId,
          sessionKey: params.childSessionKey,
          source: "agent",
          storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
            agentId: params.targetAgentId,
          }),
        });
        try {
          if (!startQueuedSubagentRun(params.childRunId, gatewayRunId)) {
            throw new Error("collector registry row could not transition from queued to running");
          }
        } catch (error) {
          launchTerminationConfirmed = await terminateAcceptedCollectorRun({
            childSessionKey: params.childSessionKey,
            gatewayRunId,
            ...params.provisionalSessionIdentity,
          });
          throw error;
        }
        await params.emitSpawnLifecycleHooks(gatewayRunId);
      });
    },
    onStartFailure: async (error) => {
      if (error instanceof GatewayDrainingError) {
        return false;
      }
      if (launchAcceptanceObserved && !launchTerminationConfirmed) {
        // A possibly-live accepted run keeps the FIFO slot and replays the same
        // persisted idempotency key, but only while this row still owns the
        // queued work. Once another owner took it, release.
        return getSubagentRunByRunId(params.childRunId)?.execution.status !== "queued";
      }
      const launchError = summarizeSpawnError(error);
      const [contextRollback, sessionCleanup] = await Promise.allSettled([
        params.rollbackPreparedContext(),
        params.cleanupFailedSpawn(
          // A launch RPC can fail after acceptance. Keep the FIFO slot until
          // deleting the child session proves no accepted run remains active.
          !launchTerminationConfirmed,
        ),
      ]);
      await retrySubagentCleanup(async () => {
        settleFailedQueuedSubagentLaunch(params.childRunId, launchError);
        return true;
      });
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
    },
  });
}
