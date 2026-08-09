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
import { createDeferred } from "../../shared/deferred.js";
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
import { DeferredContextEngineMaintenanceBlockedError } from "../context-engine-maintenance-error.js";
import { findActiveSessionTask } from "../session-async-task-status.js";
import { SessionManager } from "../sessions/index.js";
import { resolveContextEngineCapabilities } from "./context-engine-capabilities.js";
import {
  createDeferredTurnMaintenanceAbortSignal,
  DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY,
  type DeferredTurnMaintenanceProcessLike,
  unregisterDeferredTurnMaintenanceAbortSignalHandlers,
} from "./context-engine-maintenance-abort-signal.js";
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

const activeDeferredTurnMaintenanceRuns = new Map<string, DeferredTurnMaintenanceRun>();

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

function resetDeferredTurnMaintenanceStateForTest(): void {
  for (const run of activeDeferredTurnMaintenanceRuns.values()) {
    run.dispose();
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
  await activeRun.preemptForForeground();
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

function makeTurnMaintenanceTaskVisible(params: {
  sessionKey: string;
  runId: string;
  notifyPolicy: "done_only" | "state_changes";
}): void {
  buildTurnMaintenanceTaskDescriptor({
    ...params,
    deliveryStatus: "pending",
  });
}

class DeferredTurnMaintenancePreemptedError extends Error {
  constructor() {
    super("Deferred context-engine maintenance did not yield to a waiting foreground turn.");
    this.name = "DeferredTurnMaintenancePreemptedError";
  }
}

function isForegroundMaintenancePreemption(signal: AbortSignal): boolean {
  return signal.reason instanceof DeferredTurnMaintenancePreemptedError;
}

class DeferredTurnMaintenanceRun {
  private readonly completionDeferred = createDeferred();
  private readonly physicalSettlement = createDeferred();
  readonly completion = this.completionDeferred.promise;
  private readonly schedulerAbort = createDeferredTurnMaintenanceAbortSignal();
  private readonly writeFence = createDeferredMaintenanceWriteFence();
  private pendingRerun?: DeferredTurnMaintenanceScheduleParams;
  private preemption?: Promise<void>;
  private preemptionTimer?: ReturnType<typeof setTimeout>;
  private writeDrain: Promise<void> = Promise.resolve();

  constructor(
    private readonly params: DeferredTurnMaintenanceScheduleParams,
    private readonly sessionKey: string,
    private readonly lane: string,
    private readonly runId: string,
    private readonly taskId: string,
  ) {}

  coalesce(next: DeferredTurnMaintenanceScheduleParams): void {
    const superseded = this.pendingRerun;
    this.pendingRerun = { ...next, sessionKey: this.sessionKey };
    if (
      superseded?.disposeContextEngineAfterMaintenance &&
      superseded.contextEngine !== next.contextEngine
    ) {
      void disposeDeferredMaintenanceContextEngine(superseded.contextEngine);
    }
  }

  start(): boolean {
    let worker: Promise<void>;
    try {
      worker = enqueueCommandInLane(this.lane, () =>
        runDeferredTurnMaintenanceWorker({
          ...this.params,
          sessionKey: this.sessionKey,
          runId: this.runId,
          abortSignal: this.schedulerAbort.abortSignal,
          writeFence: this.writeFence,
        }),
      );
    } catch (error) {
      activeDeferredTurnMaintenanceRuns.delete(this.sessionKey);
      this.dispose();
      this.cancelFailedTask(error);
      this.physicalSettlement.resolve();
      this.completionDeferred.resolve();
      return false;
    }
    void this.track(worker);
    return true;
  }

  preemptForForeground(): Promise<void> {
    this.preemption ??= this.runForegroundPreemption();
    return this.preemption;
  }

  dispose(): void {
    if (this.preemptionTimer) {
      clearTimeout(this.preemptionTimer);
      this.preemptionTimer = undefined;
    }
    this.schedulerAbort.dispose();
  }

  private async runForegroundPreemption(): Promise<void> {
    const preemptionError = new DeferredTurnMaintenancePreemptedError();
    this.writeDrain = this.writeFence.close(preemptionError);
    this.schedulerAbort.abort(preemptionError);
    if (await this.settlesWithinPreemptionGrace()) {
      return;
    }

    const quarantined = quarantineResolvedContextEngine({
      contextEngine: this.params.contextEngine,
      operation: "maintain",
      error: preemptionError,
    });
    const blockedError = new DeferredContextEngineMaintenanceBlockedError({ quarantined });
    makeTurnMaintenanceTaskVisible({
      sessionKey: this.sessionKey,
      runId: this.runId,
      notifyPolicy: "state_changes",
    });
    const endedAt = Date.now();
    failTaskRunByRunId({
      runId: this.runId,
      runtime: "acp",
      sessionKey: this.sessionKey,
      status: "timed_out",
      endedAt,
      lastEventAt: endedAt,
      error: preemptionError.message,
      progressSummary: "Deferred maintenance did not yield to a waiting turn.",
      terminalSummary: blockedError.message,
    });
    throw blockedError;
  }

  private async settlesWithinPreemptionGrace(): Promise<boolean> {
    const timeout = createDeferred<boolean>();
    this.preemptionTimer = setTimeout(() => {
      this.preemptionTimer = undefined;
      timeout.resolve(false);
    }, TURN_MAINTENANCE_PREEMPT_GRACE_MS);
    this.preemptionTimer.unref?.();
    try {
      return await Promise.race([
        this.physicalSettlement.promise.then(() => true),
        timeout.promise,
      ]);
    } finally {
      if (this.preemptionTimer) {
        clearTimeout(this.preemptionTimer);
        this.preemptionTimer = undefined;
      }
    }
  }

  private async track(worker: Promise<void>): Promise<void> {
    try {
      await worker;
    } catch (error) {
      this.params.onScheduleFailure?.(error);
      this.cancelFailedTask(error);
    }

    try {
      // Do not await the initially settled drain: that yield would let a new
      // preemption install a real drain after we had already snapshotted it.
      if (this.preemption) {
        await this.writeDrain;
      }
      this.dispose();
      if (activeDeferredTurnMaintenanceRuns.get(this.sessionKey) !== this) {
        this.physicalSettlement.resolve();
        return;
      }

      activeDeferredTurnMaintenanceRuns.delete(this.sessionKey);
      this.physicalSettlement.resolve();
      const interrupted = this.schedulerAbort.abortSignal.aborted;
      const pendingRerun = this.pendingRerun;
      if (pendingRerun && !interrupted) {
        await scheduleDeferredTurnMaintenance(pendingRerun);
      } else if (pendingRerun?.disposeContextEngineAfterMaintenance) {
        await disposeDeferredMaintenanceContextEngine(pendingRerun.contextEngine);
      }
    } catch (error) {
      this.params.onScheduleFailure?.(error);
      log.warn(
        `failed to settle deferred context engine maintenance: ${formatErrorMessage(error)}`,
      );
    } finally {
      this.physicalSettlement.resolve();
      this.completionDeferred.resolve();
    }
  }

  private cancelFailedTask(error: unknown): void {
    const errorMessage = formatErrorMessage(error);
    log.warn(`failed to schedule deferred context engine maintenance: ${errorMessage}`);
    cancelTaskByIdForOwner({
      taskId: this.taskId,
      callerOwnerKey: this.sessionKey,
      endedAt: Date.now(),
      terminalSummary: `Deferred maintenance could not be scheduled: ${errorMessage}`,
    });
  }
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
    makeTurnMaintenanceTaskVisible({
      sessionKey: params.sessionKey,
      runId: params.runId,
      notifyPolicy,
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
      });
      if (task?.status === "queued" || task?.status === "running") {
        cancelTaskByIdForOwner({
          taskId: task.taskId,
          callerOwnerKey: params.sessionKey,
          endedAt: Date.now(),
          terminalSummary: isForegroundMaintenancePreemption(params.abortSignal)
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
    activeRun.coalesce({ ...params, sessionKey });
    return activeRun.completion;
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

  const run = new DeferredTurnMaintenanceRun(params, sessionKey, lane, task.runId!, task.taskId);
  // Registration precedes queue admission so a foreground waiter can never
  // miss a physical run that has already been handed to the lane.
  activeDeferredTurnMaintenanceRuns.set(sessionKey, run);
  if (!run.start()) {
    return undefined;
  }
  return run.completion;
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
