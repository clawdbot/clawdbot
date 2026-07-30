/** Coordinates subagent registration, lifecycle, delivery, steering, recovery, and persistence. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { getGatewayRecoveryRuntime } from "../gateway/server-recovery-runtime-context.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isGatewayRestartDraining,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { prependAgentSteeringPrompt } from "./agent-steering-queue.js";
import type { AgentRunSessionTarget } from "./run-session-target.js";
import {
  getDeliveryAttemptCount,
  getDeliveryLastAttemptAt,
  isDeliverySuspended,
} from "./subagent-delivery-state.js";
import { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { emitSubagentProgressEndedHook } from "./subagent-registry-completion.js";
import { createSubagentRegistryContextCleanup } from "./subagent-registry-context-cleanup.js";
import {
  resetSubagentRegistryRuntimeLoadersForTests,
  setSubagentRegistryDepsForTest,
  subagentRegistryDeps,
  type SubagentRegistryDeps,
} from "./subagent-registry-deps.js";
import {
  ANNOUNCE_EXPIRY_MS,
  MAX_ANNOUNCE_RETRY_COUNT,
  reconcileOrphanedRun,
  resolveAnnounceRetryDelayMs,
} from "./subagent-registry-helpers.js";
import { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import { createSubagentRegistryListener } from "./subagent-registry-listener.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { createSubagentRegistryPublicApi } from "./subagent-registry-public-api.js";
import { createSubagentRegistryRestorer } from "./subagent-registry-restore.js";
import {
  createSubagentRunManager,
  type RegisterSubagentRunParams,
} from "./subagent-registry-run-manager.js";
import { clearSubagentRunsReadCacheForTest } from "./subagent-registry-state.js";
import { configureSubagentRegistrySteerRuntime } from "./subagent-registry-steer-runtime.js";
import { resolveSubagentTaskForRun } from "./subagent-registry-sweep-kill.js";
import {
  createSubagentRegistrySweeper,
  retireSupersededSubagentRun as retireSupersededSubagentRunForSweep,
} from "./subagent-registry-sweeper.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import {
  resolveSubagentRunOrphanReason,
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
} from "./subagent-session-reconciliation.js";

export type { SubagentRunRecord } from "./subagent-registry.types.js";
const log = createSubsystemLogger("agents/subagent-registry");

type SubagentRegistryRestorer = ReturnType<typeof createSubagentRegistryRestorer>;
type SubagentRegistryBootstrapState = {
  pending?: boolean;
  ready?: boolean;
  restorer?: SubagentRegistryRestorer;
};

function getSubagentRegistryBootstrapState(): SubagentRegistryBootstrapState {
  const owner = getSubagentRegistryBootstrapState as typeof getSubagentRegistryBootstrapState & {
    state?: SubagentRegistryBootstrapState;
  };
  owner.state ??= {};
  return owner.state;
}

const resumeRetryTimers = new Set<ReturnType<typeof setTimeout>>();
const ORPHAN_RECOVERY_DEBOUNCE_MS = 1_000;
let lastOrphanRecoveryScheduleAt = 0;
const SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
const GATEWAY_ADMISSION_RETRY_DELAY_MS = 1_000;

function persistSubagentRuns() {
  subagentRegistryDeps.persistSubagentRunsToDisk(subagentRuns);
}

function persistSubagentRunsOrThrow() {
  subagentRegistryDeps.persistSubagentRunsToDiskOrThrow(subagentRuns);
}

function findSubagentTaskForRun(entry: SubagentRunRecord) {
  return resolveSubagentTaskForRun(subagentRuns, entry);
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

const completionRuntime = createSubagentRegistryCompletionRuntime({
  runs: subagentRuns,
  resumed: resumedRuns,
  retryTimers: resumeRetryTimers,
  completeSubagentRun: (params) => completeSubagentRun(params),
  scheduleOrphanRecovery: scheduleSubagentOrphanRecovery,
  resumeRun: (runId) => resumeSubagentRun(runId),
  warn: (message, meta) => log.warn(message, meta),
});
const pendingLifecycle = completionRuntime.pendingLifecycle;
const clearPendingLifecycleError = pendingLifecycle.clearError;
const clearPendingLifecycleTimeout = pendingLifecycle.clearTimeout;

const contextCleanup = createSubagentRegistryContextCleanup({
  deps: () => subagentRegistryDeps,
  persist: persistSubagentRuns,
  warn: (message, meta) => log.warn(message, meta),
});

const subagentLifecycleController = createSubagentRegistryLifecycleController({
  runs: subagentRuns,
  resumedRuns,
  subagentAnnounceTimeoutMs: SUBAGENT_ANNOUNCE_TIMEOUT_MS,
  getRuntimeConfig: () => subagentRegistryDeps.getRuntimeConfig(),
  persist: persistSubagentRuns,
  persistOrThrow: persistSubagentRunsOrThrow,
  clearPendingLifecycleError,
  countPendingDescendantRuns: (rootSessionKey) =>
    publicApi.countPendingDescendantRuns(rootSessionKey),
  suppressAnnounceForSteerRestart: contextCleanup.suppressAnnounceForSteerRestart,
  resolveSubagentTask: findSubagentTaskForRun,
  shouldEmitEndedHookForRun: contextCleanup.shouldEmitEndedHookForRun,
  emitSubagentEndedHookForRun: contextCleanup.emitSubagentEndedHookForRun,
  emitSubagentProgressEndedForRun: emitSubagentProgressEndedHook,
  notifyContextEngineSubagentEnded: contextCleanup.notifyContextEngineSubagentEnded,
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
    if (contextCleanup.suppressAnnounceForSteerRestart(entry)) {
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

const subagentRestorer = createSubagentRegistryRestorer({
  runs: subagentRuns,
  resumedRuns,
  deps: () => subagentRegistryDeps,
  persist: persistSubagentRuns,
  settleRequesterTurn: settleRequesterTurnAfterSessionSpawns,
  ensureListener: () => subagentListener.ensure(),
  startSweeper: () => subagentSweeper.start(),
  resumeRun: (runId) => resumeSubagentRun(runId),
  listSwarmRunsForGroup: (groupId, requesterSessionKey) =>
    listSwarmRunsForGroup(groupId, requesterSessionKey),
  startQueuedSubagentRun: (runId, gatewayRunId) =>
    subagentRunManager.startQueuedSubagentRun(runId, gatewayRunId),
  terminateAcceptedRestoredCollectorRun: contextCleanup.terminateAcceptedRestoredCollectorRun,
  cleanupCollectorLaunchResources: contextCleanup.cleanupCollectorLaunchResources,
  settleFailedQueuedSubagentLaunch: (runId, error) =>
    subagentRunManager.settleFailedQueuedSubagentLaunch(runId, error),
  completeCollectorLaunchCleanup: (runId) => publicApi.completeCollectorLaunchCleanup(runId),
  scheduleOrphanRecovery: scheduleSubagentOrphanRecovery,
  warn: (message, meta) => log.warn(message, meta),
});

function resolveSubagentWaitTimeoutMs(cfg: OpenClawConfig, runTimeoutSeconds?: number) {
  return subagentRegistryDeps.resolveAgentTimeoutMs({
    cfg,
    overrideSeconds: runTimeoutSeconds ?? 0,
  });
}

function retireSupersededSubagentRun(runId: string, entry: SubagentRunRecord): Promise<void> {
  return retireSupersededSubagentRunForSweep({
    runId,
    entry,
    runs: subagentRuns,
    clearPendingLifecycleError,
  });
}

const subagentSweeper = createSubagentRegistrySweeper({
  runs: subagentRuns,
  resumedRuns,
  persist: persistSubagentRuns,
  clearPendingLifecycleError,
  clearPendingLifecycleTimeout,
  sweepPendingLifecycle: (now) => pendingLifecycle.sweepExpired(now),
  completeSubagentRunWithRecovery: completionRuntime.completeSubagentRunWithRecovery,
  scheduleSubagentOrphanRecovery,
  resumeRequesterSettleWake,
  startSubagentAnnounceCleanupFlow,
  completeCleanupBookkeeping,
  shouldEmitEndedHookForRun: contextCleanup.shouldEmitEndedHookForRun,
  emitSubagentEndedHookForRun: contextCleanup.emitSubagentEndedHookForRun,
  callGateway: (request) => subagentRegistryDeps.callGateway(request),
  cleanupCollectorLaunchResources: contextCleanup.cleanupCollectorLaunchResources,
  runContextEngineSubagentEnded: contextCleanup.runContextEngineSubagentEnded,
  notifyContextEngineSubagentEnded: contextCleanup.notifyContextEngineSubagentEnded,
  retireSupersededRun: retireSupersededSubagentRun,
  warn: (message, meta) => log.warn(message, meta),
});

const subagentListener = createSubagentRegistryListener({
  runs: subagentRuns,
  pendingLifecycle,
  onAgentEvent: (listener) => subagentRegistryDeps.onAgentEvent(listener),
  persist: persistSubagentRuns,
  refreshFrozenResultFromSession,
  completeSubagentRunWithRecovery: completionRuntime.completeSubagentRunWithRecovery,
  warn: (message, meta) => log.warn(message, meta),
});

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
  ensureListener: subagentListener.ensure,
  startSweeper: subagentSweeper.start,
  stopSweeper: subagentSweeper.stop,
  resumeSubagentRun,
  clearPendingLifecycleError,
  clearPendingLifecycleTimeout,
  resolveSubagentWaitTimeoutMs,
  scheduleOrphanRecovery: (args) => scheduleSubagentOrphanRecovery(args),
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
  notifyContextEngineSubagentEnded: contextCleanup.notifyContextEngineSubagentEnded,
  completeCleanupBookkeeping,
  completeSubagentRun: async (params) => {
    await completionRuntime.completeSubagentRunWithRecovery(params, "subagent-wait");
  },
  resolveSubagentTask: findSubagentTaskForRun,
});

configureSubagentRegistrySteerRuntime({
  replaceSubagentRunAfterSteer: (params) => subagentRunManager.replaceSubagentRunAfterSteer(params),
  finalizeInterruptedSubagentRun: async (params) =>
    await completionRuntime.finalizeInterruptedSubagentRun(params),
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
  pendingLifecycle.clearAll();
  resetSubagentRegistryRuntimeLoadersForTests();
  contextCleanup.reset();
  clearSubagentRunsReadCacheForTest();
  subagentSweeper.reset();
  subagentRestorer.reset();
  lastOrphanRecoveryScheduleAt = 0;
  subagentListener.reset();
  if (opts?.persist !== false) {
    persistSubagentRuns();
  }
}

const testing = {
  failQueuedSubagentRun,
  async sweepOnceForTests() {
    await subagentSweeper.sweepOnce();
  },
  async runSweeperTickForTests() {
    await subagentSweeper.runTick();
  },
  setDepsForTest(overrides?: Partial<SubagentRegistryDeps>) {
    setSubagentRegistryDepsForTest(overrides);
  },
} as const;

function addSubagentRunForTests(entry: SubagentRunRecord) {
  subagentRuns.set(entry.runId, entry);
}

function releaseSubagentRun(runId: string) {
  subagentRunManager.releaseSubagentRun(runId);
}

export function markSubagentRunTerminated(params: {
  runId?: string;
  childSessionKey?: string;
  reason?: string;
  suppressTaskDelivery?: boolean;
}): number {
  return subagentRunManager.markSubagentRunTerminated(params);
}

export { prependAgentSteeringPrompt };

const publicApi = createSubagentRegistryPublicApi({
  runs: subagentRuns,
  deps: () => subagentRegistryDeps,
  persist: persistSubagentRuns,
  persistOrThrow: persistSubagentRunsOrThrow,
  restoreOnce: () => subagentRestorer.restoreOnce(),
  startAnnounceCleanup: startSubagentAnnounceCleanupFlow,
  settleRequesterTurn: settleRequesterTurnAfterSessionSpawns,
});

export const leasePendingAgentSteeringItems = publicApi.leasePendingAgentSteeringItems;
export const ackPendingAgentSteeringItems = publicApi.ackPendingAgentSteeringItems;
export const releasePendingAgentSteeringItems = publicApi.releasePendingAgentSteeringItems;
export const listSubagentRunsForController = publicApi.listSubagentRunsForController;
export const getSubagentRunByRunId = publicApi.getSubagentRunByRunId;
export const getSubagentRunsByRunIds = publicApi.getSubagentRunsByRunIds;
export const completeCollectorLaunchCleanup = publicApi.completeCollectorLaunchCleanup;
export const recordSwarmStructuredOutput = publicApi.recordSwarmStructuredOutput;
export const listSwarmRunsForGroup = publicApi.listSwarmRunsForGroup;
export const getSwarmRunByLaunchReplayKey = publicApi.getSwarmRunByLaunchReplayKey;
export const countActiveRunsForSession = publicApi.countActiveRunsForSession;
export const countActiveDescendantRuns = publicApi.countActiveDescendantRuns;
export const countPendingDescendantRuns = publicApi.countPendingDescendantRuns;
export const listDescendantRunsForRequester = publicApi.listDescendantRunsForRequester;
export const getSubagentRunByChildSessionKey = publicApi.getSubagentRunByChildSessionKey;
export const getLatestSubagentRunByChildSessionKey =
  publicApi.getLatestSubagentRunByChildSessionKey;
export function initSubagentRegistry() {
  const state = getSubagentRegistryBootstrapState();
  if (!state.ready || !state.restorer) {
    state.pending = true;
    return;
  }
  state.restorer.restoreOnce();
}
export const settleRequesterAfterSessionSpawns = publicApi.settleRequesterAfterSessionSpawns;
export const markRequesterTurnYielded = publicApi.markRequesterTurnYielded;

const bootstrapState = getSubagentRegistryBootstrapState();
bootstrapState.restorer = subagentRestorer;
bootstrapState.ready = true;
if (bootstrapState.pending) {
  bootstrapState.pending = false;
  subagentRestorer.restoreOnce();
}

const SUBAGENT_REGISTRY_TEST_HANDLE = Symbol.for("openclaw.subagentRegistryTestApi");
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[SUBAGENT_REGISTRY_TEST_HANDLE] = {
    addSubagentRunForTests,
    finalizeInterruptedSubagentRun: completionRuntime.finalizeInterruptedSubagentRun,
    releaseSubagentRun,
    resetSubagentRegistryForTests,
    testing,
  };
}

// Register the subagent maintenance preserve-key provider as a module side effect.
import "./subagent-registry-maintenance.js";
