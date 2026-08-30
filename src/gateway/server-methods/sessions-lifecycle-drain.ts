import { resolveEmbeddedSessionLane } from "../../agents/embedded-agent-runner/lanes.js";
// Session-owned cancellation and authoritative lifecycle drains.
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunInProgress,
  waitForEmbeddedAgentRunEnd,
} from "../../agents/embedded-agent-runner/runs.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import {
  abortReplyRunBySessionId,
  isReplyRunActiveForSessionId,
  replyRunRegistry,
  waitForReplyRunEndBySessionId,
} from "../../auto-reply/reply/reply-run-registry.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import {
  interruptSessionWorkAdmissions,
  isCompetingSessionWorkAdmissionActive,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../sessions/session-lifecycle-admission.js";
import { waitForChatAbortControllerRemoval } from "../chat-abort-lifecycle-internal.js";
import type { AgentTerminalSessionDrain } from "../terminal/session-manager.types.js";
import {
  beginWorkerInferenceSessionDrain,
  type WorkerInferenceSessionDrain,
} from "../worker-environments/inference-control-internal.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import type { WorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import {
  prepareSessionWorkerPlacementMutationCheck,
  prepareSessionWorkerPlacementStop,
} from "../worker-environments/session-placement-lifecycle.js";
import {
  abortChatRunsForSessionKeyWithPartials,
  createChatAbortOps,
  hasGatewaySessionAbortOwner,
} from "./chat-abort-runtime.js";
import type { GatewayRequestContext } from "./types.js";

type LifecyclePlacementService = NonNullable<
  GatewayRequestContext["workerSessionPlacementService"]
> &
  Partial<Pick<WorkerSessionPlacementStore, "waitForTurnClaimRelease">>;

type SessionLifecycleParams = {
  action: "archive" | "delete";
  authorize?: () => void;
  context: GatewayRequestContext;
  storePath: string;
  sessionKeys: string[];
  sessionId?: string;
  agentId: string;
  sessionKey: string;
  defaultAgentId?: string;
  lifecycleIdentities: string[];
};

export type SessionLifecycleDrain = {
  release(): void;
  hasAuthoritativeWork(): boolean;
};

function hasAuthoritativeSessionWork(
  params: SessionLifecycleParams,
  workerDrain: WorkerInferenceSessionDrain | undefined,
  terminalDrain: AgentTerminalSessionDrain | undefined,
  workIdentities: string[],
): boolean {
  const sessionId = params.sessionId;
  return (
    isCompetingSessionWorkAdmissionActive(params.storePath, params.lifecycleIdentities) ||
    params.sessionKeys.some((key) => replyRunRegistry.isActive(key)) ||
    Boolean(sessionId && isReplyRunActiveForSessionId(sessionId)) ||
    Boolean(sessionId && isEmbeddedAgentRunInProgress(sessionId)) ||
    hasPendingFollowupQueueWork(workIdentities) ||
    workIdentities.some(
      (key) => getCommandLaneSnapshot(resolveEmbeddedSessionLane(key)).queuedCount > 0,
    ) ||
    hasGatewaySessionAbortOwner({
      context: params.context,
      sessionKeys: params.sessionKeys,
      sessionId,
      agentId: params.agentId,
      defaultAgentId: params.defaultAgentId,
    }) ||
    Boolean(
      sessionId &&
      params.context.workerSessionPlacementService?.getMany([sessionId]).get(sessionId)?.turnClaim,
    ) ||
    workerDrain?.hasWork() === true ||
    terminalDrain?.hasWork() === true
  );
}

/** Fence is already active when this starts; retain the returned runtime fence through commit. */
export async function prepareSessionLifecycleDrain(
  params: SessionLifecycleParams,
): Promise<SessionLifecycleDrain> {
  // Reject unsafe placement before cancellation, then retain this exact owner across drains.
  params.authorize?.();
  const reclaim = prepareSessionWorkerPlacementStop(params);
  const timeoutMs = SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS;
  const workIdentities = Array.from(
    new Set([...params.sessionKeys, ...(params.sessionId ? [params.sessionId] : [])]),
  );
  const workerService = params.context.workerEnvironmentService;
  const workerControl = asWorkerInferenceControl(workerService);
  let workerDrain: WorkerInferenceSessionDrain | undefined;
  let terminalDrain: AgentTerminalSessionDrain | undefined;
  const release = () => {
    try {
      terminalDrain?.release();
    } finally {
      workerDrain?.release();
    }
  };
  try {
    if (params.sessionId) {
      workerDrain = beginWorkerInferenceSessionDrain(workerService, params.sessionId);
      if (!workerDrain && workerControl?.hasInferenceForSession(params.sessionId) === true) {
        throw new Error("Worker inference drain is unavailable");
      }
      terminalDrain = params.context.terminalSessions?.beginAgentSessionDrain({
        kind: "agent",
        agentSessionKey: params.sessionKey,
        agentSessionId: params.sessionId,
        agentId: params.agentId,
      });
    }

    let controllerDrain = Promise.resolve(true);
    const abortResult = await abortChatRunsForSessionKeyWithPartials({
      context: params.context,
      ops: createChatAbortOps(params.context),
      sessionKey: params.sessionKeys[0]!,
      sessionKeyAliases: params.sessionKeys.slice(1),
      sessionId: params.sessionId,
      agentId: params.agentId,
      defaultAgentId: params.defaultAgentId,
      abortOrigin: "rpc",
      stopReason: params.action,
      requester: { isAdmin: true },
      includeProtectedRuns: true,
      onControllerTargets: (targets) => {
        controllerDrain = waitForChatAbortControllerRemoval({
          entries: params.context.chatAbortControllers,
          targets,
          timeoutMs,
        });
      },
      onAuthorizedAfterQueuedAbort: () => {
        const cleared = clearSessionQueues(workIdentities);
        let aborted = cleared.followupCleared > 0 || cleared.laneCleared > 0;
        for (const key of params.sessionKeys) {
          aborted = replyRunRegistry.abort(key) || aborted;
        }
        if (params.sessionId) {
          aborted = abortReplyRunBySessionId(params.sessionId) || aborted;
          aborted = abortEmbeddedAgentRun(params.sessionId) || aborted;
        }
        return aborted;
      },
    });
    if (abortResult.unauthorized) {
      throw new Error("Session cancellation lost ownership");
    }

    params.authorize?.();
    const admittedWork = interruptSessionWorkAdmissions({
      scope: params.storePath,
      identities: params.lifecycleIdentities,
      timeoutMs,
    });
    const replyWork = Promise.all([
      ...params.sessionKeys.map((key) => replyRunRegistry.waitForIdle(key, timeoutMs)),
      ...(params.sessionId ? [waitForReplyRunEndBySessionId(params.sessionId, timeoutMs)] : []),
    ]).then((results) => results.every(Boolean));
    const embeddedWork = params.sessionId
      ? waitForEmbeddedAgentRunEnd(params.sessionId, timeoutMs)
      : Promise.resolve(true);
    const placementService: LifecyclePlacementService | undefined =
      params.context.workerSessionPlacementService;
    const placement = params.sessionId
      ? placementService?.getMany([params.sessionId]).get(params.sessionId)
      : undefined;
    const placementWork = placement?.turnClaim
      ? placementService?.waitForTurnClaimRelease
        ? placementService
            .waitForTurnClaimRelease(params.sessionId!, { timeoutMs })
            .then(() => true)
        : Promise.resolve(false)
      : Promise.resolve(true);
    const workerWork = workerDrain
      ? withTimeout(workerDrain.drained, timeoutMs, "worker inference lifecycle drain").then(
          () => true,
        )
      : Promise.resolve(true);
    const terminalWork = terminalDrain
      ? withTimeout(terminalDrain.drained, timeoutMs, "agent terminal lifecycle drain").then(
          () => true,
        )
      : Promise.resolve(true);
    const drains = await Promise.all([
      controllerDrain,
      admittedWork,
      replyWork,
      embeddedWork,
      placementWork,
      workerWork,
      terminalWork,
    ]);
    if (!drains.every(Boolean)) {
      throw new Error("Session work is still active after the lifecycle drain");
    }
    // Safe reclaim must finish before the archive or delete can commit.
    await reclaim();
    const assertPlacementCurrent = prepareSessionWorkerPlacementMutationCheck({
      context: params.context,
      sessionId: params.sessionId,
    });
    return {
      release,
      hasAuthoritativeWork: () => {
        try {
          assertPlacementCurrent();
        } catch {
          return true;
        }
        return hasAuthoritativeSessionWork(params, workerDrain, terminalDrain, workIdentities);
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
