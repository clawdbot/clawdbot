import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  claimAgentRunContext,
  getAgentRunContext,
  retainQueuedAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../../../process/command-queue.js";
import type { CommandQueueEnqueueOptions } from "../../../process/command-queue.types.js";
import { withSessionPlacementTurnAdmission } from "../../session-placement-admission.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import {
  EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
  resolveEmbeddedRunLaneTimeoutMs,
  resolveEmbeddedRunSessionQueuePriority,
  shouldNoteLaneWait,
  withEmbeddedRunLaneTimeout,
} from "./lane-runtime.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { claimAgentSessionWriter } from "./session-bootstrap.js";

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
  let releaseQueuedRunContext: ReturnType<typeof retainQueuedAgentRunContext>;
  let queuedRunAbortSignal: AbortSignal | undefined;

  const releaseQueuedContext = (outcome: "admitted" | "abandoned") => {
    queuedRunAbortSignal?.removeEventListener("abort", abandonQueuedContext);
    queuedRunAbortSignal = undefined;
    releaseQueuedRunContext?.(outcome);
  };
  const abandonQueuedContext = () => {
    releaseQueuedContext("abandoned");
  };

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
      const writerClaim = await claimAgentSessionWriter(params);
      if (writerClaim) {
        params = {
          ...params,
          sessionTarget: {
            ...params.sessionTarget,
            expectedLifecycleRevision: writerClaim.expectedLifecycleRevision,
            expectedWriterRunId: writerClaim.expectedWriterRunId,
          },
        };
        options.setParams(params);
      }
      return await withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
        withSessionPlacementTurnAdmission(
          {
            sessionId: params.sessionId,
            ...(params.agentId ? { agentId: params.agentId } : {}),
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
            runId: params.runId,
          },
          params,
          task,
          () => {
            throwIfAborted();
            assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
            releaseQueuedContext("admitted");
            // Queue-stage rotation may rebind, but placement admitted into a retired runtime must fail.
            claimAgentRunContext(params.runId, {
              ...existingContext,
              agentId: params.agentId ?? existingContext?.agentId,
              sessionKey: params.sessionKey ?? existingContext?.sessionKey,
              sessionId: params.sessionId ?? existingContext?.sessionId,
              lifecycleGeneration,
              lastActiveAt: Date.now(),
            });
            // Queue dequeue can still block on writer or placement admission.
            params.onLaneWait?.({ waitMs: 0, queuedAhead: 0, waiting: false });
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
    const params = options.getParams();
    // Session admission, deferred maintenance, and global admission share one queue owner.
    releaseQueuedRunContext = retainQueuedAgentRunContext(
      params.runId,
      options.getLifecycleGeneration(),
    );
    if (releaseQueuedRunContext && params.abortSignal) {
      if (params.abortSignal.aborted) {
        releaseQueuedContext("abandoned");
      } else {
        queuedRunAbortSignal = params.abortSignal;
        queuedRunAbortSignal.addEventListener("abort", abandonQueuedContext, { once: true });
      }
    }
    let queuedRun: Promise<T>;
    try {
      if (params.enqueue) {
        queuedRun = params.enqueue(task, withRunLaneWait(sessionOpts));
      } else {
        noteLaneWaitIfBusy(options.sessionLane);
        queuedRun = enqueueCommandInLane(options.sessionLane, task, withRunLaneWait(sessionOpts));
      }
    } catch (error) {
      releaseQueuedContext("abandoned");
      throw error;
    }
    return queuedRun.finally(() => {
      releaseQueuedContext("abandoned");
    });
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
