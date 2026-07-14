import {
  assertAgentRunLifecycleGenerationCurrent,
  claimAgentRunContext,
  getAgentEventLifecycleGeneration,
  getAgentRunContext,
  withAgentRunLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../../../process/command-queue.js";
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
  const sessionQueuePriority = resolveEmbeddedRunSessionQueuePriority(initialParams.trigger);
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
    if (snapshot.queuedCount > 0 || snapshot.activeCount >= snapshot.maxConcurrent) {
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
    const globalOpts: CommandQueueEnqueueOptions = {
      ...opts,
      priority: sessionQueuePriority,
    };
    const taskWithCurrentLifecycle = async () => {
      let params = options.getParams();
      params.onLaneWait?.({ waitMs: 0, queuedAhead: 0, waiting: false });
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
