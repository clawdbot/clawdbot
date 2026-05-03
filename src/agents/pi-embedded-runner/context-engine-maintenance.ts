import { randomUUID } from "node:crypto";
import type {
  ContextEngine,
  ContextEngineMaintenanceResult,
  ContextEngineRuntimeContext,
} from "../../context-engine/types.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { enqueueCommandInLane, getQueueSize } from "../../process/command-queue.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  completeTaskRunByRunId,
  createQueuedTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
  setDetachedTaskDeliveryStatusByRunId,
  startTaskRunByRunId,
} from "../../tasks/detached-task-runtime.js";
import {
  cancelTaskByIdForOwner,
  findTaskByRunIdForOwner,
  updateTaskNotifyPolicyForOwner,
} from "../../tasks/task-owner-access.js";
import { findActiveSessionTask } from "../session-async-task-status.js";
import type { SessionWriteLockAcquireTimeoutConfig } from "../session-write-lock.js";
import { resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import {
  rewriteTranscriptEntriesInSessionFile,
  rewriteTranscriptEntriesInSessionManager,
} from "./transcript-rewrite.js";

const TURN_MAINTENANCE_TASK_KIND = "context_engine_turn_maintenance";
const TURN_MAINTENANCE_TASK_LABEL = "Context engine turn maintenance";
const TURN_MAINTENANCE_TASK_TASK = "Deferred context-engine maintenance after turn.";
const TURN_MAINTENANCE_LANE_PREFIX = "context-engine-turn-maintenance:";
const TURN_MAINTENANCE_WAIT_POLL_MS = 100;
const TURN_MAINTENANCE_LONG_WAIT_MS = 10_000;
const DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY = Symbol.for(
  "openclaw.contextEngineTurnMaintenanceAbortState",
);
type DeferredTurnMaintenanceScheduleParams = {
  contextEngine: ContextEngine;
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  runtimeContext?: ContextEngineRuntimeContext;
  config?: SessionWriteLockAcquireTimeoutConfig;
};

type DeferredTurnMaintenanceRunState = {
  promise: Promise<void>;
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
  registered: boolean;
  controllers: Set<AbortController>;
  cleanupHandlers: Map<DeferredTurnMaintenanceSignal, () => void>;
};

function resolveDeferredTurnMaintenanceAbortState(
  processLike: DeferredTurnMaintenanceProcessLike,
): DeferredTurnMaintenanceAbortState {
  const existing = processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY];
  if (existing) {
    return existing;
  }
  const created: DeferredTurnMaintenanceAbortState = {
    registered: false,
    controllers: new Set<AbortController>(),
    cleanupHandlers: new Map<DeferredTurnMaintenanceSignal, () => void>(),
  };
  processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY] = created;
  return created;
}

function unregisterDeferredTurnMaintenanceAbortSignalHandlers(
  processLike: DeferredTurnMaintenanceProcessLike,
  state: DeferredTurnMaintenanceAbortState,
): void {
  if (!state.registered) {
    return;
  }
  for (const [signal, handler] of state.cleanupHandlers) {
    processLike.off(signal, handler);
  }
  state.cleanupHandlers.clear();
  state.registered = false;
}

function normalizeSessionKey(sessionKey?: string): string | undefined {
  return normalizeOptionalString(sessionKey) || undefined;
}

function resolveDeferredTurnMaintenanceLane(sessionKey: string): string {
  return `${TURN_MAINTENANCE_LANE_PREFIX}${sessionKey}`;
}

export function createDeferredTurnMaintenanceAbortSignal(params?: {
  processLike?: DeferredTurnMaintenanceProcessLike;
}): {
  abortSignal?: AbortSignal;
  dispose: () => void;
} {
  if (typeof AbortController === "undefined") {
    return { abortSignal: undefined, dispose: () => {} };
  }

  const processLike = (params?.processLike ?? process) as DeferredTurnMaintenanceProcessLike;
  const state = resolveDeferredTurnMaintenanceAbortState(processLike);
  const handleTerminationSignal = (signalName: DeferredTurnMaintenanceSignal) => {
    const shouldReraise =
      typeof processLike.listenerCount === "function"
        ? processLike.listenerCount(signalName) === 1
        : false;
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
  if (!state.registered) {
    state.registered = true;
    const onSigint = () => handleTerminationSignal("SIGINT");
    const onSigterm = () => handleTerminationSignal("SIGTERM");
    state.cleanupHandlers.set("SIGINT", onSigint);
    state.cleanupHandlers.set("SIGTERM", onSigterm);
    processLike.on("SIGINT", onSigint);
    processLike.on("SIGTERM", onSigterm);
  }

  const controller = new AbortController();
  state.controllers.add(controller);
  let disposed = false;

  const cleanup = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    state.controllers.delete(controller);
    if (state.controllers.size === 0) {
      unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state);
    }
  };

  return {
    abortSignal: controller.signal,
    dispose: cleanup,
  };
}

export function resetDeferredTurnMaintenanceStateForTest(): void {
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

function markDeferredTurnMaintenanceTaskScheduleFailure(params: {
  sessionKey: string;
  taskId: string;
  error: unknown;
}): void {
  const errorMessage = formatErrorMessage(params.error);
  log.warn(`failed to schedule deferred context engine maintenance: ${errorMessage}`);
  cancelTaskByIdForOwner({
    taskId: params.taskId,
    callerOwnerKey: params.sessionKey,
    endedAt: Date.now(),
    terminalSummary: `Deferred maintenance could not be scheduled: ${errorMessage}`,
  });
}

function buildTurnMaintenanceTaskDescriptor(params: { sessionKey: string }) {
  const runId = `turn-maint:${params.sessionKey}:${Date.now().toString(36)}:${randomUUID().slice(
    0,
    8,
  )}`;
  return createQueuedTaskRun({
    runtime: "acp",
    taskKind: TURN_MAINTENANCE_TASK_KIND,
    sourceId: TURN_MAINTENANCE_TASK_KIND,
    requesterSessionKey: params.sessionKey,
    ownerKey: params.sessionKey,
    scopeKind: "session",
    runId,
    label: TURN_MAINTENANCE_TASK_LABEL,
    task: TURN_MAINTENANCE_TASK_TASK,
    notifyPolicy: "silent",
    deliveryStatus: "pending",
    preferMetadata: true,
  });
}

function promoteTurnMaintenanceTaskVisibility(params: {
  sessionKey: string;
  runId: string;
  notifyPolicy: "done_only" | "state_changes";
}) {
  const task = findTaskByRunIdForOwner({
    runId: params.runId,
    callerOwnerKey: params.sessionKey,
  });
  if (!task) {
    return createQueuedTaskRun({
      runtime: "acp",
      taskKind: TURN_MAINTENANCE_TASK_KIND,
      sourceId: TURN_MAINTENANCE_TASK_KIND,
      requesterSessionKey: params.sessionKey,
      ownerKey: params.sessionKey,
      scopeKind: "session",
      runId: params.runId,
      label: TURN_MAINTENANCE_TASK_LABEL,
      task: TURN_MAINTENANCE_TASK_TASK,
      notifyPolicy: params.notifyPolicy,
      deliveryStatus: "pending",
      preferMetadata: true,
    });
  }
  setDetachedTaskDeliveryStatusByRunId({
    runId: params.runId,
    runtime: "acp",
    sessionKey: params.sessionKey,
    deliveryStatus: "pending",
  });
  if (task.notifyPolicy !== params.notifyPolicy) {
    updateTaskNotifyPolicyForOwner({
      taskId: task.taskId,
      callerOwnerKey: params.sessionKey,
      notifyPolicy: params.notifyPolicy,
    });
  }
  return (
    findTaskByRunIdForOwner({
      runId: params.runId,
      callerOwnerKey: params.sessionKey,
    }) ?? task
  );
}

/**
 * Attach runtime-owned transcript rewrite helpers to an existing
 * context-engine runtime context payload.
 */
export function buildContextEngineMaintenanceRuntimeContext(params: {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  runtimeContext?: ContextEngineRuntimeContext;
  allowDeferredCompactionExecution?: boolean;
  deferTranscriptRewriteToSessionLane?: boolean;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): ContextEngineRuntimeContext {
  return {
    ...params.runtimeContext,
    ...(params.allowDeferredCompactionExecution ? { allowDeferredCompactionExecution: true } : {}),
    rewriteTranscriptEntries: async (request) => {
      if (params.sessionManager) {
        return rewriteTranscriptEntriesInSessionManager({
          sessionManager: params.sessionManager,
          replacements: request.replacements,
        });
      }
      const rewriteTranscriptEntriesInFile = async () =>
        await rewriteTranscriptEntriesInSessionFile({
          sessionFile: params.sessionFile,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          config: params.config,
          request,
        });
      const rewriteSessionKey = normalizeSessionKey(params.sessionKey ?? params.sessionId);
      if (params.deferTranscriptRewriteToSessionLane && rewriteSessionKey) {
        return await enqueueCommandInLane(
          resolveSessionLane(rewriteSessionKey),
          async () => await rewriteTranscriptEntriesInFile(),
        );
      }
      return await rewriteTranscriptEntriesInFile();
    },
  };
}

async function executeContextEngineMaintenance(params: {
  contextEngine: ContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  reason: "bootstrap" | "compaction" | "turn";
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  runtimeContext?: ContextEngineRuntimeContext;
  executionMode: "foreground" | "background";
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<ContextEngineMaintenanceResult | undefined> {
  if (typeof params.contextEngine.maintain !== "function") {
    return undefined;
  }
  const result = await params.contextEngine.maintain({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    runtimeContext: buildContextEngineMaintenanceRuntimeContext({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      sessionManager: params.executionMode === "background" ? undefined : params.sessionManager,
      runtimeContext: params.runtimeContext,
      allowDeferredCompactionExecution: params.executionMode === "background",
      deferTranscriptRewriteToSessionLane: params.executionMode === "background",
      config: params.config,
    }),
  });
  if (result.changed) {
    log.info(
      `[context-engine] maintenance(${params.reason}) changed transcript ` +
        `rewrittenEntries=${result.rewrittenEntries} bytesFreed=${result.bytesFreed} ` +
        `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
    );
  }
  return result;
}

async function runDeferredTurnMaintenanceWorker(params: {
  contextEngine: ContextEngine;
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  runtimeContext?: ContextEngineRuntimeContext;
  runId: string;
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<void> {
  let surfacedUserNotice = false;
  let longRunningTimer: ReturnType<typeof setTimeout> | null = null;
  const shutdownAbort = createDeferredTurnMaintenanceAbortSignal();
  const surfaceMaintenanceUpdate = (summary: string, eventSummary: string) => {
    promoteTurnMaintenanceTaskVisibility({
      sessionKey: params.sessionKey,
      runId: params.runId,
      notifyPolicy: "state_changes",
    });
    surfacedUserNotice = true;
    recordTaskRunProgressByRunId({
      runId: params.runId,
      runtime: "acp",
      sessionKey: params.sessionKey,
      lastEventAt: Date.now(),
      progressSummary: summary,
      eventSummary,
    });
  };

  try {
    const sessionLane = resolveSessionLane(params.sessionKey);
    const startedWaitingAt = Date.now();
    let lastWaitNoticeAt = 0;

    for (;;) {
      while (getQueueSize(sessionLane) > 0) {
        const now = Date.now();
        if (
          now - startedWaitingAt >= TURN_MAINTENANCE_LONG_WAIT_MS &&
          now - lastWaitNoticeAt >= TURN_MAINTENANCE_LONG_WAIT_MS
        ) {
          lastWaitNoticeAt = now;
          surfaceMaintenanceUpdate(
            "Waiting for the session lane to go idle.",
            surfacedUserNotice
              ? "Still waiting for the session lane to go idle."
              : "Deferred maintenance is waiting for the session lane to go idle.",
          );
        }
        await sleepWithAbort(TURN_MAINTENANCE_WAIT_POLL_MS, shutdownAbort.abortSignal);
      }
      await Promise.resolve();
      if (getQueueSize(sessionLane) === 0) {
        break;
      }
    }

    const runningAt = Date.now();
    startTaskRunByRunId({
      runId: params.runId,
      runtime: "acp",
      sessionKey: params.sessionKey,
      startedAt: runningAt,
      lastEventAt: runningAt,
      progressSummary: "Running deferred maintenance.",
      eventSummary: "Starting deferred maintenance.",
    });
    longRunningTimer = setTimeout(() => {
      try {
        surfaceMaintenanceUpdate(
          "Deferred maintenance is still running.",
          "Deferred maintenance is still running.",
        );
      } catch (error) {
        log.warn(`failed to surface deferred maintenance progress: ${String(error)}`);
      }
    }, TURN_MAINTENANCE_LONG_WAIT_MS);

    const result = await executeContextEngineMaintenance({
      contextEngine: params.contextEngine,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      reason: "turn",
      sessionManager: params.sessionManager,
      runtimeContext: params.runtimeContext,
      config: params.config,
      executionMode: "background",
    });
    if (longRunningTimer) {
      clearTimeout(longRunningTimer);
      longRunningTimer = null;
    }

    const endedAt = Date.now();
    completeTaskRunByRunId({
      runId: params.runId,
      runtime: "acp",
      sessionKey: params.sessionKey,
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
    if (shutdownAbort.abortSignal?.aborted) {
      if (longRunningTimer) {
        clearTimeout(longRunningTimer);
        longRunningTimer = null;
      }
      const task = findTaskByRunIdForOwner({
        runId: params.runId,
        callerOwnerKey: params.sessionKey,
      });
      if (task) {
        cancelTaskByIdForOwner({
          taskId: task.taskId,
          callerOwnerKey: params.sessionKey,
          endedAt: Date.now(),
          terminalSummary: "Deferred maintenance cancelled during shutdown.",
        });
      }
      return;
    }
    if (longRunningTimer) {
      clearTimeout(longRunningTimer);
      longRunningTimer = null;
    }
    const endedAt = Date.now();
    const reason = formatErrorMessage(err);
    if (!surfacedUserNotice) {
      promoteTurnMaintenanceTaskVisibility({
        sessionKey: params.sessionKey,
        runId: params.runId,
        notifyPolicy: "done_only",
      });
    }
    failTaskRunByRunId({
      runId: params.runId,
      runtime: "acp",
      sessionKey: params.sessionKey,
      endedAt,
      lastEventAt: endedAt,
      error: reason,
      progressSummary: "Deferred maintenance failed.",
      terminalSummary: reason,
    });
    log.warn(`deferred context engine maintenance failed: ${reason}`);
  } finally {
    shutdownAbort.dispose();
  }
}

function scheduleDeferredTurnMaintenance(params: DeferredTurnMaintenanceScheduleParams): void {
  const sessionKey = normalizeSessionKey(params.sessionKey);
  if (!sessionKey) {
    return;
  }
  const activeRun = activeDeferredTurnMaintenanceRuns.get(sessionKey);
  if (activeRun) {
    activeRun.rerunRequested = true;
    activeRun.latestParams = { ...params, sessionKey };
    return;
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
      notifyPolicy: "silent",
    });
    cancelTaskByIdForOwner({
      taskId: existingTask.taskId,
      callerOwnerKey: sessionKey,
      endedAt: Date.now(),
      terminalSummary: "Superseded by refreshed deferred maintenance task.",
    });
  }
  const task =
    reusableTask ??
    buildTurnMaintenanceTaskDescriptor({
      sessionKey,
    });
  log.info(
    `[context-engine] deferred turn maintenance ${reusableTask ? "resuming" : "queued"} ` +
      `taskId=${task.taskId} sessionKey=${sessionKey} lane=${resolveDeferredTurnMaintenanceLane(sessionKey)}`,
  );

  const schedulerAbort = createDeferredTurnMaintenanceAbortSignal();
  let runPromise: Promise<void>;
  try {
    runPromise = enqueueCommandInLane(resolveDeferredTurnMaintenanceLane(sessionKey), async () =>
      runDeferredTurnMaintenanceWorker({
        contextEngine: params.contextEngine,
        sessionId: params.sessionId,
        sessionKey,
        sessionFile: params.sessionFile,
        sessionManager: params.sessionManager,
        runtimeContext: params.runtimeContext,
        config: params.config,
        runId: task.runId!,
      }),
    );
  } catch (err) {
    schedulerAbort.dispose();
    markDeferredTurnMaintenanceTaskScheduleFailure({
      sessionKey,
      taskId: task.taskId,
      error: err,
    });
    return;
  }
  let state!: DeferredTurnMaintenanceRunState;
  const trackedPromise = runPromise
    .catch((err) => {
      markDeferredTurnMaintenanceTaskScheduleFailure({
        sessionKey,
        taskId: task.taskId,
        error: err,
      });
    })
    .finally(() => {
      schedulerAbort.dispose();
      const current = activeDeferredTurnMaintenanceRuns.get(sessionKey);
      if (current !== state) {
        return;
      }
      const shutdownTriggered = schedulerAbort.abortSignal?.aborted === true;
      const rerunParams =
        current.rerunRequested && !shutdownTriggered ? current.latestParams : undefined;
      activeDeferredTurnMaintenanceRuns.delete(sessionKey);
      if (rerunParams) {
        scheduleDeferredTurnMaintenance(rerunParams);
      }
    });
  state = {
    promise: trackedPromise,
    rerunRequested: false,
    latestParams: { ...params, sessionKey },
  };
  activeDeferredTurnMaintenanceRuns.set(sessionKey, state);
  void trackedPromise;
}

/**
 * Run optional context-engine transcript maintenance and normalize the result.
 */
export async function runContextEngineMaintenance(params: {
  contextEngine?: ContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  reason: "bootstrap" | "compaction" | "turn";
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  runtimeContext?: ContextEngineRuntimeContext;
  executionMode?: "foreground" | "background";
  config?: SessionWriteLockAcquireTimeoutConfig;
}): Promise<ContextEngineMaintenanceResult | undefined> {
  if (typeof params.contextEngine?.maintain !== "function") {
    return undefined;
  }

  const executionMode = params.executionMode ?? "foreground";
  const shouldDefer =
    params.reason === "turn" &&
    executionMode !== "background" &&
    params.contextEngine.info.turnMaintenanceMode === "background";

  if (shouldDefer) {
    try {
      scheduleDeferredTurnMaintenance({
        contextEngine: params.contextEngine,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey ?? params.sessionId,
        sessionFile: params.sessionFile,
        sessionManager: params.sessionManager,
        runtimeContext: params.runtimeContext,
        config: params.config,
      });
    } catch (err) {
      log.warn(`failed to schedule deferred context engine maintenance: ${String(err)}`);
    }
    return undefined;
  }

  try {
    return await executeContextEngineMaintenance({
      contextEngine: params.contextEngine,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      reason: params.reason,
      sessionManager: params.sessionManager,
      runtimeContext: params.runtimeContext,
      executionMode,
      config: params.config,
    });
  } catch (err) {
    log.warn(`context engine maintain failed (${params.reason}): ${String(err)}`);
    return undefined;
  }
}
