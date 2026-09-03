import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import {
  assertAgentRunLifecycleGenerationCurrent,
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
  withAgentRunLifecycleGeneration,
} from "../../../infra/agent-events.js";
import { registerAgentRunCapacityWait } from "../../../infra/agent-run-capacity-wait.js";
import {
  claimAgentRunContext,
  getAgentRunContext,
  retainQueuedAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  isCommandLaneTaskTimeoutError,
} from "../../../process/command-queue.js";
import type {
  CommandQueueEnqueueOptions,
  CommandQueueTaskDeadline,
} from "../../../process/command-queue.types.js";
import { getAdmittedRunDelegatedAuthority } from "../../admitted-run-context.js";
import { createAgentRunDirectAbortError } from "../../run-termination.js";
import { withSessionPlacementTurnAdmission } from "../../session-placement-admission.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import {
  EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
  resolveEmbeddedRunLaneTimeoutMs,
  resolveEmbeddedRunSessionLanePolicy,
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
  const sessionLanePolicy = resolveEmbeddedRunSessionLanePolicy(
    initialParams.trigger,
    initialParams.inputProvenance,
  );
  const laneTaskTimeoutMs = resolveEmbeddedRunLaneTimeoutMs(initialParams.timeoutMs);
  const laneTaskAbortController = new AbortController();
  const laneTaskReleaseController = new AbortController();
  // Queue cancellation remains authoritative before execution and during a
  // later isolated finalizer, after the original attempt's listeners close.
  const abortSignal = AbortSignal.any([
    ...(initialParams.abortSignal ? [initialParams.abortSignal] : []),
    laneTaskAbortController.signal,
    laneTaskReleaseController.signal,
  ]);
  let laneTaskProgressAtMs = Date.now();
  let laneTaskDeadline: CommandQueueTaskDeadline | undefined;
  let notifyLaneTaskDeadline:
    | ((deadline: CommandQueueTaskDeadline | undefined) => void)
    | undefined;
  const setLaneTaskDeadline = (deadline: CommandQueueTaskDeadline | undefined) => {
    laneTaskDeadline =
      deadline?.kind === "bounded"
        ? {
            kind: "bounded",
            deadlineAtMs: deadline.deadlineAtMs + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
          }
        : deadline;
    notifyLaneTaskDeadline?.(laneTaskDeadline);
  };
  let releaseQueuedRunContext: ReturnType<typeof retainQueuedAgentRunContext>;
  let queuedRunAbortSignal: AbortSignal | undefined;
  let releaseCapacityWait: (() => void) | undefined;
  const endCapacityWait = () => {
    releaseCapacityWait?.();
    releaseCapacityWait = undefined;
  };
  const noteCapacityWait = () => {
    const params = options.getParams();
    if (!params.abortSignal?.aborted) {
      releaseCapacityWait = registerAgentRunCapacityWait(
        params.runId,
        options.getLifecycleGeneration(),
      );
    }
  };

  const releaseQueuedContext = (outcome: "admitted" | "abandoned") => {
    endCapacityWait();
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
  let activeAttemptOwner: object | undefined;
  const createAttemptControls = (input: {
    admittedRunContext: NonNullable<RunEmbeddedAgentParams["admittedRunContext"]>;
    abortSignal?: AbortSignal;
    initialTimeoutMs?: number;
    onAbort?: () => void;
  }) => {
    const owner = {};
    activeAttemptOwner = owner;
    const lifecycleGeneration = options.getLifecycleGeneration();
    const authority = getAdmittedRunDelegatedAuthority(input.admittedRunContext);
    const signal = input.abortSignal
      ? AbortSignal.any([abortSignal, input.abortSignal])
      : abortSignal;
    let state: "active" | "aborted" | "closed" = "active";
    let deadlineOwned = false;
    let timeoutReleaseTimer: ReturnType<typeof setTimeout> | undefined;
    const isCurrent = () =>
      state === "active" &&
      activeAttemptOwner === owner &&
      !signal.aborted &&
      isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) &&
      authority !== undefined &&
      getAdmittedRunDelegatedAuthority(input.admittedRunContext) === authority;
    const onAttemptDeadlineChanged = (deadline: CommandQueueTaskDeadline) => {
      if (isCurrent()) {
        deadlineOwned = true;
        setLaneTaskDeadline(deadline);
      }
    };
    if (input.initialTimeoutMs !== undefined) {
      const deadline: CommandQueueTaskDeadline =
        input.initialTimeoutMs >= MAX_TIMER_TIMEOUT_MS
          ? { kind: "unlimited" }
          : { kind: "bounded", deadlineAtMs: Date.now() + input.initialTimeoutMs };
      onAttemptDeadlineChanged(deadline);
    }
    return {
      abortSignal: signal,
      onAttemptDeadlineChanged,
      onAttemptTimeout: (reason: Error) => {
        if (isCurrent() && !timeoutReleaseTimer) {
          // Provider idle expiry can precede the execution deadline. Bound an
          // uncooperative unwind without aborting a subsequent recovery attempt.
          timeoutReleaseTimer = setTimeout(() => {
            if (isCurrent()) {
              laneTaskReleaseController.abort(reason);
            }
          }, EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS);
          timeoutReleaseTimer.unref?.();
        }
      },
      onAttemptAbort: () => {
        if (!isCurrent()) {
          return;
        }
        state = "aborted";
        laneTaskAbortController.abort(createAgentRunDirectAbortError());
        input.onAbort?.();
      },
      close: () => {
        if (state === "closed") {
          return;
        }
        // Every retry/finalizer gets a fresh closure; retained callbacks must
        // never change the next attempt's deadline or cancellation state.
        state = "closed";
        clearTimeout(timeoutReleaseTimer);
        if (activeAttemptOwner === owner) {
          activeAttemptOwner = undefined;
          noteLaneTaskProgress();
          if (deadlineOwned) {
            setLaneTaskDeadline(undefined);
          }
        }
      },
    };
  };
  const throwIfAborted = () => {
    if (!abortSignal.aborted) {
      return;
    }
    const reason = abortSignal.reason;
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
        taskTimeoutSubscribe: (onDeadline) => {
          notifyLaneTaskDeadline = onDeadline;
          onDeadline(laneTaskDeadline);
          return () => {
            if (notifyLaneTaskDeadline === onDeadline) {
              notifyLaneTaskDeadline = undefined;
            }
          };
        },
        taskTimeoutAbortSignal: abortSignal,
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
      priority: sessionLanePolicy.priority,
      onQueued: noteCapacityWait,
    };
    const taskWithCurrentLifecycle = async () => {
      endCapacityWait();
      let params = options.getParams();
      params.replyOperation?.markGlobalLaneWaitEnded();
      throwIfAborted();
      let lifecycleGeneration = options.getLifecycleGeneration();
      const currentLifecycleGeneration = getAgentEventLifecycleGeneration();
      const existingContext = getAgentRunContext(params.runId);
      if (lifecycleGeneration !== currentLifecycleGeneration) {
        const wasQueuedBeforeRotation =
          options.initialQueuedLifecycleGeneration === lifecycleGeneration;
        const canResumeAcrossRotation = sessionLanePolicy.canResumeAcrossRotation;
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
    let queuedRun: Promise<EmbeddedAgentRunResult>;
    if (params.enqueue) {
      queuedRun = params.enqueue(
        taskWithCurrentLifecycle,
        withLaneTimeout(withRunLaneWait(globalOpts)),
      );
    } else {
      noteLaneWaitIfBusy(options.globalLane);
      queuedRun = enqueueCommandInLane(
        options.globalLane,
        taskWithCurrentLifecycle,
        withLaneTimeout(withRunLaneWait(globalOpts)),
      );
    }
    return queuedRun.catch((error: unknown) => {
      if (isCommandLaneTaskTimeoutError(error)) {
        // Releasing the queue slot must also retire the attempt's action signal.
        laneTaskAbortController.abort(error);
      }
      throw error;
    });
  };
  const enqueueSession = <T>(task: () => Promise<T>, opts?: CommandQueueEnqueueOptions) => {
    const sessionOpts: CommandQueueEnqueueOptions = {
      ...opts,
      priority: sessionLanePolicy.priority,
      onQueued: noteCapacityWait,
    };
    const admittedTask = () => {
      endCapacityWait();
      return task();
    };
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
        queuedRun = params.enqueue(admittedTask, withRunLaneWait(sessionOpts));
      } else {
        noteLaneWaitIfBusy(options.sessionLane);
        queuedRun = enqueueCommandInLane(
          options.sessionLane,
          admittedTask,
          withRunLaneWait(sessionOpts),
        );
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
    abortSignal,
    laneTaskAbortController,
    laneTaskReleaseController,
    noteLaneTaskProgress,
    setLaneTaskDeadline,
    createAttemptControls,
    throwIfAborted,
  };
}
