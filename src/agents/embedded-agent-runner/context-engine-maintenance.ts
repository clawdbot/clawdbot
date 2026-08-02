/**
 * Schedules and runs deferred context-engine turn maintenance.
 */
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { publishTranscriptUpdate } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  quarantineResolvedContextEngine,
  resolveContextEngineOwnerPluginId,
} from "../../context-engine/registry.js";
import type {
  ContextEngine,
  ContextEngineMaintenanceResult,
  ContextEngineRuntimeContext,
  ContextEngineRuntimeSettings,
  ContextEngineSessionTarget,
} from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  enqueueCommandInLane,
  GatewayDrainingError,
  isGatewayDraining,
} from "../../process/command-queue.js";
import {
  completeTaskRunByRunId,
  createQueuedTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
  startTaskRunByRunId,
} from "../../tasks/detached-task-runtime.js";
import {
  cancelTaskByIdForOwner,
  findTaskByRunIdForOwner,
  updateTaskNotifyPolicyForOwner,
} from "../../tasks/task-owner-access.js";
import { findActiveSessionTask } from "../session-async-task-status.js";
import { SessionManager } from "../sessions/index.js";
import { resolveContextEngineCapabilities } from "./context-engine-capabilities.js";
import {
  createDeferredMaintenanceWriteFence,
  type DeferredMaintenanceWriteFence,
} from "./context-engine-maintenance-fence.js";
import { log } from "./logger.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";
import { resolveRuntimeTranscriptReadTarget } from "./transcript-runtime-state.js";

const TURN_MAINTENANCE_TASK_KIND = "context_engine_turn_maintenance";
const TURN_MAINTENANCE_LANE_PREFIX = "context-engine-turn-maintenance:";
const TURN_MAINTENANCE_LONG_WAIT_MS = 10_000;
// A waiting user turn should only pay for cooperative abort cleanup, not the
// background maintenance operation's otherwise unbounded runtime.
const TURN_MAINTENANCE_PREEMPT_GRACE_MS = 1_000;
const DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY = Symbol.for(
  "openclaw.contextEngineTurnMaintenanceAbortState",
);
type SessionManagerRewriteLock = <T>(operation: () => Promise<T> | T) => Promise<T>;

type ContextEngineMaintenanceParams = {
  contextEngine?: ContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: ContextEngineSessionTarget;
  sessionFile: string;
  reason: "bootstrap" | "compaction" | "turn";
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  withSessionManagerRewriteLock?: SessionManagerRewriteLock;
  runtimeContext?: ContextEngineRuntimeContext;
  runtimeSettings?: ContextEngineRuntimeSettings;
  agentId?: string;
  contextEngineAgentId?: string;
  executionMode?: "foreground" | "background";
  onDeferredMaintenance?: (promise: Promise<void>) => void;
  onDeferredMaintenanceFailure?: (error: unknown) => void;
  config?: OpenClawConfig;
  disposeDeferredContextEngineAfterMaintenance?: boolean;
};

type DeferredTurnMaintenanceScheduleParams = ContextEngineMaintenanceParams & {
  contextEngine: ContextEngine;
  sessionKey: string;
  disposeContextEngineAfterMaintenance?: boolean;
  onScheduleFailure?: (error: unknown) => void;
};

type DeferredTurnMaintenanceRunState = {
  phase: "running" | "preempting" | "blocked" | "quarantined" | "settled";
  barrier: Promise<void>;
  releaseBarrier: () => void;
  foregroundBarrier: Promise<void>;
  releaseForegroundBarrier: () => void;
  waitError?: Error;
  preemptionTimer?: ReturnType<typeof setTimeout>;
  requestForegroundPreemption: () => void;
  rerunRequested: boolean;
  latestParams: DeferredTurnMaintenanceScheduleParams;
};

const activeDeferredTurnMaintenanceRuns = new Map<string, DeferredTurnMaintenanceRunState>();

type DeferredTurnMaintenanceSignal = "SIGINT" | "SIGTERM";
type DeferredTurnMaintenanceProcessLike = Pick<NodeJS.Process, "on" | "off"> &
  Partial<Pick<NodeJS.Process, "listenerCount" | "kill" | "pid">> & {
    [DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY]?: DeferredTurnMaintenanceAbortState;
  };
type DeferredTurnMaintenanceAbortState = {
  controllers: Set<AbortController>;
  cleanupHandlers: Map<DeferredTurnMaintenanceSignal, () => void>;
};

function unregisterDeferredTurnMaintenanceAbortSignalHandlers(
  processLike: DeferredTurnMaintenanceProcessLike,
  state: DeferredTurnMaintenanceAbortState,
): void {
  for (const [signal, handler] of state.cleanupHandlers) {
    processLike.off(signal, handler);
  }
  state.cleanupHandlers.clear();
}

async function disposeDeferredMaintenanceContextEngine(
  contextEngine: ContextEngine,
): Promise<void> {
  try {
    await contextEngine.dispose?.();
  } catch (err) {
    log.warn("context engine dispose failed after deferred maintenance", {
      errorMessage: formatErrorMessage(err),
    });
  }
}

function createDeferredTurnMaintenanceAbortSignal(params?: {
  processLike?: DeferredTurnMaintenanceProcessLike;
}): {
  abortSignal: AbortSignal;
  abort: (reason: Error) => void;
  dispose: () => void;
} {
  const processLike = (params?.processLike ?? process) as DeferredTurnMaintenanceProcessLike;
  const state = (processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY] ??= {
    controllers: new Set<AbortController>(),
    cleanupHandlers: new Map<DeferredTurnMaintenanceSignal, () => void>(),
  });
  const handleTerminationSignal = (signalName: DeferredTurnMaintenanceSignal) => {
    const shouldReraise = processLike.listenerCount?.(signalName) === 1;
    for (const activeController of state.controllers) {
      if (!activeController.signal.aborted) {
        activeController.abort(
          new Error(`received ${signalName} while waiting for deferred maintenance`),
        );
      }
    }
    state.controllers.clear();
    unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state);
    if (shouldReraise && typeof processLike.kill === "function") {
      try {
        processLike.kill(processLike.pid ?? process.pid, signalName);
      } catch {
        // Ignore shutdown-path failures.
      }
    }
  };
  if (state.cleanupHandlers.size === 0) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => handleTerminationSignal(signal);
      state.cleanupHandlers.set(signal, handler);
      processLike.on(signal, handler);
    }
  }

  const controller = new AbortController();
  state.controllers.add(controller);
  return {
    abortSignal: controller.signal,
    abort: (reason) => {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    },
    dispose: () => {
      state.controllers.delete(controller);
      if (state.controllers.size === 0) {
        unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state);
      }
    },
  };
}

function resetDeferredTurnMaintenanceStateForTest(): void {
  for (const state of activeDeferredTurnMaintenanceRuns.values()) {
    if (state.preemptionTimer) {
      clearTimeout(state.preemptionTimer);
    }
  }
  activeDeferredTurnMaintenanceRuns.clear();
  const processLike = process as DeferredTurnMaintenanceProcessLike;
  const state = processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY];
  if (!state) {
    return;
  }
  state.controllers.clear();
  unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state);
  delete processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY];
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.contextEngineMaintenanceTestApi")
  ] = {
    createDeferredTurnMaintenanceAbortSignal,
    resetDeferredTurnMaintenanceStateForTest,
  };
}

export async function waitForDeferredTurnMaintenanceForSession(sessionKey?: string): Promise<void> {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey) {
    return;
  }
  const activeRun = activeDeferredTurnMaintenanceRuns.get(normalizedSessionKey);
  if (!activeRun) {
    return;
  }
  activeRun.requestForegroundPreemption();
  await activeRun.foregroundBarrier;
  if (activeRun.waitError) {
    throw activeRun.waitError;
  }
}

function buildTurnMaintenanceTaskDescriptor(params: {
  sessionKey: string;
  runId?: string;
  notifyPolicy?: "silent" | "done_only" | "state_changes";
  deliveryStatus?: "not_applicable" | "pending";
}) {
  const runId =
    params.runId ??
    `turn-maint:${params.sessionKey}:${Date.now().toString(36)}:${randomUUID().slice(0, 8)}`;
  return createQueuedTaskRun({
    runtime: "acp",
    taskKind: TURN_MAINTENANCE_TASK_KIND,
    sourceId: TURN_MAINTENANCE_TASK_KIND,
    requesterSessionKey: params.sessionKey,
    ownerKey: params.sessionKey,
    scopeKind: "session",
    runId,
    label: "Context engine turn maintenance",
    task: "Deferred context-engine maintenance after turn.",
    notifyPolicy: params.notifyPolicy ?? "silent",
    // Fast maintenance stays silent and must not create a one-task flow.
    // Long-running and failed workers promote it to pending before notifying.
    deliveryStatus: params.deliveryStatus ?? "not_applicable",
    preferMetadata: true,
  });
}

/**
 * Attach runtime-owned transcript rewrite helpers to an existing
 * context-engine runtime context payload.
 */
function buildContextEngineMaintenanceRuntimeContext(
  params: Omit<ContextEngineMaintenanceParams, "reason"> & {
    allowDeferredCompactionExecution?: boolean;
    purpose?: string;
    contextEnginePluginId?: string;
    writeFence?: DeferredMaintenanceWriteFence;
  },
): ContextEngineRuntimeContext {
  return {
    ...params.runtimeContext,
    ...resolveContextEngineCapabilities({
      config: params.config,
      sessionKey: params.sessionKey,
      explicitAgentId: params.contextEngineAgentId,
      authProfileId: normalizeOptionalString(params.runtimeContext?.authProfileId),
      contextEnginePluginId: params.contextEnginePluginId,
      purpose: params.purpose ?? "context-engine.maintenance",
    }),
    ...(params.sessionTarget ? { sessionTarget: params.sessionTarget } : {}),
    ...(params.allowDeferredCompactionExecution ? { allowDeferredCompactionExecution: true } : {}),
    rewriteTranscriptEntries: async (request) => {
      const rewrite = async () => {
        const runtimeAgentId = params.sessionTarget?.agentId ?? params.agentId;
        const runtimeSessionKey = normalizeOptionalString(
          params.sessionTarget?.sessionKey ?? params.sessionKey,
        );
        if (!runtimeSessionKey) {
          throw new Error("Context-engine transcript rewrite requires a session key");
        }
        const runtimeStorePath =
          params.sessionTarget?.storePath ??
          (runtimeAgentId
            ? resolveSessionStorePathCore(params.config?.session?.store, {
                agentId: runtimeAgentId,
              })
            : undefined);
        let runtimeTarget:
          | Awaited<ReturnType<typeof resolveRuntimeTranscriptReadTarget>>
          | undefined;
        let sessionManager = params.sessionManager;
        if (!sessionManager) {
          runtimeTarget = await resolveRuntimeTranscriptReadTarget({
            sessionId: params.sessionTarget?.sessionId ?? params.sessionId,
            sessionKey: runtimeSessionKey,
            sessionFile: params.sessionFile,
            ...(runtimeAgentId ? { agentId: runtimeAgentId } : {}),
            ...(runtimeStorePath ? { storePath: runtimeStorePath } : {}),
          });
          sessionManager = SessionManager.open(runtimeTarget);
        }
        const rewriteSessionManagerEntries = () =>
          rewriteTranscriptEntriesInSessionManager({
            sessionManager,
            replacements: request.replacements,
          });
        const result = params.withSessionManagerRewriteLock
          ? await params.withSessionManagerRewriteLock(rewriteSessionManagerEntries)
          : rewriteSessionManagerEntries();
        if (result.changed && runtimeTarget) {
          await publishTranscriptUpdate(runtimeTarget);
        }
        return result;
      };
      return params.writeFence ? await params.writeFence.run(rewrite) : await rewrite();
    },
  };
}

async function executeContextEngineMaintenance(
  params: ContextEngineMaintenanceParams & {
    contextEngine: ContextEngine;
    executionMode: "foreground" | "background";
    abortSignal?: AbortSignal;
    writeFence?: DeferredMaintenanceWriteFence;
  },
): Promise<ContextEngineMaintenanceResult | undefined> {
  if (typeof params.contextEngine.maintain !== "function") {
    return undefined;
  }
  params.abortSignal?.throwIfAborted();
  const result = await params.contextEngine.maintain({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionTarget: params.sessionTarget,
    sessionFile: params.sessionFile,
    runtimeSettings: params.runtimeSettings,
    abortSignal: params.abortSignal,
    runtimeContext: buildContextEngineMaintenanceRuntimeContext({
      ...params,
      sessionManager: params.executionMode === "background" ? undefined : params.sessionManager,
      withSessionManagerRewriteLock:
        params.executionMode === "background" ? undefined : params.withSessionManagerRewriteLock,
      allowDeferredCompactionExecution: params.executionMode === "background",
      purpose: `context-engine.${params.reason}.maintenance`,
      contextEnginePluginId: resolveContextEngineOwnerPluginId(params.contextEngine),
      writeFence: params.writeFence,
    }),
  });
  params.abortSignal?.throwIfAborted();
  if (result.changed) {
    log.info(
      `[context-engine] maintenance(${params.reason}) changed transcript ` +
        `rewrittenEntries=${result.rewrittenEntries} bytesFreed=${result.bytesFreed} ` +
        `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
    );
  }
  return result;
}

async function runDeferredTurnMaintenanceWorker(
  params: DeferredTurnMaintenanceScheduleParams & {
    runId: string;
    abortSignal: AbortSignal;
    writeFence: DeferredMaintenanceWriteFence;
    wasForegroundPreempted: () => boolean;
  },
): Promise<void> {
  let surfacedUserNotice = false;
  let longRunningTimer: ReturnType<typeof setTimeout> | undefined;
  const stopLongRunningProgress = () => {
    if (longRunningTimer) {
      clearTimeout(longRunningTimer);
      longRunningTimer = undefined;
    }
  };
  const taskRun = { runId: params.runId, runtime: "acp" as const, sessionKey: params.sessionKey };
  const makeTaskVisible = (notifyPolicy: "done_only" | "state_changes") =>
    buildTurnMaintenanceTaskDescriptor({
      sessionKey: params.sessionKey,
      runId: params.runId,
      notifyPolicy,
      deliveryStatus: "pending",
    });

  try {
    const runningAt = Date.now();
    startTaskRunByRunId({
      ...taskRun,
      startedAt: runningAt,
      lastEventAt: runningAt,
      progressSummary: "Running deferred maintenance.",
      eventSummary: "Starting deferred maintenance.",
    });
    longRunningTimer = setTimeout(() => {
      try {
        makeTaskVisible("state_changes");
        surfacedUserNotice = true;
        const summary = "Deferred maintenance is still running.";
        recordTaskRunProgressByRunId({
          ...taskRun,
          lastEventAt: Date.now(),
          progressSummary: summary,
          eventSummary: summary,
        });
      } catch (error) {
        log.warn(`failed to surface deferred maintenance progress: ${String(error)}`);
      }
    }, TURN_MAINTENANCE_LONG_WAIT_MS);
    if (params.abortSignal.aborted) {
      stopLongRunningProgress();
    } else {
      params.abortSignal.addEventListener("abort", stopLongRunningProgress, { once: true });
    }

    const result = await executeContextEngineMaintenance({
      ...params,
      executionMode: "background",
      abortSignal: params.abortSignal,
      writeFence: params.writeFence,
    });
    const endedAt = Date.now();
    completeTaskRunByRunId({
      ...taskRun,
      endedAt,
      lastEventAt: endedAt,
      progressSummary: result?.changed
        ? "Deferred maintenance completed with transcript changes."
        : "Deferred maintenance completed.",
      terminalSummary: result?.changed
        ? `Rewrote ${result.rewrittenEntries} transcript entr${result.rewrittenEntries === 1 ? "y" : "ies"} and freed ${result.bytesFreed} bytes.`
        : "No transcript changes were needed.",
    });
  } catch (err) {
    if (params.abortSignal.aborted) {
      const task = findTaskByRunIdForOwner({
        runId: params.runId,
        callerOwnerKey: params.sessionKey,
        callerAgentId: params.agentId,
        config: params.config,
      });
      if (task?.status === "queued" || task?.status === "running") {
        cancelTaskByIdForOwner({
          taskId: task.taskId,
          callerOwnerKey: params.sessionKey,
          callerAgentId: params.agentId,
          config: params.config,
          endedAt: Date.now(),
          terminalSummary: params.wasForegroundPreempted()
            ? "Deferred maintenance yielded to a waiting foreground turn."
            : "Deferred maintenance cancelled during shutdown.",
        });
      }
      return;
    }
    const endedAt = Date.now();
    const reason = formatErrorMessage(err);
    if (!surfacedUserNotice) {
      makeTaskVisible("done_only");
    }
    failTaskRunByRunId({
      ...taskRun,
      endedAt,
      lastEventAt: endedAt,
      error: reason,
      progressSummary: "Deferred maintenance failed.",
      terminalSummary: reason,
    });
    log.warn(`deferred context engine maintenance failed: ${reason}`);
  } finally {
    params.abortSignal.removeEventListener("abort", stopLongRunningProgress);
    stopLongRunningProgress();
    if (params.disposeContextEngineAfterMaintenance) {
      await disposeDeferredMaintenanceContextEngine(params.contextEngine);
    }
  }
}

function scheduleDeferredTurnMaintenance(
  params: DeferredTurnMaintenanceScheduleParams,
): Promise<void> | undefined {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return undefined;
  }
  if (isGatewayDraining()) {
    params.onScheduleFailure?.(new GatewayDrainingError());
    return undefined;
  }

  const activeRun = activeDeferredTurnMaintenanceRuns.get(sessionKey);
  if (activeRun) {
    const supersededParams = activeRun.rerunRequested ? activeRun.latestParams : undefined;
    activeRun.rerunRequested = true;
    activeRun.latestParams = { ...params, sessionKey };
    if (
      supersededParams?.disposeContextEngineAfterMaintenance &&
      supersededParams.contextEngine !== params.contextEngine
    ) {
      void disposeDeferredMaintenanceContextEngine(supersededParams.contextEngine);
    }
    return activeRun.barrier;
  }

  const existingTask = findActiveSessionTask({
    sessionKey,
    runtime: "acp",
    taskKind: TURN_MAINTENANCE_TASK_KIND,
  });
  const reusableTask = existingTask?.runId?.trim() ? existingTask : undefined;
  if (existingTask && !reusableTask) {
    updateTaskNotifyPolicyForOwner({
      taskId: existingTask.taskId,
      callerOwnerKey: sessionKey,
      callerAgentId: params.agentId,
      config: params.config,
      notifyPolicy: "silent",
    });
    cancelTaskByIdForOwner({
      taskId: existingTask.taskId,
      callerOwnerKey: sessionKey,
      callerAgentId: params.agentId,
      config: params.config,
      endedAt: Date.now(),
      terminalSummary: "Superseded by refreshed deferred maintenance task.",
    });
  }
  const task =
    reusableTask ??
    buildTurnMaintenanceTaskDescriptor({
      sessionKey,
    });
  if (!task) {
    log.warn("[context-engine] failed to create deferred turn maintenance task", {
      sessionKey,
    });
    return undefined;
  }
  const lane = `${TURN_MAINTENANCE_LANE_PREFIX}${sessionKey}`;
  log.info(
    `[context-engine] deferred turn maintenance ${reusableTask ? "resuming" : "queued"} ` +
      `taskId=${task.taskId} sessionKey=${sessionKey} lane=${lane}`,
  );

  const cancelFailedTask = (error: unknown) => {
    const errorMessage = formatErrorMessage(error);
    log.warn(`failed to schedule deferred context engine maintenance: ${errorMessage}`);
    cancelTaskByIdForOwner({
      taskId: task.taskId,
      callerOwnerKey: sessionKey,
      callerAgentId: params.agentId,
      config: params.config,
      endedAt: Date.now(),
      terminalSummary: `Deferred maintenance could not be scheduled: ${errorMessage}`,
    });
  };
  const schedulerAbort = createDeferredTurnMaintenanceAbortSignal();
  const writeFence = createDeferredMaintenanceWriteFence();
  let foregroundPreempted = false;
  let preemptionWriteDrain: Promise<void> | undefined;
  let releaseBarrier = () => {};
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });
  let releaseForegroundBarrier = () => {};
  const foregroundBarrier = new Promise<void>((resolve) => {
    releaseForegroundBarrier = resolve;
  });
  const terminalizePreemption = (error: Error, terminalSummary: string) => {
    buildTurnMaintenanceTaskDescriptor({
      sessionKey,
      runId: task.runId,
      notifyPolicy: "state_changes",
      deliveryStatus: "pending",
    });
    const endedAt = Date.now();
    failTaskRunByRunId({
      runId: task.runId!,
      runtime: "acp",
      sessionKey,
      status: "timed_out",
      endedAt,
      lastEventAt: endedAt,
      error: error.message,
      progressSummary: "Deferred maintenance did not yield to a waiting turn.",
      terminalSummary,
    });
  };
  let runPromise: Promise<void>;
  try {
    runPromise = enqueueCommandInLane(lane, () =>
      runDeferredTurnMaintenanceWorker({
        ...params,
        sessionKey,
        runId: task.runId!,
        abortSignal: schedulerAbort.abortSignal,
        writeFence,
        wasForegroundPreempted: () => foregroundPreempted,
      }),
    );
  } catch (err) {
    schedulerAbort.dispose();
    cancelFailedTask(err);
    return undefined;
  }
  const cleanupDeferredTurnMaintenance = async () => {
    let current = activeDeferredTurnMaintenanceRuns.get(sessionKey);
    if (current !== state) {
      return;
    }
    if (preemptionWriteDrain) {
      await preemptionWriteDrain;
      current = activeDeferredTurnMaintenanceRuns.get(sessionKey);
      if (current !== state) {
        return;
      }
    }
    schedulerAbort.dispose();
    current.phase = "settled";
    if (current.preemptionTimer) {
      clearTimeout(current.preemptionTimer);
      current.preemptionTimer = undefined;
    }
    const shutdownTriggered = schedulerAbort.abortSignal.aborted;
    const rerunParams =
      current.rerunRequested && !shutdownTriggered ? current.latestParams : undefined;
    const discardedRerunParams =
      current.rerunRequested && shutdownTriggered ? current.latestParams : undefined;
    activeDeferredTurnMaintenanceRuns.delete(sessionKey);
    if (rerunParams) {
      await scheduleDeferredTurnMaintenance(rerunParams);
    } else if (discardedRerunParams?.disposeContextEngineAfterMaintenance) {
      await disposeDeferredMaintenanceContextEngine(discardedRerunParams.contextEngine);
    }
    current.releaseBarrier();
    current.releaseForegroundBarrier();
  };
  const trackedPromise = runPromise
    .catch((err: unknown) => {
      params.onScheduleFailure?.(err);
      cancelFailedTask(err);
    })
    .then(cleanupDeferredTurnMaintenance, async (error: unknown) => {
      await cleanupDeferredTurnMaintenance();
      throw error;
    });
  const state: DeferredTurnMaintenanceRunState = {
    phase: "running",
    barrier,
    releaseBarrier,
    foregroundBarrier,
    releaseForegroundBarrier,
    requestForegroundPreemption: () => {
      if (state.phase !== "running") {
        return;
      }
      state.phase = "preempting";
      foregroundPreempted = true;
      const preemptionError = new Error(
        "Deferred context-engine maintenance did not yield to a waiting foreground turn.",
      );
      schedulerAbort.abort(preemptionError);
      const writeDrain = writeFence.close(preemptionError);
      preemptionWriteDrain = writeDrain;
      state.preemptionTimer = setTimeout(() => {
        state.preemptionTimer = undefined;
        if (
          state.phase !== "preempting" ||
          activeDeferredTurnMaintenanceRuns.get(sessionKey) !== state
        ) {
          return;
        }
        const quarantined = quarantineResolvedContextEngine({
          contextEngine: params.contextEngine,
          operation: "maintain",
          error: preemptionError,
        });
        state.phase = quarantined ? "quarantined" : "blocked";
        state.waitError = new Error(
          quarantined
            ? "Deferred maintenance did not stop. The context engine was quarantined, but this turn was stopped to avoid overlapping engine operations. Retry after maintenance finishes or restart the gateway."
            : "Deferred maintenance did not stop. The active context engine cannot be quarantined, so this turn was stopped to avoid overlapping engine operations. Retry after maintenance finishes or restart the gateway.",
        );
        terminalizePreemption(preemptionError, state.waitError.message);
        // Fail the waiting turn, but keep the run barrier closed until the
        // original plugin call and every admitted host write have settled.
        state.releaseForegroundBarrier();
      }, TURN_MAINTENANCE_PREEMPT_GRACE_MS);
      state.preemptionTimer.unref?.();
    },
    rerunRequested: false,
    latestParams: { ...params, sessionKey },
  };
  activeDeferredTurnMaintenanceRuns.set(sessionKey, state);
  void trackedPromise;
  return barrier;
}

/**
 * Run optional context-engine transcript maintenance and normalize the result.
 */
export async function runContextEngineMaintenance(
  params: ContextEngineMaintenanceParams,
): Promise<ContextEngineMaintenanceResult | undefined> {
  const contextEngine = params.contextEngine;
  if (typeof contextEngine?.maintain !== "function") {
    return undefined;
  }

  const executionMode = params.executionMode ?? "foreground";
  const shouldDefer =
    params.reason === "turn" &&
    executionMode !== "background" &&
    contextEngine.info.turnMaintenanceMode === "background";

  if (shouldDefer) {
    try {
      const sessionKey = normalizeOptionalString(params.sessionKey);
      if (!sessionKey) {
        params.onDeferredMaintenanceFailure?.(
          new Error("Deferred context-engine maintenance requires a session key"),
        );
        return undefined;
      }
      const deferred = scheduleDeferredTurnMaintenance({
        ...params,
        contextEngine,
        sessionKey,
        disposeContextEngineAfterMaintenance: params.disposeDeferredContextEngineAfterMaintenance,
        onScheduleFailure: params.onDeferredMaintenanceFailure,
      });
      if (deferred) {
        params.onDeferredMaintenance?.(deferred);
      }
    } catch (err) {
      log.warn(`failed to schedule deferred context engine maintenance: ${String(err)}`);
    }
    return undefined;
  }

  if (executionMode !== "background") {
    await waitForDeferredTurnMaintenanceForSession(params.sessionKey ?? params.sessionId);
  }

  try {
    return await executeContextEngineMaintenance({ ...params, contextEngine, executionMode });
  } catch (err) {
    log.warn(`context engine maintain failed (${params.reason}): ${String(err)}`);
    return undefined;
  }
}
