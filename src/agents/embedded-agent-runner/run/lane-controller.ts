import {
  assertAgentRunLifecycleGenerationCurrent,
  claimAgentRunContext,
  getAgentEventLifecycleGeneration,
  getAgentRunContext,
  withAgentRunLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../../../process/command-queue.js";
import type { CommandLaneSnapshot } from "../../../process/command-queue.js";
import type { CommandQueueEnqueueOptions } from "../../../process/command-queue.types.js";
import { withSessionPlacementTurnAdmission } from "../../session-placement-admission.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import {
  EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
  resolveEmbeddedRunLaneTimeoutMs,
  resolveEmbeddedRunSessionQueuePriority,
  withEmbeddedRunLaneTimeout,
} from "./lane-runtime.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { assertAgentHarnessRunAdmission } from "./session-bootstrap.js";

/**
 * Whether a run about to enter `lane` is going to wait rather than start now.
 *
 * Called BEFORE enqueue, so it must answer from the lane's current admission
 * state — `queuedCount` is 0 at this point in the common case.
 *
 * `blockedBy` is the only term that can see a GROUP-imposed wait: a member
 * blocked by group budget or a sibling's hard reservation has
 * `activeCount < maxConcurrent` and typically `queuedCount === 0`, so both
 * lane-local terms are false while the task genuinely cannot start.
 *
 * Missing that wait is not merely an observability gap. `cron/service/
 * agent-watchdog.ts` suppresses the cron setup timeout only while
 * `waitingForLane` is true, and that flag is set from this signal via
 * `timer-job-runner.ts` -> `noteLaneWait()`. A group wait that goes unreported
 * therefore produces a FALSE setup timeout for a run that is healthy and simply
 * queued behind capacity.
 *
 * Exported for test: the chain from group-blocked lane to timeout suppression
 * spans three files, and this is the link the capacity-group change introduced.
 */
export function shouldNoteLaneWait(snapshot: CommandLaneSnapshot): boolean {
  return (
    snapshot.queuedCount > 0 ||
    snapshot.activeCount >= snapshot.maxConcurrent ||
    snapshot.blockedBy != null
  );
}

type LaneParams = RunEmbeddedAgentParams & {
  sessionFile: string;
};

export function createEmbeddedRunLaneController<TParams extends LaneParams>(options: {
  getLifecycleGeneration: () => string;
  getParams: () => TParams;
  globalLane: string;
  initialQueuedLifecycleGeneration: string;
  sessionLane: string;
  setLifecycleGeneration: (generation: string) => void;
  setParams: (params: TParams) => void;
}) {
  const initialParams = options.getParams();
  const sessionQueuePriority = resolveEmbeddedRunSessionQueuePriority(
    initialParams.trigger,
    initialParams.inputProvenance,
  );
  const laneTaskTimeoutMs = resolveEmbeddedRunLaneTimeoutMs(initialParams.timeoutMs);
  const laneTaskAbortController = new AbortController();
  const laneTaskReleaseController = new AbortController();
  let laneTaskProgressAtMs = Date.now();

  const noteLaneTaskProgress = () => {
    laneTaskProgressAtMs = Date.now();
  };
  const throwIfAborted = () => {
    const params = options.getParams();
    if (!params.abortSignal?.aborted) {
      return;
    }
    const reason = params.abortSignal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    const abortError =
      reason !== undefined
        ? new Error("Operation aborted", { cause: reason })
        : new Error("Operation aborted");
    abortError.name = "AbortError";
    throw abortError;
  };
  const withLaneTimeout = (opts?: CommandQueueEnqueueOptions) =>
    withEmbeddedRunLaneTimeout(
      {
        ...opts,
        taskTimeoutProgressAtMs: () => laneTaskProgressAtMs,
        taskTimeoutAbortSignal: laneTaskAbortController.signal,
        taskTimeoutAbortGraceMs: EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
        taskTimeoutReleaseSignal: laneTaskReleaseController.signal,
      },
      laneTaskTimeoutMs,
    );
  const withRunLaneWait = (opts?: CommandQueueEnqueueOptions) => {
    const params = options.getParams();
    if (!opts?.onWait && !params.onLaneWait) {
      return opts;
    }
    return {
      ...opts,
      onWait: (waitMs, queuedAhead) => {
        opts?.onWait?.(waitMs, queuedAhead);
        options.getParams().onLaneWait?.({ waitMs, queuedAhead, waiting: true });
      },
    } satisfies CommandQueueEnqueueOptions;
  };
  const noteLaneWaitIfBusy = (lane: string) => {
    const params = options.getParams();
    if (!params.onLaneWait) {
      return;
    }
    const snapshot = getCommandLaneSnapshot(lane);
    if (shouldNoteLaneWait(snapshot)) {
      params.onLaneWait({
        waitMs: 0,
        queuedAhead: snapshot.queuedCount + snapshot.activeCount,
        waiting: true,
      });
    }
  };
  const enqueueGlobal = (
    task: () => Promise<EmbeddedAgentRunResult>,
    opts?: CommandQueueEnqueueOptions,
  ) => {
    // Global-lane admission is healthy waiting, not run execution. Keep reply
    // staleness and stuck recovery fenced until this queue grants capacity.
    options.getParams().replyOperation?.markWaitingForGlobalLane();
    const globalOpts: CommandQueueEnqueueOptions = {
      ...opts,
      priority: sessionQueuePriority,
    };
    const taskWithCurrentLifecycle = async () => {
      let params = options.getParams();
      params.onLaneWait?.({ waitMs: 0, queuedAhead: 0, waiting: false });
      params.replyOperation?.markGlobalLaneWaitEnded();
      throwIfAborted();
      let lifecycleGeneration = options.getLifecycleGeneration();
      const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
      const existingContext = getAgentRunContext(params.runId);
      if (lifecycleGeneration !== currentLifecycleGeneration) {
        const wasQueuedBeforeRotation =
          options.initialQueuedLifecycleGeneration === lifecycleGeneration;
        const canResumeAcrossRotation = sessionQueuePriority === "foreground";
        const newerSameIdExecutionOwnsContext =
          existingContext?.lifecycleGeneration === currentLifecycleGeneration;
        if (
          !wasQueuedBeforeRotation ||
          !canResumeAcrossRotation ||
          newerSameIdExecutionOwnsContext
        ) {
          assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        }
        lifecycleGeneration = currentLifecycleGeneration;
        options.setLifecycleGeneration(lifecycleGeneration);
        params = { ...params, lifecycleGeneration };
        options.setParams(params);
      }
      // Queue waits can outlive durable harness and placement bindings.
      // Recheck and claim only after lifecycle admission, before context or hooks execute.
      assertAgentHarnessRunAdmission(params);
      return await withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
        withSessionPlacementTurnAdmission(
          {
            sessionId: params.sessionId,
            ...(params.agentId ? { agentId: params.agentId } : {}),
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
            runId: params.runId,
          },
          params,
          () => {
            claimAgentRunContext(params.runId, {
              ...existingContext,
              sessionKey: params.sessionKey ?? existingContext?.sessionKey,
              sessionId: params.sessionId ?? existingContext?.sessionId,
              lifecycleGeneration,
            });
            return task();
          },
        ),
      );
    };
    const params = options.getParams();
    if (params.enqueue) {
      return params.enqueue(taskWithCurrentLifecycle, withLaneTimeout(withRunLaneWait(globalOpts)));
    }
    noteLaneWaitIfBusy(options.globalLane);
    return enqueueCommandInLane(
      options.globalLane,
      taskWithCurrentLifecycle,
      withLaneTimeout(withRunLaneWait(globalOpts)),
    );
  };
  const enqueueSession = <T>(task: () => Promise<T>, opts?: CommandQueueEnqueueOptions) => {
    const sessionOpts: CommandQueueEnqueueOptions = { ...opts, priority: sessionQueuePriority };
    const taskWithLaneAdmission = () => {
      options.getParams().onLaneWait?.({ waitMs: 0, queuedAhead: 0, waiting: false });
      return task();
    };
    const params = options.getParams();
    if (params.enqueue) {
      return params.enqueue(taskWithLaneAdmission, withRunLaneWait(sessionOpts));
    }
    noteLaneWaitIfBusy(options.sessionLane);
    return enqueueCommandInLane(
      options.sessionLane,
      taskWithLaneAdmission,
      withRunLaneWait(sessionOpts),
    );
  };

  return {
    enqueueGlobal,
    enqueueSession,
    laneTaskAbortController,
    laneTaskReleaseController,
    noteLaneTaskProgress,
    throwIfAborted,
  };
}
