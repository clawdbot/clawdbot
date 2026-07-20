/**
 * Subagent registry coordinator.
 *
 * Owns registration, lifecycle, delivery retry, steering, orphan recovery, persistence, and cleanup for child runs.
 */
import { hasLiveOrRecentlyDispatchedContinuationWork } from "../auto-reply/continuation/work-store.js";
import type { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolveContextEngineOptions } from "../context-engine/registry.js";
import type { ContextEngine, SubagentEndReason } from "../context-engine/types.js";
import { callGateway } from "../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../gateway/server-instance-runtime.types.js";
import { getGatewayRecoveryRuntime } from "../gateway/server-recovery-runtime-context.js";
import { getAgentRunContext, onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isGatewayRestartDraining,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  formatAbandonedLivenessError,
  formatBlockedLivenessError,
  isAbandonedLivenessState,
  isBlockedLivenessState,
} from "../shared/agent-liveness.js";
import { createLazyImportLoader, createLazyPromiseLoader } from "../shared/lazy-promise.js";
import { importRuntimeModule } from "../shared/runtime-import.js";
import { SUBAGENT_KILL_TASK_ERROR } from "../tasks/detached-task-runtime-contract.js";
import { finalizeTaskRunByRunId, findDetachedTaskRun } from "../tasks/detached-task-runtime.js";
import { isProvisionalSubagentKillTask } from "../tasks/task-cancellation-state.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import type { AcceptedSessionSpawn } from "./accepted-session-spawn.js";
import {
  ackLeasedAgentSteeringItemsFromSubagentRuns,
  leasePendingAgentSteeringItemsFromSubagentRuns,
  prependAgentSteeringPrompt,
  releaseLeasedAgentSteeringItemsFromSubagentRuns,
} from "./agent-steering-queue.js";
import { removeInternalSessionEffectsSession } from "./internal-session-effects.js";
import type { AgentRunSessionTarget } from "./run-session-target.js";
import { isAbortedAgentStopReason } from "./run-termination.js";
import type { ensureRuntimePluginsLoaded as ensureRuntimePluginsLoadedFn } from "./runtime-plugins.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import {
  ensureCompletionState,
  ensureDeliveryState,
  getDeliveryAttemptCount,
  getDeliveryLastAttemptAt,
  getDeliveryLastError,
  isDeliverySuspended,
} from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_OUTCOME_KILLED,
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  emitSubagentEndedHookOnce,
  emitSubagentProgressEndedHook,
  resolveLifecycleOutcomeFromRunOutcome,
} from "./subagent-registry-completion.js";
import {
  ANNOUNCE_EXPIRY_MS,
  MAX_ANNOUNCE_RETRY_COUNT,
  PROVISIONAL_KILL_RECONCILIATION_MS,
  reconcileOrphanedRestoredRuns,
  reconcileOrphanedRun,
  resolveAnnounceRetryDelayMs,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  countActiveDescendantRunsFromRuns,
  countActiveRunsForSessionFromRuns,
  countPendingDescendantRunsFromRuns,
  getSubagentRunByChildSessionKeyFromRuns,
  listRunsForControllerFromRuns,
  listDescendantRunsForRequesterFromRuns,
} from "./subagent-registry-queries.js";
import { markRequesterTurnYieldedInRuns } from "./subagent-registry-requester-yield.js";
import {
  createSubagentRunManager,
  markSubagentRunPausedAfterYield,
  type RegisterSubagentRunParams,
} from "./subagent-registry-run-manager.js";
import { configureSubagentRegistrySpawnRuntime } from "./subagent-registry-spawn-runtime.js";
import {
  clearSubagentRunsReadCacheForTest,
  getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import { configureSubagentRegistrySteerRuntime } from "./subagent-registry-steer-runtime.js";
import type { SubagentRunRecord, SwarmStructuredOutputState } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";
import {
  resolveSubagentRunDeadlineMs,
  resolveSubagentRunEffectiveEndedAt,
} from "./subagent-run-timeout.js";
import {
  loadSubagentSessionEntry,
  resolveCompletionFromSessionEntry,
  resolveSubagentRunOrphanReason,
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
  type SubagentSessionStoreCache,
} from "./subagent-session-reconciliation.js";
import { resolveSwarmConfig } from "./swarm-config.js";
import { enqueueSwarmRun } from "./swarm-scheduler.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

export type { SubagentRunRecord } from "./subagent-registry.types.js";
const log = createSubsystemLogger("agents/subagent-registry");

function readGatewayRunId(response: unknown): string | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const runId = (response as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.trim() ? runId.trim() : undefined;
}

type SubagentAnnounceModule = Pick<
  typeof import("./subagent-announce.js"),
  "captureSubagentCompletionReply" | "runSubagentAnnounceFlow"
>;
type RequesterSettleWakeModule = Pick<
  typeof import("./subagent-announce.requester-settle-wake.js"),
  "maybeWakeRequesterAfterAllChildrenSettled"
>;
type BrowserCleanupModule = Pick<
  typeof import("../browser-lifecycle-cleanup.js"),
  "cleanupBrowserSessionsForLifecycleEnd"
>;

type SubagentRegistryDeps = {
  callGateway: typeof callGateway;
  getGatewayRecoveryRuntime: () => GatewayRecoveryRuntime | undefined;
  captureSubagentCompletionReply: SubagentAnnounceModule["captureSubagentCompletionReply"];
  cleanupBrowserSessionsForLifecycleEnd: typeof cleanupBrowserSessionsForLifecycleEnd;
  getSubagentRunsSnapshotForRead: typeof getSubagentRunsSnapshotForRead;
  getRuntimeConfig: typeof getRuntimeConfig;
  onAgentEvent: typeof onAgentEvent;
  persistSubagentRunsToDisk: typeof persistSubagentRunsToDisk;
  persistSubagentRunsToDiskOrThrow: typeof persistSubagentRunsToDiskOrThrow;
  resolveAgentTimeoutMs: typeof resolveAgentTimeoutMs;
  restoreSubagentRunsFromDisk: typeof restoreSubagentRunsFromDisk;
  runSubagentAnnounceFlow: SubagentAnnounceModule["runSubagentAnnounceFlow"];
  maybeWakeRequesterAfterAllChildrenSettled: RequesterSettleWakeModule["maybeWakeRequesterAfterAllChildrenSettled"];
  ensureContextEnginesInitialized?: () => void;
  ensureRuntimePluginsLoaded?: (
    params: Parameters<typeof ensureRuntimePluginsLoadedFn>[0],
  ) => void | Promise<void>;
  resolveContextEngine?: (
    cfg?: OpenClawConfig,
    options?: ResolveContextEngineOptions,
  ) => Promise<ContextEngine>;
};

const subagentAnnounceLoader = createLazyImportLoader<SubagentAnnounceModule>(
  () => import("./subagent-announce.js"),
);
const browserCleanupLoader = createLazyImportLoader<BrowserCleanupModule>(
  () => import("../browser-lifecycle-cleanup.js"),
);

async function loadSubagentAnnounceModule(): Promise<SubagentAnnounceModule> {
  return await subagentAnnounceLoader.load();
}

async function loadCleanupBrowserSessionsForLifecycleEnd(): Promise<
  BrowserCleanupModule["cleanupBrowserSessionsForLifecycleEnd"]
> {
  return (await browserCleanupLoader.load()).cleanupBrowserSessionsForLifecycleEnd;
}

const defaultSubagentRegistryDeps: SubagentRegistryDeps = {
  callGateway,
  getGatewayRecoveryRuntime,
  captureSubagentCompletionReply: async (sessionKey, options) =>
    (await loadSubagentAnnounceModule()).captureSubagentCompletionReply(sessionKey, options),
  cleanupBrowserSessionsForLifecycleEnd: async (params) =>
    (await loadCleanupBrowserSessionsForLifecycleEnd())(params),
  getSubagentRunsSnapshotForRead,
  getRuntimeConfig,
  onAgentEvent,
  persistSubagentRunsToDisk,
  persistSubagentRunsToDiskOrThrow,
  resolveAgentTimeoutMs,
  restoreSubagentRunsFromDisk,
  runSubagentAnnounceFlow: async (params) =>
    (await loadSubagentAnnounceModule()).runSubagentAnnounceFlow(params),
  maybeWakeRequesterAfterAllChildrenSettled: async (params) =>
    (
      await import("./subagent-announce.requester-settle-wake.js")
    ).maybeWakeRequesterAfterAllChildrenSettled(params),
};

let subagentRegistryDeps: SubagentRegistryDeps = defaultSubagentRegistryDeps;
type ContextEngineInitModule = Pick<
  {
    ensureContextEnginesInitialized: () => void;
  },
  "ensureContextEnginesInitialized"
>;
type ContextEngineRegistryModule = Pick<
  {
    resolveContextEngine: (
      cfg?: OpenClawConfig,
      options?: ResolveContextEngineOptions,
    ) => Promise<ContextEngine>;
  },
  "resolveContextEngine"
>;
type RuntimePluginsModule = Pick<
  {
    ensureRuntimePluginsLoaded: typeof ensureRuntimePluginsLoadedFn;
  },
  "ensureRuntimePluginsLoaded"
>;

const SUBAGENT_REGISTRY_RUNTIME_SPEC = ["./subagent-registry.runtime", ".js"] as const;

const contextEngineInitLoader = createLazyPromiseLoader(() =>
  importRuntimeModule<ContextEngineInitModule>(import.meta.url, SUBAGENT_REGISTRY_RUNTIME_SPEC),
);
const contextEngineRegistryLoader = createLazyPromiseLoader(() =>
  importRuntimeModule<ContextEngineRegistryModule>(import.meta.url, SUBAGENT_REGISTRY_RUNTIME_SPEC),
);
const runtimePluginsLoader = createLazyPromiseLoader(() =>
  importRuntimeModule<RuntimePluginsModule>(import.meta.url, SUBAGENT_REGISTRY_RUNTIME_SPEC),
);

let sweeper: NodeJS.Timeout | null = null;
const resumeRetryTimers = new Set<ReturnType<typeof setTimeout>>();
let sweepInProgress = false;
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
// Use var to avoid TDZ when init runs across circular imports during bootstrap.
let restoreAttempted = false;
const ORPHAN_RECOVERY_DEBOUNCE_MS = 1_000;
let lastOrphanRecoveryScheduleAt = 0;
const SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
const GATEWAY_ADMISSION_RETRY_DELAY_MS = 1_000;
/**
 * Embedded runs can emit transient lifecycle `error` events while provider/model
 * retry is still in progress. Defer terminal error cleanup briefly so a
 * subsequent lifecycle `start` / `end` can cancel premature failure announces.
 */
const LIFECYCLE_ERROR_RETRY_GRACE_MS = 15_000;
/**
 * Embedded runs can also surface an intermediate lifecycle `end` with
 * `aborted=true` just before the runtime automatically retries the same run.
 * Give that timeout a short grace window so the parent does not get a stale
 * `timed out` completion right before the eventual success.
 */
const LIFECYCLE_TIMEOUT_RETRY_GRACE_MS = 15_000;
/** Absolute TTL for session-mode runs after cleanup completes (no archiveAtMs). */
const SESSION_RUN_TTL_MS = 5 * 60_000; // 5 minutes
/** Absolute TTL for orphaned pendingLifecycleError / pendingLifecycleTimeout entries. */
const PENDING_LIFECYCLE_TERMINAL_TTL_MS = 5 * 60_000; // 5 minutes
/** Grace period before treating a "running" subagent without a live run context as stale. */
const STALE_ACTIVE_SUBAGENT_GRACE_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 1_000 : 60_000;
const SUSPENDED_DELIVERY_CRON_EXPIRY_MS = 2 * 60 * 60_000;
const SUSPENDED_DELIVERY_SUBAGENT_EXPIRY_MS = 6 * 60 * 60_000;
const SUSPENDED_DELIVERY_INTERACTIVE_EXPIRY_MS = 24 * 60 * 60_000;
const SUSPENDED_DELIVERY_SOFT_CAP = 25;
const SUSPENDED_DELIVERY_HARD_CAP = 50;
const SUSPENDED_DELIVERY_PRESSURE_TARGET = 10;

function loadContextEngineInitModule(): Promise<ContextEngineInitModule> {
  return contextEngineInitLoader.load();
}

function loadContextEngineRegistryModule(): Promise<ContextEngineRegistryModule> {
  return contextEngineRegistryLoader.load();
}

function loadRuntimePluginsModule(): Promise<RuntimePluginsModule> {
  return runtimePluginsLoader.load();
}

async function ensureSubagentRegistryPluginRuntimeLoaded(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  allowGatewaySubagentBinding?: boolean;
}) {
  const ensureRuntimePluginsLoaded = subagentRegistryDeps.ensureRuntimePluginsLoaded;
  if (ensureRuntimePluginsLoaded) {
    await ensureRuntimePluginsLoaded(params);
    return;
  }
  (await loadRuntimePluginsModule()).ensureRuntimePluginsLoaded(params);
}

async function resolveSubagentRegistryContextEngine(
  cfg: OpenClawConfig,
  options?: ResolveContextEngineOptions,
) {
  const initModule = await loadContextEngineInitModule();
  const registryModule = await loadContextEngineRegistryModule();
  const ensureContextEnginesInitialized =
    subagentRegistryDeps.ensureContextEnginesInitialized ??
    initModule.ensureContextEnginesInitialized;
  const resolveContextEngine =
    subagentRegistryDeps.resolveContextEngine ?? registryModule.resolveContextEngine;
  ensureContextEnginesInitialized();
  return await resolveContextEngine(cfg, options);
}

function persistSubagentRuns() {
  subagentRegistryDeps.persistSubagentRunsToDisk(subagentRuns);
}

function persistSubagentRunsOrThrow() {
  subagentRegistryDeps.persistSubagentRunsToDiskOrThrow(subagentRuns);
}

function findSubagentTaskForRun(entry: SubagentRunRecord) {
  const nextRunCreatedAt = findNextSubagentRunCreatedAt(entry);
  const generationStartedAt = entry.sessionStartedAt ?? entry.createdAt;
  return findDetachedTaskRun({
    runId: entry.taskRunId ?? entry.runId,
    runtime: "subagent",
    sessionKey: entry.childSessionKey,
    createdAtOrAfter: generationStartedAt,
    createdBefore: nextRunCreatedAt,
    // Steer/wake replaces the registry run ID while retaining the original
    // task row. Only those continuations may adopt a session-scoped task.
    allowSessionFallback:
      entry.taskRunId === undefined &&
      typeof entry.sessionStartedAt === "number" &&
      entry.sessionStartedAt < entry.createdAt,
  });
}

function findNextSubagentRunCreatedAt(entry: SubagentRunRecord): number | undefined {
  let nextCreatedAt = entry.killReconciliation?.supersededAt;
  for (const candidate of subagentRuns.values()) {
    if (
      candidate.runId === entry.runId ||
      candidate.childSessionKey !== entry.childSessionKey ||
      compareSubagentRunGeneration(candidate, entry) <= 0
    ) {
      continue;
    }
    nextCreatedAt = Math.min(nextCreatedAt ?? candidate.createdAt, candidate.createdAt);
  }
  return nextCreatedAt;
}

function resolveCompletionFromTerminalTask(
  task: TaskRecord | undefined,
  entry: SubagentRunRecord,
):
  | {
      startedAt?: number;
      endedAt: number;
      outcome: SubagentRunOutcome;
      reason: SubagentLifecycleEndedReason;
      completionSnapshot: { resultText: string | null; capturedAt: number };
    }
  | undefined {
  if (
    !task ||
    typeof task.endedAt !== "number" ||
    (task.status !== "succeeded" && task.status !== "failed" && task.status !== "timed_out")
  ) {
    return undefined;
  }
  const outcome: SubagentRunOutcome =
    task.status === "succeeded"
      ? { status: "ok" }
      : task.status === "timed_out"
        ? { status: "timeout" }
        : { status: "error", error: task.error };
  return {
    // A steer continuation keeps the original task row but owns a new timeout
    // window. Replay against the current registry generation, not task history.
    startedAt: entry.startedAt ?? task.startedAt,
    endedAt: task.endedAt,
    outcome,
    reason: task.status === "failed" ? SUBAGENT_ENDED_REASON_ERROR : SUBAGENT_ENDED_REASON_COMPLETE,
    completionSnapshot: {
      resultText: task.progressSummary ?? task.terminalSummary ?? null,
      capturedAt: task.endedAt,
    },
  };
}

export function scheduleSubagentOrphanRecovery(params?: { delayMs?: number; maxRetries?: number }) {
  const gatewayRuntime = subagentRegistryDeps.getGatewayRecoveryRuntime();
  if (!gatewayRuntime) {
    log.warn("subagent orphan recovery deferred until the Gateway instance runtime is available");
    return;
  }
  const now = Date.now();
  if (now - lastOrphanRecoveryScheduleAt < ORPHAN_RECOVERY_DEBOUNCE_MS) {
    return;
  }
  lastOrphanRecoveryScheduleAt = now;
  void import("./subagent-orphan-recovery.js").then(
    ({ scheduleOrphanRecovery }) => {
      // This import only installs timers. Each delayed or retrying recovery
      // attempt owns independent root admission inside the recovery module.
      scheduleOrphanRecovery({
        // Retries follow the process's current lifecycle-bound Gateway
        // principal instead of retaining the instance that scheduled them.
        getGatewayRuntime: subagentRegistryDeps.getGatewayRecoveryRuntime,
        getActiveRuns: () => subagentRuns,
        delayMs: params?.delayMs,
        maxRetries: params?.maxRetries,
      });
    },
    () => {
      // Ignore import failures — orphan recovery is best-effort.
    },
  );
}

const resumedRuns = new Set<string>();
const endedHookInFlightRunIds = new Set<string>();
const pendingLifecycleErrorByRunId = new Map<
  string,
  {
    timer: NodeJS.Timeout;
    endedAt: number;
    startedAt?: number;
    error?: string;
  }
>();
const pendingLifecycleTimeoutByRunId = new Map<
  string,
  {
    timer: NodeJS.Timeout;
    endedAt: number;
    startedAt?: number;
  }
>();

function clearPendingLifecycleError(runId: string) {
  const pending = pendingLifecycleErrorByRunId.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingLifecycleErrorByRunId.delete(runId);
}

function clearAllPendingLifecycleErrors() {
  for (const pending of pendingLifecycleErrorByRunId.values()) {
    clearTimeout(pending.timer);
  }
  pendingLifecycleErrorByRunId.clear();
}

function clearPendingLifecycleTimeout(runId: string) {
  const pending = pendingLifecycleTimeoutByRunId.get(runId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingLifecycleTimeoutByRunId.delete(runId);
}

function clearAllPendingLifecycleTimeouts() {
  for (const pending of pendingLifecycleTimeoutByRunId.values()) {
    clearTimeout(pending.timer);
  }
  pendingLifecycleTimeoutByRunId.clear();
}

type CompleteSubagentRunParams = {
  runId: string;
  endedAt?: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
  triggerCleanup: boolean;
  startedAt?: number;
  suppressSessionEffects?: boolean;
  recoverInterrupted?: true;
};

async function completeSubagentRunWithRecoveryAttempt(
  params: CompleteSubagentRunParams,
  source: string,
) {
  try {
    await completeSubagentRun(params);
    return;
  } catch (error) {
    const current = subagentRuns.get(params.runId);
    log.warn("failed to complete subagent run; retrying completion", {
      source,
      runId: params.runId,
      childSessionKey: current?.childSessionKey,
      error,
    });
  }

  const current = subagentRuns.get(params.runId);
  if (!current) {
    return;
  }

  try {
    await completeSubagentRun(params);
    return;
  } catch (retryError) {
    log.warn("failed to complete subagent run after retry; retrying ended cleanup", {
      source,
      runId: params.runId,
      childSessionKey: current.childSessionKey,
      error: retryError,
    });
  }

  const latest = subagentRuns.get(params.runId);
  if (latest && typeof latest.endedAt !== "number") {
    // The durable write rolled the in-memory entry back. Preserve the original
    // completion through the normal persisted-session recovery path.
    scheduleSubagentOrphanRecovery({ delayMs: 1_000 });
    return;
  }
  if (
    !latest ||
    typeof latest.endedAt !== "number" ||
    typeof latest.cleanupCompletedAt === "number" ||
    latest.pauseReason === "sessions_yield"
  ) {
    return;
  }
  latest.cleanupHandled = false;
  resumedRuns.delete(params.runId);
  resumeSubagentRun(params.runId);
}

function scheduleSubagentCompletionRetryAfterRestart(
  params: CompleteSubagentRunParams,
  source: string,
  expectedEntry: SubagentRunRecord,
) {
  const expectedGeneration = expectedEntry.generation;
  const timer = setTimeout(() => {
    resumeRetryTimers.delete(timer);
    const current = subagentRuns.get(params.runId);
    if (current !== expectedEntry || current.generation !== expectedGeneration) {
      return;
    }
    void completeSubagentRunWithRecovery(params, source).catch((error: unknown) => {
      log.warn("failed to retry subagent completion after gateway restart", {
        source,
        runId: params.runId,
        error,
      });
    });
  }, GATEWAY_ADMISSION_RETRY_DELAY_MS);
  timer.unref?.();
  resumeRetryTimers.add(timer);
}

async function completeSubagentRunWithRecovery(params: CompleteSubagentRunParams, source: string) {
  // Each controller attempt owns its terminal transition, while this outer
  // lease closes the gap between failed attempts and fallback cleanup.
  try {
    await runWithGatewayIndependentRootWorkAdmission(async () => {
      await completeSubagentRunWithRecoveryAttempt(params, source);
    });
  } catch (error) {
    if (!isGatewayRestartDraining()) {
      throw error;
    }
    log.warn("subagent completion deferred during gateway restart", {
      source,
      runId: params.runId,
    });
    const current = subagentRuns.get(params.runId);
    if (current) {
      scheduleSubagentCompletionRetryAfterRestart(params, source, current);
    }
  }
}

function completeSubagentRunInBackground(params: CompleteSubagentRunParams, source: string) {
  void completeSubagentRunWithRecovery(params, source);
}

function schedulePendingLifecycleError(params: {
  runId: string;
  endedAt: number;
  startedAt?: number;
  error?: string;
}) {
  clearPendingLifecycleTimeout(params.runId);
  clearPendingLifecycleError(params.runId);
  const timer = setTimeout(() => {
    const pending = pendingLifecycleErrorByRunId.get(params.runId);
    if (!pending || pending.timer !== timer) {
      return;
    }
    pendingLifecycleErrorByRunId.delete(params.runId);
    const entry = subagentRuns.get(params.runId);
    if (!entry) {
      return;
    }
    if (entry.endedReason === SUBAGENT_ENDED_REASON_COMPLETE || entry.outcome?.status === "ok") {
      return;
    }
    const completionParams = {
      runId: params.runId,
      endedAt: pending.endedAt,
      outcome: {
        status: "error" as const,
        error: pending.error,
      },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
      startedAt: pending.startedAt,
    };
    completeSubagentRunInBackground(completionParams, "lifecycle-error-grace");
  }, LIFECYCLE_ERROR_RETRY_GRACE_MS);
  timer.unref?.();
  pendingLifecycleErrorByRunId.set(params.runId, {
    timer,
    endedAt: params.endedAt,
    startedAt: params.startedAt,
    error: params.error,
  });
}

function schedulePendingLifecycleTimeout(params: {
  runId: string;
  endedAt: number;
  startedAt?: number;
}) {
  clearPendingLifecycleError(params.runId);
  clearPendingLifecycleTimeout(params.runId);
  const timer = setTimeout(() => {
    const pending = pendingLifecycleTimeoutByRunId.get(params.runId);
    if (!pending || pending.timer !== timer) {
      return;
    }
    pendingLifecycleTimeoutByRunId.delete(params.runId);
    const entry = subagentRuns.get(params.runId);
    if (!entry) {
      return;
    }
    if (entry.outcome?.status === "ok" || entry.pauseReason === "sessions_yield") {
      return;
    }
    const completionParams = {
      runId: params.runId,
      endedAt: pending.endedAt,
      outcome: {
        status: "timeout" as const,
      },
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
      startedAt: pending.startedAt,
    };
    completeSubagentRunInBackground(completionParams, "lifecycle-timeout-grace");
  }, LIFECYCLE_TIMEOUT_RETRY_GRACE_MS);
  timer.unref?.();
  pendingLifecycleTimeoutByRunId.set(params.runId, {
    timer,
    endedAt: params.endedAt,
    startedAt: params.startedAt,
  });
}

type ContextEngineSubagentEndedParams = {
  childSessionKey: string;
  reason: SubagentEndReason;
  agentDir?: string;
  workspaceDir?: string;
};

async function runContextEngineSubagentEnded(
  params: ContextEngineSubagentEndedParams,
): Promise<void> {
  const cfg = subagentRegistryDeps.getRuntimeConfig();
  await ensureSubagentRegistryPluginRuntimeLoaded({
    config: cfg,
    workspaceDir: params.workspaceDir,
    allowGatewaySubagentBinding: true,
  });
  const engine = await resolveSubagentRegistryContextEngine(cfg, {
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
  });
  await engine.onSubagentEnded?.(params);
}

async function notifyContextEngineSubagentEnded(
  params: ContextEngineSubagentEndedParams,
): Promise<void> {
  try {
    await runContextEngineSubagentEnded(params);
  } catch (err) {
    log.warn("context-engine onSubagentEnded failed (best-effort)", { err });
  }
}

async function finishCollectorContextEngineCleanup(
  params: ContextEngineSubagentEndedParams,
): Promise<boolean> {
  try {
    await runContextEngineSubagentEnded(params);
    return true;
  } catch (err) {
    log.warn("context-engine collector cleanup failed", { err });
    return false;
  }
}

async function cleanupCollectorLaunchResources(entry: SubagentRunRecord): Promise<boolean> {
  let internalEffectsRemoved = true;
  try {
    await removeInternalSessionEffectsSession(entry.execution?.transcriptTarget);
  } catch (err) {
    internalEffectsRemoved = false;
    log.warn("failed to remove collector internal session effects", {
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
      err,
    });
  }
  const contextAlreadyEnded = typeof entry.contextEngineCleanupCompletedAt === "number";
  const [attachmentsRemoved, contextEnded] = await Promise.all([
    safeRemoveAttachmentsDir(entry),
    contextAlreadyEnded
      ? true
      : finishCollectorContextEngineCleanup({
          childSessionKey: entry.childSessionKey,
          reason: "deleted",
          agentDir: entry.agentDir,
          workspaceDir: entry.workspaceDir,
        }),
  ]);
  if (!contextAlreadyEnded && contextEnded) {
    entry.contextEngineCleanupCompletedAt = Date.now();
    persistSubagentRuns();
  }
  return internalEffectsRemoved && attachmentsRemoved && contextEnded;
}

async function terminateAcceptedRestoredCollectorRun(params: {
  entry: SubagentRunRecord;
  gatewayRunId: string;
  timeoutMs: number;
}): Promise<void> {
  // A restored FIFO slot cannot be released until the accepted Gateway run is
  // definitely stopped; otherwise the group can exceed maxConcurrent.
  for (;;) {
    try {
      await subagentRegistryDeps.callGateway({
        method: "chat.abort",
        params: { sessionKey: params.entry.childSessionKey, runId: params.gatewayRunId },
        timeoutMs: params.timeoutMs,
      });
      return;
    } catch {
      try {
        await subagentRegistryDeps.callGateway({
          method: "sessions.delete",
          params: {
            key: params.entry.childSessionKey,
            deleteTranscript: true,
            emitLifecycleHooks: false,
          },
          timeoutMs: params.timeoutMs,
        });
        return;
      } catch {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, process.env.OPENCLAW_TEST_FAST === "1" ? 1 : 1_000);
          timer.unref?.();
        });
      }
    }
  }
}

function suppressAnnounceForSteerRestart(entry?: SubagentRunRecord) {
  return entry?.suppressAnnounceReason === "steer-restart";
}

function shouldKeepThreadBindingAfterRun(params: {
  entry: SubagentRunRecord;
  reason: SubagentLifecycleEndedReason;
}) {
  if (params.reason === SUBAGENT_ENDED_REASON_KILLED) {
    return false;
  }
  return params.entry.spawnMode === "session";
}

function shouldEmitEndedHookForRun(params: {
  entry: SubagentRunRecord;
  reason: SubagentLifecycleEndedReason;
}) {
  return !shouldKeepThreadBindingAfterRun(params);
}

async function emitSubagentEndedHookForRun(params: {
  entry: SubagentRunRecord;
  reason?: SubagentLifecycleEndedReason;
  sendFarewell?: boolean;
  accountId?: string;
  isCurrent?: () => boolean;
}) {
  if (params.entry.endedHookEmittedAt) {
    return;
  }
  const cfg = subagentRegistryDeps.getRuntimeConfig();
  await ensureSubagentRegistryPluginRuntimeLoaded({
    config: cfg,
    workspaceDir: params.entry.workspaceDir,
    allowGatewaySubagentBinding: true,
  });
  if (params.entry.endedHookEmittedAt || params.isCurrent?.() === false) {
    return;
  }
  // Plugin loading yields after the terminal lock is released. Resolve the
  // event from the canonical row only after that boundary so an older callback
  // cannot claim the exactly-once hook with a superseded timeout or error.
  const reason = params.entry.endedReason ?? params.reason ?? SUBAGENT_ENDED_REASON_COMPLETE;
  const outcome =
    reason === SUBAGENT_ENDED_REASON_KILLED
      ? SUBAGENT_ENDED_OUTCOME_KILLED
      : resolveLifecycleOutcomeFromRunOutcome(params.entry.outcome);
  const error = params.entry.outcome?.status === "error" ? params.entry.outcome.error : undefined;
  await emitSubagentEndedHookOnce({
    entry: params.entry,
    reason,
    sendFarewell: params.sendFarewell,
    accountId: params.accountId ?? params.entry.requesterOrigin?.accountId,
    outcome,
    error,
    inFlightRunIds: endedHookInFlightRunIds,
    persist: persistSubagentRuns,
  });
}

const subagentLifecycleController = createSubagentRegistryLifecycleController({
  runs: subagentRuns,
  resumedRuns,
  subagentAnnounceTimeoutMs: SUBAGENT_ANNOUNCE_TIMEOUT_MS,
  persist: persistSubagentRuns,
  persistOrThrow: persistSubagentRunsOrThrow,
  clearPendingLifecycleError,
  countPendingDescendantRuns,
  suppressAnnounceForSteerRestart,
  resolveSubagentTask: findSubagentTaskForRun,
  shouldEmitEndedHookForRun,
  emitSubagentEndedHookForRun,
  emitSubagentProgressEndedForRun: emitSubagentProgressEndedHook,
  notifyContextEngineSubagentEnded,
  retireSupersededRun: retireSupersededSubagentRun,
  resumeSubagentRun,
  callGateway: (request) => subagentRegistryDeps.callGateway(request),
  captureSubagentCompletionReply: (sessionKey, options) =>
    subagentRegistryDeps.captureSubagentCompletionReply(sessionKey, options),
  cleanupBrowserSessionsForLifecycleEnd: (args) =>
    subagentRegistryDeps.cleanupBrowserSessionsForLifecycleEnd(args),
  runSubagentAnnounceFlow: (params) => subagentRegistryDeps.runSubagentAnnounceFlow(params),
  maybeWakeRequesterAfterAllChildrenSettled: (args) =>
    subagentRegistryDeps.maybeWakeRequesterAfterAllChildrenSettled(args),
  warn: (message, meta) => log.warn(message, meta),
});

const {
  clearScheduledResumeTimers,
  completeCleanupBookkeeping,
  completeSubagentRun,
  finalizeResumedAnnounceGiveUp,
  refreshFrozenResultFromSession,
  resumeRequesterSettleWake,
  settleRequesterTurnAfterSessionSpawns,
  startSubagentAnnounceCleanupFlow,
} = subagentLifecycleController;

function scheduleSubagentDeliveryResumeRetry(
  runId: string,
  scheduledEntry: SubagentRunRecord,
  waitMs: number,
) {
  const timer = setTimeout(() => {
    resumeRetryTimers.delete(timer);
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      if (subagentRuns.get(runId) !== scheduledEntry) {
        resumedRuns.delete(runId);
        return;
      }
      resumedRuns.delete(runId);
      resumeSubagentRun(runId);
    }).catch((error: unknown) => {
      log.warn("failed to resume subagent delivery retry", { runId, error });
      if (
        isGatewayRestartDraining() &&
        subagentRuns.get(runId) === scheduledEntry &&
        typeof scheduledEntry.cleanupCompletedAt !== "number"
      ) {
        scheduleSubagentDeliveryResumeRetry(
          runId,
          scheduledEntry,
          Math.max(waitMs, GATEWAY_ADMISSION_RETRY_DELAY_MS),
        );
        return;
      }
      resumedRuns.delete(runId);
    });
  }, waitMs);
  timer.unref?.();
  resumeRetryTimers.add(timer);
}

function finalizeResumedAnnounceGiveUpInBackground(
  runId: string,
  entry: SubagentRunRecord,
  reason: "retry-limit" | "expiry",
) {
  void runWithGatewayIndependentRootWorkAdmission(async () => {
    await finalizeResumedAnnounceGiveUp({ runId, entry, reason });
  }).catch((error: unknown) => {
    log.warn("failed to finalize exhausted subagent delivery", { runId, reason, error });
    if (
      isGatewayRestartDraining() &&
      subagentRuns.get(runId) === entry &&
      typeof entry.cleanupCompletedAt !== "number"
    ) {
      scheduleSubagentDeliveryResumeRetry(runId, entry, GATEWAY_ADMISSION_RETRY_DELAY_MS);
      resumedRuns.add(runId);
    }
  });
}

function resumeSubagentRun(runId: string) {
  if (!runId || resumedRuns.has(runId)) {
    return;
  }
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return;
  }
  if (entry.terminalOwner === "interrupted-recovery") {
    // Startup orphan recovery replays this durable exact-run winner before it
    // reads session/config state. Do not prune or resume it through announce.
    resumedRuns.add(runId);
    return;
  }
  const yieldedWakeWaitingForDelivery =
    entry.requesterSettleWake?.requesterYieldBatch === true &&
    (entry.delivery?.status === "pending" ||
      entry.delivery?.status === "in_progress" ||
      entry.delivery?.status === "failed");
  if (
    entry.requesterSettleWake &&
    typeof entry.endedAt === "number" &&
    !yieldedWakeWaitingForDelivery
  ) {
    resumeRequesterSettleWake(runId, entry);
    return;
  }
  if (entry.cleanupCompletedAt) {
    return;
  }
  if (typeof entry.endedAt === "number" && isDeliverySuspended(entry)) {
    return;
  }
  // Yielded runs stay paused until explicitly steered, except orchestrators
  // waiting on descendants: their settle retry must reach the wake path.
  if (entry.pauseReason === "sessions_yield" && entry.wakeOnDescendantSettle !== true) {
    return;
  }
  // Skip entries that have exhausted their retry budget or expired (#18264).
  if (getDeliveryAttemptCount(entry) >= MAX_ANNOUNCE_RETRY_COUNT) {
    finalizeResumedAnnounceGiveUpInBackground(runId, entry, "retry-limit");
    return;
  }
  if (
    entry.expectsCompletionMessage !== true &&
    typeof entry.endedAt === "number" &&
    Date.now() - entry.endedAt > ANNOUNCE_EXPIRY_MS
  ) {
    finalizeResumedAnnounceGiveUpInBackground(runId, entry, "expiry");
    return;
  }

  const now = Date.now();
  const lastAttemptAt = getDeliveryLastAttemptAt(entry);
  const delayMs = resolveAnnounceRetryDelayMs(getDeliveryAttemptCount(entry));
  const earliestRetryAt = (lastAttemptAt ?? 0) + delayMs;
  if (entry.expectsCompletionMessage === true && lastAttemptAt && now < earliestRetryAt) {
    const waitMs = Math.max(1, earliestRetryAt - now);
    scheduleSubagentDeliveryResumeRetry(runId, entry, waitMs);
    resumedRuns.add(runId);
    return;
  }

  if (typeof entry.endedAt === "number" && entry.endedAt > 0) {
    if (entry.killReconciliation) {
      // Restored kills remain reconciliation tombstones; only the sweeper may
      // accept late provider completion or stabilize their task cancellation.
      resumedRuns.add(runId);
      return;
    }
    const orphanReason = resolveSubagentRunOrphanReason({ entry });
    if (orphanReason) {
      if (
        reconcileOrphanedRun({
          runId,
          entry,
          reason: orphanReason,
          source: "resume",
          runs: subagentRuns,
          resumedRuns,
        })
      ) {
        persistSubagentRuns();
      }
      return;
    }
    if (suppressAnnounceForSteerRestart(entry)) {
      resumedRuns.add(runId);
      return;
    }
    if (!startSubagentAnnounceCleanupFlow(runId, entry)) {
      return;
    }
    resumedRuns.add(runId);
    return;
  }

  // Wait for completion again after restart.
  const cfg = subagentRegistryDeps.getRuntimeConfig();
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, entry.runTimeoutSeconds);
  void subagentRunManager.waitForSubagentCompletion(runId, waitTimeoutMs, entry, true);
  resumedRuns.add(runId);
}

function restoreSubagentRunsOnce() {
  if (restoreAttempted) {
    return;
  }
  restoreAttempted = true;
  try {
    const restoredCount = subagentRegistryDeps.restoreSubagentRunsFromDisk({
      runs: subagentRuns,
      mergeOnly: true,
    });
    if (restoredCount === 0) {
      return;
    }
    if (
      reconcileOrphanedRestoredRuns({
        runs: subagentRuns,
        resumedRuns,
      })
    ) {
      persistSubagentRuns();
    }
    const requesterTurns = new Map<string, Map<string, SubagentRunRecord[]>>();
    for (const entry of subagentRuns.values()) {
      const requesterTurnRunId = entry.requesterTurnRunId?.trim();
      if (!requesterTurnRunId) {
        continue;
      }
      let turns = requesterTurns.get(entry.requesterSessionKey);
      if (!turns) {
        turns = new Map();
        requesterTurns.set(entry.requesterSessionKey, turns);
      }
      const entries = turns.get(requesterTurnRunId) ?? [];
      entries.push(entry);
      turns.set(requesterTurnRunId, entries);
    }
    for (const [requesterSessionKey, turns] of requesterTurns) {
      for (const [requesterTurnRunId, entries] of turns) {
        settleRequesterTurnAfterSessionSpawns({
          requesterSessionKey,
          requesterTurnRunId,
          requesterYielded: entries.every((entry) => entry.requesterTurnYielded === true),
          acceptedSessionSpawns: entries.map((entry) => ({
            runId: entry.runId,
            childSessionKey: entry.childSessionKey,
          })),
        });
      }
    }
    if (subagentRuns.size === 0) {
      return;
    }
    // Resume pending work.
    ensureListener();
    // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
    startSweeper();
    const restoredSessionCache: SubagentSessionStoreCache = new Map();
    for (const [runId, entry] of subagentRuns) {
      if (entry.collect && entry.execution?.status === "queued") {
        const launch = entry.queuedLaunch;
        if (!launch) {
          void failAndCleanupRestoredQueuedRun(
            runId,
            entry,
            "queued collector launch state was unavailable after restart",
            false,
          );
          continue;
        }
        const groupRuns = listSwarmRunsForGroup(
          entry.groupId ?? "",
          entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
        );
        const currentSwarmConfig = resolveSwarmConfig(
          subagentRegistryDeps.getRuntimeConfig(),
          entry.requesterAgentId,
        );
        let launchTerminationConfirmed = false;
        enqueueSwarmRun({
          groupId: launch.schedulerGroupKey,
          runId,
          maxConcurrent: currentSwarmConfig.maxConcurrent,
          activeRunIds: groupRuns
            .filter((candidate) => candidate.execution?.status === "running")
            .map((candidate) => candidate.schedulerSlotId ?? candidate.runId),
          start: async () => {
            const response = await subagentRegistryDeps.callGateway({
              method: "agent",
              params: launch.request,
              timeoutMs: launch.timeoutMs,
            });
            const gatewayRunId = readGatewayRunId(response) ?? runId;
            try {
              if (!startQueuedSubagentRun(runId, gatewayRunId)) {
                throw new Error(
                  "collector registry row could not transition from queued to running",
                );
              }
            } catch (error) {
              await terminateAcceptedRestoredCollectorRun({
                entry,
                gatewayRunId,
                timeoutMs: launch.timeoutMs,
              });
              launchTerminationConfirmed = true;
              throw error;
            }
          },
          onStartFailure: (error) => {
            return failAndCleanupRestoredQueuedRun(
              runId,
              entry,
              error instanceof Error ? error.message : String(error),
              launchTerminationConfirmed,
            );
          },
        });
        continue;
      }
      // An aborted persisted session belongs to orphan recovery. Waiting on its
      // pre-restart run can terminalize it before the replacement turn starts.
      if (
        loadSubagentSessionEntry({
          childSessionKey: entry.childSessionKey,
          storeCache: restoredSessionCache,
        })?.abortedLastRun === true
      ) {
        continue;
      }
      resumeSubagentRun(runId);
    }

    // Cold-start restore can precede instance-runtime registration. The post-attach
    // startup pass retries this seam once the lifecycle-bound principal exists.
    scheduleSubagentOrphanRecovery();
  } catch (err) {
    log.warn(
      `failed to restore subagent runs from disk: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function failAndCleanupRestoredQueuedRun(
  runId: string,
  entry: SubagentRunRecord,
  error: string,
  launchTerminationConfirmed: boolean,
): Promise<boolean> {
  const cleanupComplete = await runWithGatewayIndependentRootWorkAdmission(async () => {
    for (;;) {
      try {
        await subagentRegistryDeps.callGateway({
          method: "sessions.delete",
          params: {
            key: entry.childSessionKey,
            deleteTranscript: true,
            emitLifecycleHooks: false,
          },
          timeoutMs: 10_000,
        });
        break;
      } catch (cleanupError) {
        log.warn("failed to delete restored collector session after launch failure", {
          runId,
          childSessionKey: entry.childSessionKey,
          error: cleanupError,
        });
        if (launchTerminationConfirmed) {
          return false;
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, process.env.OPENCLAW_TEST_FAST === "1" ? 1 : 1_000);
        timer.unref?.();
      });
    }
    if (!(await cleanupCollectorLaunchResources(entry))) {
      return false;
    }
    return true;
  }).catch((cleanupError: unknown) => {
    log.warn("failed to clean restored collector after launch failure", {
      runId,
      childSessionKey: entry.childSessionKey,
      error: cleanupError,
    });
    return false;
  });
  for (;;) {
    try {
      subagentRunManager.settleFailedQueuedSubagentLaunch(runId, error);
      break;
    } catch (persistError) {
      log.warn("failed to persist restored collector launch failure", {
        runId,
        childSessionKey: entry.childSessionKey,
        error: persistError,
      });
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, process.env.OPENCLAW_TEST_FAST === "1" ? 1 : 1_000);
      timer.unref?.();
    });
  }
  if (cleanupComplete) {
    emitSessionLifecycleEvent({
      sessionKey: entry.childSessionKey,
      reason: "delete",
      parentSessionKey: entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
    });
    completeCollectorLaunchCleanup(runId);
  }
  return true;
}

function resolveSubagentWaitTimeoutMs(cfg: OpenClawConfig, runTimeoutSeconds?: number) {
  return subagentRegistryDeps.resolveAgentTimeoutMs({
    cfg,
    overrideSeconds: runTimeoutSeconds ?? 0,
  });
}

function startSweeper() {
  if (sweeper) {
    return;
  }
  sweeper = setInterval(() => {
    if (sweepInProgress) {
      return;
    }
    void runSubagentSweep();
  }, 60_000);
  sweeper.unref?.();
}

async function runSubagentSweep() {
  try {
    await runWithGatewayIndependentRootWorkAdmission(async () => {
      await sweepSubagentRuns();
    });
  } catch (err) {
    log.warn(`subagent run sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function runSubagentSweepCleanupTail(runId: string, label: string, run: () => Promise<unknown>) {
  void runWithGatewayIndependentRootWorkAdmission(run).catch((error: unknown) => {
    log.warn(`subagent sweep ${label} failed`, { runId, error });
  });
}

function stopSweeper() {
  if (!sweeper) {
    return;
  }
  clearInterval(sweeper);
  sweeper = null;
}

function isSuspendedPendingFinalDelivery(entry: SubagentRunRecord): boolean {
  return typeof entry.endedAt === "number" && isDeliverySuspended(entry);
}

function resolveSuspendedDeliveryExpiryMs(entry: SubagentRunRecord): number {
  const requester = entry.requesterSessionKey;
  if (requester.includes(":cron:")) {
    return SUSPENDED_DELIVERY_CRON_EXPIRY_MS;
  }
  if (requester.includes(":subagent:")) {
    return SUSPENDED_DELIVERY_SUBAGENT_EXPIRY_MS;
  }
  return SUSPENDED_DELIVERY_INTERACTIVE_EXPIRY_MS;
}

async function discardSuspendedPendingFinalDelivery(
  runId: string,
  entry: SubagentRunRecord,
  now: number,
  reason: "expired" | "pressure-pruned",
): Promise<void> {
  const delivery = ensureDeliveryState(entry);
  const payload = delivery.payload;
  delivery.status = "discarded";
  delivery.discardedAt = now;
  delivery.discardReason = reason;
  delivery.discardedPayloadSummary = {
    requesterSessionKey: payload?.requesterSessionKey ?? entry.requesterSessionKey,
    childSessionKey: payload?.childSessionKey ?? entry.childSessionKey,
    childRunId: payload?.childRunId ?? entry.runId,
    endedAt: payload?.endedAt ?? entry.endedAt,
    status: payload?.outcome?.status ?? entry.outcome?.status,
    lastError: getDeliveryLastError(entry) ?? null,
  };
  delivery.payload = undefined;
  delivery.createdAt = undefined;
  delivery.lastAttemptAt = undefined;
  delivery.attemptCount = undefined;
  delivery.lastError = undefined;
  delivery.suspendedAt = undefined;
  delivery.suspendedReason = undefined;
  entry.wakeOnDescendantSettle = undefined;
  const completion = ensureCompletionState(entry);
  completion.fallbackResultText = undefined;
  completion.fallbackCapturedAt = undefined;
  entry.cleanupHandled = true;
  delivery.announcedAt = undefined;
  resumedRuns.delete(runId);
  clearPendingLifecycleError(runId);
  clearPendingLifecycleTimeout(runId);
  log.warn("subagent suspended delivery discarded", {
    reason,
    runId: entry.runId,
    childSessionKey: entry.childSessionKey,
    requesterSessionKey: entry.requesterSessionKey,
  });
  const shouldDeleteAttachments = entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep;
  if (shouldDeleteAttachments) {
    await safeRemoveAttachmentsDir(entry);
  }
  await removeInternalSessionEffectsSession(entry.execution?.transcriptTarget);
  const completionReason = entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
  completeCleanupBookkeeping({
    runId,
    entry,
    cleanup: entry.cleanup,
    completedAt: now,
    // The requester settle wake already ran when this delivery was suspended.
    skipRequesterSettleWake: true,
  });
  if (
    entry.expectsCompletionMessage === true &&
    shouldEmitEndedHookForRun({
      entry,
      reason: completionReason,
    })
  ) {
    await emitSubagentEndedHookForRun({
      entry,
      reason: completionReason,
      sendFarewell: true,
    });
  }
}

async function retireSupersededSubagentRun(runId: string, entry: SubagentRunRecord): Promise<void> {
  const transcriptTarget = entry.execution?.transcriptTarget;
  clearPendingLifecycleError(runId);
  subagentRuns.delete(runId);
  const transcriptStillOwned = Array.from(subagentRuns.values()).some((candidate) => {
    const candidateTarget = candidate.execution?.transcriptTarget;
    return (
      candidateTarget?.sessionId === transcriptTarget?.sessionId &&
      candidateTarget?.sessionKey === transcriptTarget?.sessionKey &&
      candidateTarget?.storePath === transcriptTarget?.storePath
    );
  });
  if (transcriptTarget && !transcriptStillOwned) {
    await removeInternalSessionEffectsSession(transcriptTarget);
  }
  if (entry.cleanup === "delete" || !entry.retainAttachmentsOnKeep) {
    await safeRemoveAttachmentsDir(entry);
  }
}

async function sweepSubagentRuns() {
  if (sweepInProgress) {
    return;
  }
  sweepInProgress = true;
  try {
    const now = Date.now();
    const storeCache: SubagentSessionStoreCache = new Map();
    let mutated = false;
    const archivedCollectorGroups = new Set<string>();
    const suspendedEntries = [...subagentRuns.entries()].filter(([, entry]) =>
      isSuspendedPendingFinalDelivery(entry),
    );
    const pressureDiscardRunIds = new Set<string>();
    if (suspendedEntries.length > SUSPENDED_DELIVERY_HARD_CAP) {
      const pressureCount = Math.max(
        0,
        suspendedEntries.length - SUSPENDED_DELIVERY_PRESSURE_TARGET,
      );
      for (const [runId] of suspendedEntries
        .toSorted((a, b) => (a[1].delivery?.suspendedAt ?? 0) - (b[1].delivery?.suspendedAt ?? 0))
        .slice(0, pressureCount)) {
        pressureDiscardRunIds.add(runId);
      }
      log.warn("subagent suspended delivery backlog exceeded pressure cap", {
        suspendedCount: suspendedEntries.length,
        softCap: SUSPENDED_DELIVERY_SOFT_CAP,
        hardCap: SUSPENDED_DELIVERY_HARD_CAP,
        pressureTarget: SUSPENDED_DELIVERY_PRESSURE_TARGET,
        pressureDiscardCount: pressureDiscardRunIds.size,
      });
    }
    for (const [runId, entry] of subagentRuns.entries()) {
      if (entry.requesterSettleWake) {
        resumeRequesterSettleWake(runId, entry);
        continue;
      }
      if (isSuspendedPendingFinalDelivery(entry)) {
        const suspendedAgeMs = now - (entry.delivery?.suspendedAt ?? now);
        const expired = suspendedAgeMs >= resolveSuspendedDeliveryExpiryMs(entry);
        if (expired || pressureDiscardRunIds.has(runId)) {
          await discardSuspendedPendingFinalDelivery(
            runId,
            entry,
            now,
            expired ? "expired" : "pressure-pruned",
          );
          mutated = true;
        }
        continue;
      }
      if (typeof entry.endedAt !== "number") {
        const hasLiveRunContext = Boolean(getAgentRunContext(runId));
        const activeAgeMs = now - (entry.startedAt ?? entry.createdAt);
        if (!hasLiveRunContext && activeAgeMs >= STALE_ACTIVE_SUBAGENT_GRACE_MS) {
          const orphanReason = resolveSubagentRunOrphanReason({
            entry,
          });
          if (orphanReason) {
            if (
              reconcileOrphanedRun({
                runId,
                entry,
                reason: orphanReason,
                source: "resume",
                runs: subagentRuns,
                resumedRuns,
              })
            ) {
              mutated = true;
            }
            continue;
          }

          const sessionEntry = loadSubagentSessionEntry({
            childSessionKey: entry.childSessionKey,
            storeCache,
          });
          const completion = resolveCompletionFromSessionEntry(sessionEntry, now, {
            notBeforeMs: entry.startedAt ?? entry.createdAt,
          });
          if (completion) {
            await completeSubagentRunWithRecovery(
              {
                runId,
                startedAt: completion.startedAt,
                endedAt: completion.endedAt,
                outcome: completion.outcome,
                reason: completion.reason,
                sendFarewell: true,
                accountId: entry.requesterOrigin?.accountId,
                triggerCleanup: true,
              },
              "sweeper-session-completion",
            );
            continue;
          }

          if (sessionEntry?.abortedLastRun === true) {
            scheduleSubagentOrphanRecovery({ delayMs: 1_000 });
            continue;
          }

          await completeSubagentRunWithRecovery(
            {
              runId,
              endedAt: now,
              outcome: {
                status: "error",
                error: "subagent run lost active execution context",
              },
              reason: SUBAGENT_ENDED_REASON_ERROR,
              sendFarewell: true,
              accountId: entry.requesterOrigin?.accountId,
              triggerCleanup: true,
            },
            "sweeper-lost-context",
          );
          continue;
        }
      }

      if (entry.killReconciliation) {
        const killReconciliation = entry.killReconciliation;
        const taskResolutionBeforeReconciliation = findSubagentTaskForRun(entry);
        const taskBeforeReconciliation = taskResolutionBeforeReconciliation.task;
        const nextRunCreatedAt = findNextSubagentRunCreatedAt(entry);
        const hasStableTaskCancellation =
          taskBeforeReconciliation?.status === "cancelled" &&
          !isProvisionalSubagentKillTask(taskBeforeReconciliation);
        const killedAt = killReconciliation.killedAt;
        const taskCompletion =
          nextRunCreatedAt === undefined
            ? resolveCompletionFromTerminalTask(taskBeforeReconciliation, entry)
            : undefined;
        if (taskCompletion) {
          // Provider reconciliation commits the non-publishing task ledger first.
          // If the registry write was interrupted, replay that durable projection
          // before the provisional kill can age into a contradictory cancellation.
          await completeSubagentRunWithRecovery(
            {
              runId,
              ...taskCompletion,
              sendFarewell: true,
              accountId: entry.requesterOrigin?.accountId,
              triggerCleanup: true,
            },
            "sweeper-provisional-kill-task-completion",
          );
          const current = subagentRuns.get(runId);
          if (current !== entry || current.killReconciliation !== killReconciliation) {
            continue;
          }
          // A failed registry retry must preserve the replayable task evidence.
          continue;
        }
        const reconcileAtMs = killedAt + PROVISIONAL_KILL_RECONCILIATION_MS;
        if (reconcileAtMs > now) {
          // Even durable cancellation keeps the evidence window open: a
          // provider result persisted before killedAt remains canonical.
          continue;
        }
        const sessionEntry = loadSubagentSessionEntry({
          childSessionKey: entry.childSessionKey,
          storeCache,
        });
        const completion = resolveCompletionFromSessionEntry(sessionEntry, now, {
          notBeforeMs: entry.startedAt ?? entry.createdAt,
        });
        const completionEndedAt = completion
          ? resolveSubagentRunEffectiveEndedAt(entry, completion.endedAt, completion.startedAt)
          : undefined;
        const completionDeadline = completion
          ? resolveSubagentRunDeadlineMs(entry, completion.startedAt)
          : undefined;
        const killedSnapshotExpiredDeadline =
          completion?.reason === SUBAGENT_ENDED_REASON_KILLED &&
          completionDeadline !== undefined &&
          completion.endedAt > completionDeadline
            ? completionDeadline
            : undefined;
        const completionCanOverrideCancellation =
          !hasStableTaskCancellation || (completionEndedAt ?? Number.POSITIVE_INFINITY) < killedAt;
        const completionBelongsToGeneration =
          nextRunCreatedAt === undefined ||
          (completion != null && completion.endedAt < nextRunCreatedAt);
        if (
          completion &&
          completionEndedAt !== undefined &&
          completionCanOverrideCancellation &&
          completionBelongsToGeneration &&
          (completion.reason !== SUBAGENT_ENDED_REASON_KILLED ||
            killedSnapshotExpiredDeadline !== undefined)
        ) {
          const hasNewerGeneration = nextRunCreatedAt !== undefined;
          await completeSubagentRunWithRecovery(
            {
              runId,
              startedAt: completion.startedAt,
              endedAt: killedSnapshotExpiredDeadline ?? completion.endedAt,
              outcome:
                killedSnapshotExpiredDeadline !== undefined
                  ? { status: "timeout" }
                  : completion.outcome,
              reason:
                killedSnapshotExpiredDeadline !== undefined
                  ? SUBAGENT_ENDED_REASON_COMPLETE
                  : completion.reason,
              sendFarewell: true,
              accountId: entry.requesterOrigin?.accountId,
              triggerCleanup: !hasNewerGeneration,
              suppressSessionEffects: hasNewerGeneration,
            },
            "sweeper-provisional-kill-completion",
          );
          if (
            hasNewerGeneration &&
            subagentRuns.get(runId) === entry &&
            entry.endedReason !== SUBAGENT_ENDED_REASON_KILLED
          ) {
            await retireSupersededSubagentRun(runId, entry);
            mutated = true;
            continue;
          }
          if (
            subagentRuns.get(runId) !== entry ||
            entry.endedReason !== SUBAGENT_ENDED_REASON_KILLED ||
            entry.killReconciliation !== killReconciliation
          ) {
            continue;
          }
          const taskResolutionAfterCompletion = findSubagentTaskForRun(entry);
          const taskAfterCompletion = taskResolutionAfterCompletion.task;
          const stableCancellationWonDuringCompletion =
            taskAfterCompletion?.status === "cancelled" &&
            !isProvisionalSubagentKillTask(taskAfterCompletion) &&
            completionEndedAt >= killedAt;
          if (
            !stableCancellationWonDuringCompletion &&
            taskResolutionAfterCompletion.lookup !== "unavailable"
          ) {
            // The attempted completion did not commit. Keep both durable
            // sources unless a newer stable cancellation won during capture.
            continue;
          }
        }
        // Completion capture yields. Revalidate both owners before promoting a
        // provisional marker into a sticky operator cancellation.
        if (
          subagentRuns.get(runId) !== entry ||
          entry.endedReason !== SUBAGENT_ENDED_REASON_KILLED ||
          entry.killReconciliation !== killReconciliation
        ) {
          continue;
        }
        const taskResolutionBefore = findSubagentTaskForRun(entry);
        const taskBefore = taskResolutionBefore.task;
        const stableTaskCancellationAfterReconciliation =
          taskBefore?.status === "cancelled" && !isProvisionalSubagentKillTask(taskBefore);
        const taskNeedsStabilization =
          taskResolutionBefore.lookup === "unavailable" ||
          (taskBefore !== undefined &&
            (taskBefore.status === "queued" ||
              taskBefore.status === "running" ||
              isProvisionalSubagentKillTask(taskBefore)));
        if (taskNeedsStabilization) {
          const observedError =
            entry.outcome?.status === "error" ? entry.outcome.error?.trim() : undefined;
          try {
            // The live callback may be lost across restart. Make the provisional
            // task state stable before its last reconciliation record is deleted.
            const finalizedTasks = finalizeTaskRunByRunId({
              runId: taskBefore?.runId ?? entry.taskRunId ?? runId,
              runtime: "subagent",
              sessionKey: taskBefore?.childSessionKey ?? entry.childSessionKey,
              status: "cancelled",
              endedAt: killedAt,
              lastEventAt: killedAt,
              error:
                observedError && observedError !== SUBAGENT_KILL_TASK_ERROR
                  ? observedError
                  : "Subagent run cancellation finalized.",
              suppressDelivery: true,
            });
            if (finalizedTasks.length === 0) {
              const taskAfterResolution = findSubagentTaskForRun(entry);
              const taskAfter = taskAfterResolution.task;
              if (
                taskAfterResolution.lookup === "available" &&
                taskAfter !== undefined &&
                (taskAfter.status === "queued" ||
                  taskAfter.status === "running" ||
                  isProvisionalSubagentKillTask(taskAfter))
              ) {
                log.warn("killed task was not stabilized during sweep", {
                  runId,
                  childSessionKey: entry.childSessionKey,
                });
                continue;
              }
              if (taskAfterResolution.lookup === "unavailable") {
                // Legacy custom runtimes cannot distinguish missing from
                // opaque task state. After the bounded window and one finalizer
                // attempt, do not leak the registry/session tombstone forever.
                log.warn("retiring killed tombstone after opaque task finalization", {
                  runId,
                  childSessionKey: entry.childSessionKey,
                });
              }
            }
          } catch (error) {
            log.warn("failed to finalize provisional killed task during sweep", {
              error,
              runId,
              childSessionKey: entry.childSessionKey,
            });
            continue;
          }
        }
        if (findNextSubagentRunCreatedAt(entry) !== undefined) {
          // A newer generation owns this session key. Retire only the old run;
          // session-scoped hooks or context cleanup would tear down the live owner.
          await retireSupersededSubagentRun(runId, entry);
          mutated = true;
          continue;
        }
        // Re-enter the normal cleanup owner only after cancellation is canonical.
        // It publishes the final failure once, then applies keep/delete semantics.
        entry.suppressCompletionDelivery =
          killReconciliation.suppressTaskDelivery === true ||
          hasStableTaskCancellation ||
          stableTaskCancellationAfterReconciliation
            ? true
            : undefined;
        entry.suppressAnnounceReason = undefined;
        entry.killReconciliation = undefined;
        entry.cleanupHandled = false;
        entry.cleanupCompletedAt = undefined;
        mutated = true;
        startSubagentAnnounceCleanupFlow(runId, entry);
        continue;
      }
      if (entry.collect && entry.collectorCompletion) {
        if (entry.collectorLaunchCleanupPending) {
          try {
            await subagentRegistryDeps.callGateway({
              method: "sessions.delete",
              params: {
                key: entry.childSessionKey,
                deleteTranscript: true,
                emitLifecycleHooks: false,
              },
              timeoutMs: 10_000,
            });
          } catch (err) {
            log.warn("failed to retry collector launch cleanup", {
              runId,
              childSessionKey: entry.childSessionKey,
              err,
            });
            continue;
          }
          if (!(await cleanupCollectorLaunchResources(entry))) {
            continue;
          }
          emitSessionLifecycleEvent({
            sessionKey: entry.childSessionKey,
            reason: "delete",
            parentSessionKey: entry.swarmRequesterSessionKey ?? entry.requesterSessionKey,
          });
          entry.collectorLaunchCleanupPending = false;
          entry.cleanupCompletedAt = now;
          mutated = true;
        }
        const groupId = entry.groupId?.trim();
        const swarmRequesterSessionKey =
          entry.swarmRequesterSessionKey ?? entry.requesterSessionKey;
        const groupKey = groupId ? JSON.stringify([swarmRequesterSessionKey, groupId]) : undefined;
        if (!groupKey || archivedCollectorGroups.has(groupKey)) {
          continue;
        }
        const groupEntries = [...subagentRuns.entries()].filter(
          ([, candidate]) =>
            candidate.collect === true &&
            (candidate.swarmRequesterSessionKey ?? candidate.requesterSessionKey) ===
              swarmRequesterSessionKey &&
            candidate.groupId === groupId,
        );
        // Collector results and lifetime cap accounting remain durable until
        // the entire group reaches its shared TTL, then archive as one batch.
        if (
          groupEntries.some(
            ([, candidate]) =>
              !candidate.collectorCompletion ||
              candidate.collectorLaunchCleanupPending === true ||
              candidate.archiveAtMs === undefined ||
              candidate.archiveAtMs > now,
          )
        ) {
          continue;
        }
        let deleteFailed = false;
        // Lifecycle cleanup already attempted each delete-mode session. Retry
        // here only so a transient cleanup failure cannot survive group archive.
        for (const [candidateRunId, candidate] of groupEntries) {
          if (candidate.cleanup !== "delete") {
            continue;
          }
          try {
            await subagentRegistryDeps.callGateway({
              method: "sessions.delete",
              params: {
                key: candidate.childSessionKey,
                deleteTranscript: true,
                emitLifecycleHooks: false,
              },
              timeoutMs: 10_000,
            });
          } catch (err) {
            log.warn("sessions.delete failed during collector group sweep; keeping group", {
              runId: candidateRunId,
              childSessionKey: candidate.childSessionKey,
              groupId,
              err,
            });
            deleteFailed = true;
            break;
          }
        }
        if (deleteFailed) {
          continue;
        }
        let attachmentCleanupFailed = false;
        for (const [candidateRunId, candidate] of groupEntries) {
          if (await safeRemoveAttachmentsDir(candidate)) {
            continue;
          }
          log.warn("attachment cleanup failed during collector group sweep; keeping group", {
            runId: candidateRunId,
            childSessionKey: candidate.childSessionKey,
            groupId,
          });
          attachmentCleanupFailed = true;
          break;
        }
        if (attachmentCleanupFailed) {
          continue;
        }
        let contextCleanupFailed = false;
        for (const [candidateRunId, candidate] of groupEntries) {
          if (
            candidate.cleanup === "delete" ||
            typeof candidate.contextEngineCleanupCompletedAt === "number"
          ) {
            continue;
          }
          try {
            await runContextEngineSubagentEnded({
              childSessionKey: candidate.childSessionKey,
              reason: "swept",
              agentDir: candidate.agentDir,
              workspaceDir: candidate.workspaceDir,
            });
            candidate.contextEngineCleanupCompletedAt = Date.now();
            persistSubagentRuns();
          } catch (err) {
            log.warn("context-engine cleanup failed during collector group sweep; keeping group", {
              runId: candidateRunId,
              childSessionKey: candidate.childSessionKey,
              groupId,
              err,
            });
            contextCleanupFailed = true;
            break;
          }
        }
        if (contextCleanupFailed) {
          continue;
        }
        for (const [candidateRunId] of groupEntries) {
          clearPendingLifecycleError(candidateRunId);
          subagentRuns.delete(candidateRunId);
        }
        archivedCollectorGroups.add(groupKey);
        mutated = true;
        continue;
      }
      if (!entry.archiveAtMs && entry.cleanup === "keep" && entry.spawnMode !== "session") {
        continue;
      }
      if (!entry.archiveAtMs) {
        if (
          typeof entry.cleanupCompletedAt === "number" &&
          now - entry.cleanupCompletedAt > SESSION_RUN_TTL_MS
        ) {
          clearPendingLifecycleError(runId);
          runSubagentSweepCleanupTail(runId, "context-engine cleanup", async () => {
            await notifyContextEngineSubagentEnded({
              childSessionKey: entry.childSessionKey,
              reason: "swept",
              agentDir: entry.agentDir,
              workspaceDir: entry.workspaceDir,
            });
          });
          subagentRuns.delete(runId);
          mutated = true;
          if (!entry.retainAttachmentsOnKeep) {
            await safeRemoveAttachmentsDir(entry);
          }
        }
        continue;
      }
      if (entry.archiveAtMs > now) {
        continue;
      }
      if (hasLiveOrRecentlyDispatchedContinuationWork(entry.childSessionKey)) {
        continue;
      }
      clearPendingLifecycleError(runId);
      try {
        await subagentRegistryDeps.callGateway({
          method: "sessions.delete",
          params: {
            key: entry.childSessionKey,
            deleteTranscript: true,
            emitLifecycleHooks: false,
          },
          timeoutMs: 10_000,
        });
      } catch (err) {
        log.warn("sessions.delete failed during subagent sweep; keeping run for retry", {
          runId,
          childSessionKey: entry.childSessionKey,
          err,
        });
        continue;
      }
      subagentRuns.delete(runId);
      mutated = true;
      // Archive/purge is terminal for the run record; remove any retained attachments too.
      await safeRemoveAttachmentsDir(entry);
      runSubagentSweepCleanupTail(runId, "context-engine cleanup", async () => {
        await notifyContextEngineSubagentEnded({
          childSessionKey: entry.childSessionKey,
          reason: "swept",
          agentDir: entry.agentDir,
          workspaceDir: entry.workspaceDir,
        });
      });
    }
    // Sweep orphaned pendingLifecycleError entries (absolute TTL).
    for (const [runId, pending] of pendingLifecycleErrorByRunId.entries()) {
      if (now - pending.endedAt > PENDING_LIFECYCLE_TERMINAL_TTL_MS) {
        clearPendingLifecycleError(runId);
      }
    }
    for (const [runId, pending] of pendingLifecycleTimeoutByRunId.entries()) {
      if (now - pending.endedAt > PENDING_LIFECYCLE_TERMINAL_TTL_MS) {
        clearPendingLifecycleTimeout(runId);
      }
    }

    if (mutated) {
      persistSubagentRuns();
    }
    if (subagentRuns.size === 0) {
      stopSweeper();
    }
  } finally {
    sweepInProgress = false;
  }
}

function ensureListener() {
  if (listenerStarted) {
    return;
  }
  listenerStarted = true;
  listenerStop = subagentRegistryDeps.onAgentEvent((evt) => {
    void (async () => {
      if (!evt || evt.stream !== "lifecycle") {
        return;
      }
      const phase = evt.data?.phase;
      const entry = subagentRuns.get(evt.runId);
      if (!entry) {
        if (phase === "end" && typeof evt.sessionKey === "string") {
          const sessionKey = evt.sessionKey;
          // A replacement generation can finish after its predecessor row is
          // terminal. Keep capture + persistence inside the suspension fence.
          await runWithGatewayIndependentRootWorkAdmission(async () => {
            await refreshFrozenResultFromSession(sessionKey);
          });
        }
        return;
      }
      if (phase === "start") {
        clearPendingLifecycleError(evt.runId);
        clearPendingLifecycleTimeout(evt.runId);
        const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
        if (startedAt) {
          entry.startedAt = startedAt;
          if (typeof entry.sessionStartedAt !== "number") {
            entry.sessionStartedAt = startedAt;
          }
          persistSubagentRuns();
        }
        return;
      }
      if (phase !== "end" && phase !== "error") {
        return;
      }
      const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : Date.now();
      const startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : undefined;
      const error = typeof evt.data?.error === "string" ? evt.data.error : undefined;
      const livenessState =
        typeof evt.data?.livenessState === "string" ? evt.data.livenessState : undefined;
      const stopReason = typeof evt.data?.stopReason === "string" ? evt.data.stopReason : undefined;
      // sessions_yield ends the turn by aborting the run signal, so a yielded
      // terminal can also look aborted. An explicit yield is authoritative — pause,
      // don't kill — else the tracking task settles `cancelled` with a false notice (#92448).
      if (evt.data?.yielded === true) {
        // Drop any grace timer from an earlier aborted/error terminal so it can't
        // later fire and settle this now-paused run with a false notice.
        clearPendingLifecycleError(evt.runId);
        clearPendingLifecycleTimeout(evt.runId);
        if (
          markSubagentRunPausedAfterYield({
            entry,
            endedAt,
            startedAt: startedAt ?? entry.startedAt,
          })
        ) {
          persistSubagentRuns();
        }
        return;
      }
      if (isAbortedAgentStopReason(stopReason)) {
        clearPendingLifecycleError(evt.runId);
        clearPendingLifecycleTimeout(evt.runId);
        await completeSubagentRunWithRecovery(
          {
            runId: evt.runId,
            endedAt,
            outcome: {
              status: "error",
              error: "subagent run terminated",
            },
            reason: SUBAGENT_ENDED_REASON_KILLED,
            sendFarewell: true,
            accountId: entry.requesterOrigin?.accountId,
            triggerCleanup: true,
            startedAt,
          },
          "lifecycle-killed-event",
        );
        return;
      }
      if (phase === "error") {
        schedulePendingLifecycleError({
          runId: evt.runId,
          endedAt,
          startedAt,
          error,
        });
        return;
      }
      const blocked = isBlockedLivenessState(livenessState);
      const abandoned = isAbandonedLivenessState(livenessState);
      if (blocked || abandoned) {
        clearPendingLifecycleError(evt.runId);
        clearPendingLifecycleTimeout(evt.runId);
        const blockedParams = {
          runId: evt.runId,
          endedAt,
          outcome: {
            status: "error" as const,
            error: blocked
              ? formatBlockedLivenessError(error)
              : formatAbandonedLivenessError(error),
          },
          reason: SUBAGENT_ENDED_REASON_ERROR,
          sendFarewell: true,
          accountId: entry.requesterOrigin?.accountId,
          triggerCleanup: true,
          startedAt,
        };
        await completeSubagentRunWithRecovery(
          blockedParams,
          blocked ? "lifecycle-blocked-event" : "lifecycle-abandoned-event",
        );
        return;
      }
      if (evt.data?.aborted) {
        schedulePendingLifecycleTimeout({
          runId: evt.runId,
          endedAt,
          startedAt,
        });
        return;
      }
      clearPendingLifecycleError(evt.runId);
      clearPendingLifecycleTimeout(evt.runId);
      const completionParams = {
        runId: evt.runId,
        endedAt,
        outcome: { status: "ok" as const },
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: true,
        startedAt,
      };
      await completeSubagentRunWithRecovery(completionParams, "lifecycle-ok-event");
    })().catch((err: unknown) => {
      log.warn("lifecycle event handler failed", { err, runId: evt.runId });
    });
  });
}

const subagentRunManager = createSubagentRunManager({
  runs: subagentRuns,
  resumedRuns,
  persist: persistSubagentRuns,
  persistOrThrow: persistSubagentRunsOrThrow,
  callGateway: async <T>(request: Parameters<typeof callGateway>[0]) => {
    if (request.method === "agent.wait") {
      const gatewayRuntime = getGatewayRecoveryRuntime();
      if (gatewayRuntime) {
        // Registry waits are Gateway-owned lifecycle work. Keep them on the
        // owning instance when one exists; standalone processes authenticate normally.
        return await gatewayRuntime.waitForAgent<T>(
          (request.params ?? {}) as Record<string, unknown>,
          request.timeoutMs ?? undefined,
        );
      }
    }
    return await subagentRegistryDeps.callGateway<T>(request);
  },
  getRuntimeConfig: () => subagentRegistryDeps.getRuntimeConfig(),
  ensureListener,
  startSweeper,
  stopSweeper,
  resumeSubagentRun,
  clearPendingLifecycleError,
  clearPendingLifecycleTimeout,
  resolveSubagentWaitTimeoutMs,
  scheduleOrphanRecovery: (args) => scheduleSubagentOrphanRecovery(args),
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
  notifyContextEngineSubagentEnded,
  completeCleanupBookkeeping,
  completeSubagentRun: async (params) => {
    await completeSubagentRunWithRecovery(params, "subagent-wait");
  },
  resolveSubagentTask: findSubagentTaskForRun,
});

configureSubagentRegistrySteerRuntime({
  replaceSubagentRunAfterSteer: (params) => subagentRunManager.replaceSubagentRunAfterSteer(params),
  finalizeInterruptedSubagentRun: async (params) => await finalizeInterruptedSubagentRun(params),
  reserveSwarmCollectorLaunch: (runId, idempotencyKey) => {
    const entry =
      subagentRuns.get(runId) ??
      [...subagentRuns.values()].find((candidate) => candidate.swarmRunId === runId);
    if (
      !entry ||
      entry.collect !== true ||
      entry.collectorCompletion ||
      typeof entry.endedAt === "number"
    ) {
      return false;
    }
    const previousIdempotencyKey = entry.swarmLaunchIdempotencyKey;
    const previousPending = entry.swarmLaunchPending;
    entry.swarmLaunchIdempotencyKey = idempotencyKey;
    entry.swarmLaunchPending = true;
    try {
      persistSubagentRunsOrThrow();
    } catch (error) {
      entry.swarmLaunchIdempotencyKey = previousIdempotencyKey;
      entry.swarmLaunchPending = previousPending;
      throw error;
    }
    return true;
  },
});
configureSubagentRegistrySpawnRuntime({
  countActiveRunsForSession: (requesterSessionKey) =>
    countActiveRunsForSession(requesterSessionKey),
  registerSubagentRun: (params) => registerSubagentRun(params),
});

export function markSubagentRunForSteerRestart(runId: string) {
  return subagentRunManager.markSubagentRunForSteerRestart(runId);
}

export function clearSubagentRunSteerRestart(runId: string) {
  return subagentRunManager.clearSubagentRunSteerRestart(runId);
}

export function replaceSubagentRunAfterSteer(params: {
  previousRunId: string;
  nextRunId: string;
  fallback?: SubagentRunRecord;
  runTimeoutSeconds?: number;
  preserveFrozenResultFallback?: boolean;
  transcriptTarget?: AgentRunSessionTarget;
  task?: string;
}) {
  return subagentRunManager.replaceSubagentRunAfterSteer(params);
}

export function registerSubagentRun(params: RegisterSubagentRunParams) {
  subagentRunManager.registerSubagentRun(params);
}

export function startQueuedSubagentRun(runId: string, gatewayRunId?: string) {
  return subagentRunManager.startQueuedSubagentRun(runId, gatewayRunId);
}

function failQueuedSubagentRun(runId: string, error: string) {
  return subagentRunManager.failQueuedSubagentRun(runId, error);
}

export function settleFailedQueuedSubagentLaunch(runId: string, error: string) {
  return subagentRunManager.settleFailedQueuedSubagentLaunch(runId, error);
}

function resetSubagentRegistryForTests(opts?: { persist?: boolean }) {
  clearScheduledResumeTimers();
  for (const timer of resumeRetryTimers) {
    clearTimeout(timer);
  }
  resumeRetryTimers.clear();
  subagentRuns.clear();
  resumedRuns.clear();
  endedHookInFlightRunIds.clear();
  clearAllPendingLifecycleErrors();
  clearAllPendingLifecycleTimeouts();
  contextEngineInitLoader.clear();
  contextEngineRegistryLoader.clear();
  runtimePluginsLoader.clear();
  subagentAnnounceLoader.clear();
  browserCleanupLoader.clear();
  clearSubagentRunsReadCacheForTest();
  stopSweeper();
  sweepInProgress = false;
  restoreAttempted = false;
  lastOrphanRecoveryScheduleAt = 0;
  if (listenerStop) {
    listenerStop();
    listenerStop = null;
  }
  listenerStarted = false;
  if (opts?.persist !== false) {
    persistSubagentRuns();
  }
}

const testing = {
  failQueuedSubagentRun,
  async sweepOnceForTests() {
    await sweepSubagentRuns();
  },
  async runSweeperTickForTests() {
    await runSubagentSweep();
  },
  setDepsForTest(overrides?: Partial<SubagentRegistryDeps>) {
    subagentRegistryDeps = overrides
      ? {
          ...defaultSubagentRegistryDeps,
          ...overrides,
        }
      : defaultSubagentRegistryDeps;
  },
} as const;

function addSubagentRunForTests(entry: SubagentRunRecord) {
  subagentRuns.set(entry.runId, entry);
}

function releaseSubagentRun(runId: string) {
  subagentRunManager.releaseSubagentRun(runId);
}

function hasCompleteSubagentTerminalState(entry: SubagentRunRecord | undefined): boolean {
  return (
    entry !== undefined &&
    typeof entry.endedAt === "number" &&
    Number.isFinite(entry.endedAt) &&
    entry.outcome !== undefined &&
    entry.endedReason !== undefined &&
    entry.execution?.status === "terminal"
  );
}

async function finalizeInterruptedSubagentRun(params: {
  runId: string;
  error: string;
  endedAt?: number;
}): Promise<number> {
  const runId = params.runId.trim();
  if (!runId) {
    return 0;
  }

  const endedAt =
    typeof params.endedAt === "number" && Number.isFinite(params.endedAt)
      ? params.endedAt
      : Date.now();
  clearPendingLifecycleError(runId);
  clearPendingLifecycleTimeout(runId);
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return 0;
  }
  if (
    typeof entry.cleanupCompletedAt === "number" &&
    entry.terminalOwner !== "interrupted-recovery"
  ) {
    return hasCompleteSubagentTerminalState(entry) ? 1 : 0;
  }
  const completionParams: CompleteSubagentRunParams = {
    runId,
    endedAt,
    outcome: {
      status: "error",
      error: params.error,
    },
    reason: SUBAGENT_ENDED_REASON_ERROR,
    sendFarewell: true,
    accountId: entry.requesterOrigin?.accountId,
    triggerCleanup: true,
    recoverInterrupted: true,
  };
  try {
    await completeSubagentRun(completionParams);
    // A successfully finalized stale generation can be retired once a newer
    // generation owns the session; the captured exact row still has its result.
    const finalized = subagentRuns.get(runId) ?? entry;
    // Recovery preserves partial terminal evidence instead of overwriting it.
    // Keep scheduler retries alive until the exact row is fully terminal.
    return hasCompleteSubagentTerminalState(finalized) ? 1 : 0;
  } catch (error) {
    if (isGatewayRestartDraining() && subagentRuns.get(runId) === entry) {
      log.warn("subagent completion deferred during gateway restart", {
        source: "explicit-failed-mark",
        runId,
      });
      scheduleSubagentCompletionRetryAfterRestart(completionParams, "explicit-failed-mark", entry);
      return 1;
    }
    log.warn("failed to durably finalize interrupted subagent run", {
      runId,
      childSessionKey: entry.childSessionKey,
      error,
    });
    return 0;
  }
}

export function markSubagentRunTerminated(params: {
  runId?: string;
  childSessionKey?: string;
  reason?: string;
  suppressTaskDelivery?: boolean;
}): number {
  return subagentRunManager.markSubagentRunTerminated(params);
}

export function leasePendingAgentSteeringItems(params: {
  requesterSessionKey: string;
  leaseId: string;
  now?: number;
}) {
  restoreSubagentRunsOnce();
  const leased = leasePendingAgentSteeringItemsFromSubagentRuns({
    runs: subagentRuns,
    requesterSessionKey: params.requesterSessionKey,
    leaseId: params.leaseId,
    now: params.now,
  });
  if (leased) {
    persistSubagentRuns();
  }
  return leased;
}

export function ackPendingAgentSteeringItems(params: {
  runIds: readonly string[];
  leaseId: string;
  now?: number;
}): number {
  const updated = ackLeasedAgentSteeringItemsFromSubagentRuns({
    runs: subagentRuns,
    runIds: params.runIds,
    leaseId: params.leaseId,
    now: params.now,
  });
  if (updated > 0) {
    persistSubagentRuns();
    for (const runId of params.runIds) {
      const entry = subagentRuns.get(runId);
      if (!entry || typeof entry.cleanupCompletedAt === "number") {
        continue;
      }
      entry.cleanupHandled = false;
      startSubagentAnnounceCleanupFlow(runId, entry);
    }
  }
  return updated;
}

export function releasePendingAgentSteeringItems(params: {
  runIds: readonly string[];
  leaseId: string;
  error?: string;
}): number {
  const updated = releaseLeasedAgentSteeringItemsFromSubagentRuns({
    runs: subagentRuns,
    runIds: params.runIds,
    leaseId: params.leaseId,
    error: params.error,
  });
  if (updated > 0) {
    persistSubagentRuns();
  }
  return updated;
}

export { prependAgentSteeringPrompt };

export function listSubagentRunsForController(controllerSessionKey: string): SubagentRunRecord[] {
  return listRunsForControllerFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    controllerSessionKey,
  );
}

export function getSubagentRunByRunId(runId: string): SubagentRunRecord | undefined {
  const key = runId.trim();
  const snapshot = subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns);
  return snapshot.get(key) ?? [...snapshot.values()].find((entry) => entry.swarmRunId === key);
}

export function getSubagentRunsByRunIds(runIds: readonly string[]): {
  entries: Map<string, SubagentRunRecord>;
} {
  const snapshot = subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns);
  const byId = new Map<string, SubagentRunRecord>();
  for (const entry of snapshot.values()) {
    byId.set(entry.runId, entry);
    if (entry.swarmRunId) {
      byId.set(entry.swarmRunId, entry);
    }
  }
  return {
    entries: new Map(
      runIds.flatMap((runId) => {
        const entry = byId.get(runId.trim());
        return entry ? [[runId, entry] as const] : [];
      }),
    ),
  };
}

export function completeCollectorLaunchCleanup(runId: string): void {
  const key = runId.trim();
  const entry =
    subagentRuns.get(key) ??
    [...subagentRuns.values()].find((candidate) => candidate.swarmRunId === key);
  if (!entry?.collectorLaunchCleanupPending) {
    return;
  }
  entry.collectorLaunchCleanupPending = false;
  entry.cleanupCompletedAt = Date.now();
  entry.contextEngineCleanupCompletedAt ??= entry.cleanupCompletedAt;
  persistSubagentRuns();
}

export function recordSwarmStructuredOutput(
  identity: { runId?: string; childSessionKey?: string },
  state: SwarmStructuredOutputState,
): void {
  const runId = identity.runId?.trim();
  const childSessionKey = identity.childSessionKey?.trim();
  const entry =
    (runId
      ? (subagentRuns.get(runId) ??
        [...subagentRuns.values()].find((candidate) => candidate.swarmRunId === runId))
      : undefined) ??
    (childSessionKey
      ? [...subagentRuns.values()]
          .filter((candidate) => candidate.childSessionKey === childSessionKey)
          .toSorted((left, right) => (right.generation ?? 0) - (left.generation ?? 0))[0]
      : undefined);
  if (!entry?.collect || entry.collectorCompletion) {
    throw new Error("collector run is unavailable");
  }
  const previous = entry.structuredOutput;
  entry.structuredOutput = structuredClone(state);
  try {
    persistSubagentRunsOrThrow();
  } catch (error) {
    entry.structuredOutput = previous;
    throw error;
  }
}

export function listSwarmRunsForGroup(
  groupId: string,
  requesterSessionKey?: string,
): SubagentRunRecord[] {
  const key = groupId.trim();
  const requesterKey = requesterSessionKey?.trim();
  return [...subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns).values()].filter(
    (entry) =>
      entry.collect === true &&
      entry.groupId === key &&
      (!requesterKey ||
        (entry.swarmRequesterSessionKey ?? entry.requesterSessionKey) === requesterKey),
  );
}

/** Resolve a collector reserved by a replay-safe host bridge request. */
export function getSwarmRunByLaunchReplayKey(
  replayKey: string,
  requesterSessionKey?: string,
): SubagentRunRecord | undefined {
  const key = replayKey.trim();
  const requesterKey = requesterSessionKey?.trim();
  if (!key) {
    return undefined;
  }
  return [...subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns).values()].find(
    (entry) =>
      entry.collect === true &&
      entry.swarmLaunchReplayKey === key &&
      (!requesterKey ||
        (entry.swarmRequesterSessionKey ?? entry.requesterSessionKey) === requesterKey),
  );
}

export function countActiveRunsForSession(
  requesterSessionKey: string,
  options?: { collect?: boolean },
): number {
  return countActiveRunsForSessionFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    requesterSessionKey,
    options,
  );
}

export function countActiveDescendantRuns(rootSessionKey: string): number {
  return countActiveDescendantRunsFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function countPendingDescendantRuns(rootSessionKey: string): number {
  return countPendingDescendantRunsFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function listDescendantRunsForRequester(rootSessionKey: string): SubagentRunRecord[] {
  return listDescendantRunsForRequesterFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function getSubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null {
  return getSubagentRunByChildSessionKeyFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
}

export function getLatestSubagentRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }

  let latest: SubagentRunRecord | null = null;
  for (const entry of subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns).values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (!latest || compareSubagentRunGeneration(entry, latest) > 0) {
      latest = entry;
    }
  }

  return latest;
}

export function initSubagentRegistry() {
  restoreSubagentRunsOnce();
}

/** Re-admits a delivered child batch after its requester explicitly yields. */
export function settleRequesterAfterSessionSpawns(params: {
  requesterSessionKey: string;
  requesterTurnRunId: string;
  requesterYielded: boolean;
  acceptedSessionSpawns: readonly AcceptedSessionSpawn[];
}): boolean {
  return settleRequesterTurnAfterSessionSpawns(params);
}

/** Records sessions_yield before the active requester run is aborted. */
export function markRequesterTurnYielded(params: {
  requesterSessionKey: string;
  requesterTurnRunId: string;
}): number {
  restoreSubagentRunsOnce();
  return markRequesterTurnYieldedInRuns({
    ...params,
    runs: subagentRuns,
    persistOrThrow: persistSubagentRunsOrThrow,
  });
}

const SUBAGENT_REGISTRY_TEST_HANDLE = Symbol.for("openclaw.subagentRegistryTestApi");
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[SUBAGENT_REGISTRY_TEST_HANDLE] = {
    addSubagentRunForTests,
    finalizeInterruptedSubagentRun,
    releaseSubagentRun,
    resetSubagentRegistryForTests,
    testing,
  };
}

// Register the subagent maintenance preserve-key provider as a module side effect.
import "./subagent-registry-maintenance.js";
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
