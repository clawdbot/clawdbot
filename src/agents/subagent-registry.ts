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
import { isDeliverySuspended } from "./subagent-delivery-state.js";
import { createSubagentRegistryCompletionRuntime } from "./subagent-registry-completion-runtime.js";
import { emitSubagentProgressEndedHook } from "./subagent-registry-completion.js";
import { createSubagentRegistryContextCleanup } from "./subagent-registry-context-cleanup.js";
import {
  resetSubagentRegistryRuntimeLoadersForTests,
  setSubagentRegistryDepsForTest,
  subagentRegistryDeps,
  type SubagentRegistryDeps,
} from "./subagent-registry-deps.js";
import { ANNOUNCE_EXPIRY_MS, reconcileOrphanedRun } from "./subagent-registry-helpers.js";
import { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import { createSubagentRegistryListener } from "./subagent-registry-listener.js";
import {
  getSubagentRunsForChildSession,
  getSubagentRunsForCollectorGroup,
  subagentRuns,
} from "./subagent-registry-memory.js";
import { createSubagentRegistryPublicApi } from "./subagent-registry-public-api.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "./subagent-registry-read.js";
import { createSubagentRegistryRestorer } from "./subagent-registry-restore.js";
import {
  createSubagentRunManager,
  type RegisterSubagentRunParams,
} from "./subagent-registry-run-manager.js";
import { clearSubagentRunsReadCacheForTest } from "./subagent-registry-state.js";
import { SUBAGENT_SUSPENDED_DELIVERY_HARD_CAP } from "./subagent-registry-suspended-delivery.js";
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
import { terminateAcceptedCollectorRun } from "./subagent-spawn-cleanup.js";

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
const SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
const GATEWAY_ADMISSION_RETRY_DELAY_MS = 1_000;
/** Admission pressure for recoverable completion deliveries; rows are never pruned for capacity. */
export function getSubagentDeliveryBacklogPressure(): {
  suspended: number;
  blocked: boolean;
} {
  let suspended = 0;
  for (const entry of subagentRuns.values()) {
    if (isDeliverySuspended(entry)) {
      suspended += 1;
    }
  }
  return { suspended, blocked: suspended >= SUBAGENT_SUSPENDED_DELIVERY_HARD_CAP };
}

// Hot lifecycle callers name every changed or removed row. Zero ids is reserved
// for explicit full-registry replacement at restore/reset boundaries.
function persistSubagentRuns(...runIds: string[]) {
  subagentRegistryDeps.persistSubagentRunsToDisk(
    subagentRuns,
    runIds.length > 0 ? runIds : undefined,
  );
}

function persistSubagentRunsOrThrow(...runIds: string[]) {
  subagentRegistryDeps.persistSubagentRunsToDiskOrThrow(
    subagentRuns,
    runIds.length > 0 ? runIds : undefined,
  );
}

function findSubagentTaskForRun(entry: SubagentRunRecord) {
  return resolveSubagentTaskForRun(getSubagentRunsForChildSession(entry.childSessionKey), entry);
}

export function scheduleSubagentRegistrySweep(params?: { delayMs?: number }) {
  subagentSweeper.schedule(params);
}

const resumedRuns = new Set<string>();

const completionRuntime = createSubagentRegistryCompletionRuntime({
  runs: subagentRuns,
  resumed: resumedRuns,
  retryTimers: resumeRetryTimers,
  completeSubagentRun: (params) => completeSubagentRun(params),
  scheduleSweep: scheduleSubagentRegistrySweep,
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
  reason: "expiry" | "permanent_failure",
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

export function resumeSubagentRun(runId: string) {
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
    typeof entry.execution.endedAt === "number" &&
    !yieldedWakeWaitingForDelivery
  ) {
    resumeRequesterSettleWake(runId, entry);
    return;
  }
  if (entry.cleanupCompletedAt) {
    return;
  }
  if (typeof entry.execution.endedAt === "number" && isDeliverySuspended(entry)) {
    return;
  }
  // Yielded runs stay paused until explicitly steered, except orchestrators
  // waiting on descendants: their settle retry must reach the wake path.
  if (entry.pauseReason === "sessions_yield" && entry.wakeOnDescendantSettle !== true) {
    return;
  }
  // Required completions are deadline-driven; retry count is diagnostic only.
  if (
    entry.expectsCompletionMessage !== true &&
    typeof entry.execution.endedAt === "number" &&
    Date.now() - entry.execution.endedAt > ANNOUNCE_EXPIRY_MS
  ) {
    finalizeResumedAnnounceGiveUpInBackground(runId, entry, "expiry");
    return;
  }

  const now = Date.now();
  const earliestRetryAt = entry.delivery?.nextAttemptAt ?? 0;
  if (entry.expectsCompletionMessage === true && now < earliestRetryAt) {
    const waitMs = Math.max(1, earliestRetryAt - now);
    scheduleSubagentDeliveryResumeRetry(runId, entry, waitMs);
    resumedRuns.add(runId);
    return;
  }

  if (typeof entry.execution.endedAt === "number" && entry.execution.endedAt > 0) {
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
        persistSubagentRuns(runId);
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
  persistOrThrow: persistSubagentRunsOrThrow,
  settleRequesterTurn: settleRequesterTurnAfterSessionSpawns,
  ensureListener: () => subagentListener.ensure(),
  startSweeper: () => subagentSweeper.start(),
  resumeRun: (runId) => resumeSubagentRun(runId),
  listSwarmRunsForGroup: (groupId, requesterSessionKey) =>
    listSwarmRunsForGroup(groupId, requesterSessionKey),
  startQueuedSubagentRun: (runId, gatewayRunId, lifecycleGeneration) =>
    subagentRunManager.startQueuedSubagentRun(runId, gatewayRunId, lifecycleGeneration),
  terminateAcceptedRestoredCollectorRun: ({
    entry,
    gatewayRunId,
    timeoutMs,
    expectedSessionId,
    expectedLifecycleRevision,
  }) =>
    terminateAcceptedCollectorRun({
      childSessionKey: entry.childSessionKey,
      gatewayRunId,
      expectedSessionId,
      expectedLifecycleRevision,
      timeoutMs,
      callGateway: subagentRegistryDeps.callGateway,
    }),
  cleanupCollectorLaunchResources: contextCleanup.cleanupCollectorLaunchResources,
  settleFailedQueuedSubagentLaunch: (runId, error) =>
    subagentRunManager.settleFailedQueuedSubagentLaunch(runId, error),
  completeCollectorLaunchCleanup: (runId) => publicApi.completeCollectorLaunchCleanup(runId),
  scheduleSweep: scheduleSubagentRegistrySweep,
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
    persistOrThrow: persistSubagentRunsOrThrow,
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
  getGatewayRecoveryRuntime: () => subagentRegistryDeps.getGatewayRecoveryRuntime(),
  abandonSubagentRestartRecoveryLaunch: (params) =>
    subagentRunManager.abandonSubagentRestartRecoveryLaunch(params),
  clearAcceptedSubagentRestartRecovery: (params) =>
    subagentRunManager.clearAcceptedSubagentRestartRecovery(params),
  resumeSettledSubagentRestartRecovery: (params) =>
    subagentRunManager.resumeSettledSubagentRestartRecovery(params),
  replaceSubagentRunAfterSteer: (params) => subagentRunManager.replaceSubagentRunAfterSteer(params),
  markSubagentRestartRecoveryLaunchAttempted: (params) =>
    subagentRunManager.markSubagentRestartRecoveryLaunchAttempted(params),
  markSubagentRestartRecoveryLaunchAccepted: (params) =>
    subagentRunManager.markSubagentRestartRecoveryLaunchAccepted(params),
  markSubagentRestartRecoveryLaunchConsumed: (params) =>
    subagentRunManager.markSubagentRestartRecoveryLaunchConsumed(params),
  reserveSubagentRestartRecoveryLaunch: (params) =>
    subagentRunManager.reserveSubagentRestartRecoveryLaunch(params),
  resetSubagentRestartRecoveryLaunchAttempt: (params) =>
    subagentRunManager.resetSubagentRestartRecoveryLaunchAttempt(params),
  finalizeInterruptedSubagentRun: completionRuntime.finalizeInterruptedSubagentRun,
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
  getRunsForChildSession: getSubagentRunsForChildSession,
  getRunsForCollectorGroup: getSubagentRunsForCollectorGroup,
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
  getRunsForChildSession: getSubagentRunsForChildSession,
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
  scheduleSweep: scheduleSubagentRegistrySweep,
  resolveSubagentSessionCompletion,
  resolveSubagentSessionStartedAt,
  notifyContextEngineSubagentEnded: contextCleanup.notifyContextEngineSubagentEnded,
  completeCleanupBookkeeping,
  completeSubagentRun: async (params) => {
    await completionRuntime.completeSubagentRunWithRecovery(params, "subagent-wait");
  },
  resolveSubagentTask: findSubagentTaskForRun,
});

export const markSubagentRunForSteerRestart = subagentRunManager.markSubagentRunForSteerRestart;
export const clearSubagentRunSteerRestart = subagentRunManager.clearSubagentRunSteerRestart;
export const replaceSubagentRunAfterSteer = subagentRunManager.replaceSubagentRunAfterSteer;
export const claimSubagentRunKill = subagentRunManager.claimSubagentRunKill;
export const releaseSubagentRunKillClaim = subagentRunManager.releaseSubagentRunKillClaim;
export const registerSubagentRun: (params: RegisterSubagentRunParams) => void =
  subagentRunManager.registerSubagentRun;
export const startQueuedSubagentRun = subagentRunManager.startQueuedSubagentRun;
export const settleFailedQueuedSubagentLaunch = subagentRunManager.settleFailedQueuedSubagentLaunch;

/**
 * Continues a `sessions_yield`-paused run under a new gateway runId.
 *
 * A follow-up dispatched to a paused child session is the same unit of work as
 * the run that yielded, so it must adopt that row instead of minting a sibling.
 * Registering a new row would move the requester to the child's own main session
 * and strand the original requester's paused row as merely superseded: its
 * announce stays gated on `pauseReason`, and its settle batch keeps deferring
 * because the row still counts as an unsettled descendant. Returns false when no
 * paused row owns the session, leaving ordinary registration to the caller.
 */
export function adoptPausedSubagentRunForFollowUp(params: {
  childSessionKey: string;
  runId: string;
  task: string;
}): boolean {
  const childSessionKey = params.childSessionKey.trim();
  const runId = params.runId.trim();
  if (!childSessionKey || !runId) {
    return false;
  }
  // Select the newest paused row rather than the newest row overall: a
  // requester-bound follow-up stays a sibling at a higher generation, and
  // matching on generation alone would let that sibling hide the paused owner
  // and park its requester for good.
  const paused = getLatestLiveSubagentRunByChildSessionKey(
    childSessionKey,
    (entry) => entry.pauseReason === "sessions_yield",
  );
  if (!paused) {
    return false;
  }
  return subagentRunManager.replaceSubagentRunAfterSteer({
    previousRunId: paused.runId,
    nextRunId: runId,
    expected: paused,
    // A paused row is terminal by construction; adoption is exactly the case the
    // ended-source gate exists to keep out of unrelated replacement callers.
    allowEndedSource: true,
    // The original requester is idle behind its own yield, so its wake credential
    // is the only path back to it once this follow-up settles.
    preserveRequesterSettleWake: true,
    // Gateway admission has not started provider work yet. If this owner swap
    // is not durable, reject the dispatch instead of registering a sibling or
    // leaving a live successor that restart recovery cannot identify.
    persistenceFailure: "throw",
    // Persist the follow-up text so restart recovery cannot reissue the task that
    // the child already yielded on.
    task: params.task,
  });
}

function resetSubagentRegistryForTests(opts?: { persist?: boolean }) {
  clearScheduledResumeTimers();
  for (const timer of resumeRetryTimers) {
    clearTimeout(timer);
  }
  resumeRetryTimers.clear();
  subagentRuns.clear();
  resumedRuns.clear();
  pendingLifecycle.clearAll();
  resetSubagentRegistryRuntimeLoadersForTests();
  contextCleanup.reset();
  clearSubagentRunsReadCacheForTest();
  subagentSweeper.reset();
  subagentRestorer.reset();
  subagentListener.reset();
  if (opts?.persist !== false) {
    persistSubagentRuns();
  }
}

const testing = {
  failQueuedSubagentRun: subagentRunManager.failQueuedSubagentRun,
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

export const markSubagentRunTerminated = subagentRunManager.markSubagentRunTerminated;

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
    releaseSubagentRun: subagentRunManager.releaseSubagentRun,
    resetSubagentRegistryForTests,
    testing,
  };
}

// Register the subagent maintenance preserve-key provider as a module side effect.
import "./subagent-registry-maintenance.js";
