import type { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngine, SubagentEndReason } from "../context-engine/types.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { importRuntimeModule } from "../shared/runtime-import.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { ensureRuntimePluginsLoaded as ensureRuntimePluginsLoadedFn } from "./runtime-plugins.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import { resetAnnounceQueuesForTests } from "./subagent-announce-queue.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import {
  emitSubagentEndedHookOnce,
  resolveLifecycleOutcomeFromRunOutcome,
} from "./subagent-registry-completion.js";
import {
  ANNOUNCE_EXPIRY_MS,
  MAX_ANNOUNCE_RETRY_COUNT,
  reconcileOrphanedRestoredRuns,
  reconcileOrphanedRun,
  resolveAnnounceRetryDelayMs,
  resolveSubagentRunOrphanReason,
  resolveSubagentSessionStatus,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import { createSubagentRegistryLifecycleController } from "./subagent-registry-lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  countActiveDescendantRunsFromRuns,
  countActiveRunsForSessionFromRuns,
  countPendingDescendantRunsExcludingRunFromRuns,
  countPendingDescendantRunsFromRuns,
  getSubagentRunByChildSessionKeyFromRuns,
  isSubagentSessionRunActiveFromRuns,
  listRunsForControllerFromRuns,
  listDescendantRunsForRequesterFromRuns,
  listRunsForRequesterFromRuns,
  resolveRequesterForChildSessionFromRuns,
  shouldIgnorePostCompletionAnnounceForSessionFromRuns,
} from "./subagent-registry-queries.js";
import {
  createSubagentRunManager,
  type RegisterSubagentRunParams,
} from "./subagent-registry-run-manager.js";
import {
  getSubagentRunsSnapshotForRead,
  persistSubagentRunsToDisk,
  restoreSubagentRunsFromDisk,
} from "./subagent-registry-state.js";
import { configureSubagentRegistrySteerRuntime } from "./subagent-registry-steer-runtime.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { resolveAgentTimeoutMs } from "./timeout.js";

export type { SubagentRunRecord } from "./subagent-registry.types.js";
export {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentSessionStatus,
} from "./subagent-registry-helpers.js";
const log = createSubsystemLogger("agents/subagent-registry");

type SubagentAnnounceModule = Pick<
  typeof import("./subagent-announce.js"),
  "captureSubagentCompletionReply" | "runSubagentAnnounceFlow"
>;
type BrowserCleanupModule = Pick<
  typeof import("../browser-lifecycle-cleanup.js"),
  "cleanupBrowserSessionsForLifecycleEnd"
>;

type SubagentRegistryDeps = {
  callGateway: typeof callGateway;
  captureSubagentCompletionReply: SubagentAnnounceModule["captureSubagentCompletionReply"];
  cleanupBrowserSessionsForLifecycleEnd: typeof cleanupBrowserSessionsForLifecycleEnd;
  getSubagentRunsSnapshotForRead: typeof getSubagentRunsSnapshotForRead;
  loadConfig: typeof loadConfig;
  onAgentEvent: typeof onAgentEvent;
  persistSubagentRunsToDisk: typeof persistSubagentRunsToDisk;
  resolveAgentTimeoutMs: typeof resolveAgentTimeoutMs;
  restoreSubagentRunsFromDisk: typeof restoreSubagentRunsFromDisk;
  runSubagentAnnounceFlow: SubagentAnnounceModule["runSubagentAnnounceFlow"];
  ensureContextEnginesInitialized?: () => void;
  ensureRuntimePluginsLoaded?: typeof ensureRuntimePluginsLoadedFn;
  resolveContextEngine?: (cfg: OpenClawConfig) => Promise<ContextEngine>;
};

let subagentAnnouncePromise: Promise<SubagentAnnounceModule> | null = null;
let browserCleanupPromise: Promise<BrowserCleanupModule> | null = null;

async function loadSubagentAnnounceModule(): Promise<SubagentAnnounceModule> {
  subagentAnnouncePromise ??= import("./subagent-announce.js");
  return await subagentAnnouncePromise;
}

async function loadCleanupBrowserSessionsForLifecycleEnd(): Promise<
  BrowserCleanupModule["cleanupBrowserSessionsForLifecycleEnd"]
> {
  browserCleanupPromise ??= import("../browser-lifecycle-cleanup.js");
  return (await browserCleanupPromise).cleanupBrowserSessionsForLifecycleEnd;
}

const defaultSubagentRegistryDeps: SubagentRegistryDeps = {
  callGateway,
  captureSubagentCompletionReply: async (sessionKey, options) =>
    (await loadSubagentAnnounceModule()).captureSubagentCompletionReply(sessionKey, options),
  cleanupBrowserSessionsForLifecycleEnd: async (params) =>
    (await loadCleanupBrowserSessionsForLifecycleEnd())(params),
  getSubagentRunsSnapshotForRead,
  loadConfig,
  onAgentEvent,
  persistSubagentRunsToDisk,
  resolveAgentTimeoutMs,
  restoreSubagentRunsFromDisk,
  runSubagentAnnounceFlow: async (params) =>
    (await loadSubagentAnnounceModule()).runSubagentAnnounceFlow(params),
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
    resolveContextEngine: (cfg: OpenClawConfig) => Promise<ContextEngine>;
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

let contextEngineInitPromise: Promise<ContextEngineInitModule> | null = null;
let contextEngineRegistryPromise: Promise<ContextEngineRegistryModule> | null = null;
let runtimePluginsPromise: Promise<RuntimePluginsModule> | null = null;

let sweeper: NodeJS.Timeout | null = null;
const resumeRetryTimers = new Set<ReturnType<typeof setTimeout>>();
let sweepInProgress = false;
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
// Use var to avoid TDZ when init runs across circular imports during bootstrap.
var restoreAttempted = false;
const ORPHAN_RECOVERY_DEBOUNCE_MS = 1_000;
let lastOrphanRecoveryScheduleAt = 0;
const SUBAGENT_ANNOUNCE_TIMEOUT_MS = 120_000;
/**
 * Embedded runs can emit transient lifecycle `error` events while provider/model
 * retry is still in progress. Defer terminal error cleanup briefly so a
 * subsequent lifecycle `start` / `end` can cancel premature failure announces.
 */
const LIFECYCLE_ERROR_RETRY_GRACE_MS = 15_000;
/** Absolute TTL for session-mode runs after cleanup completes (no archiveAtMs). */
const SESSION_RUN_TTL_MS = 5 * 60_000; // 5 minutes
/** Absolute TTL for orphaned pendingLifecycleError entries. */
const PENDING_ERROR_TTL_MS = 5 * 60_000; // 5 minutes

function loadContextEngineInitModule(): Promise<ContextEngineInitModule> {
  contextEngineInitPromise ??= importRuntimeModule<ContextEngineInitModule>(
    import.meta.url,
    SUBAGENT_REGISTRY_RUNTIME_SPEC,
  );
  return contextEngineInitPromise;
}

function loadContextEngineRegistryModule(): Promise<ContextEngineRegistryModule> {
  contextEngineRegistryPromise ??= importRuntimeModule<ContextEngineRegistryModule>(
    import.meta.url,
    SUBAGENT_REGISTRY_RUNTIME_SPEC,
  );
  return contextEngineRegistryPromise;
}

function loadRuntimePluginsModule(): Promise<RuntimePluginsModule> {
  runtimePluginsPromise ??= importRuntimeModule<RuntimePluginsModule>(
    import.meta.url,
    SUBAGENT_REGISTRY_RUNTIME_SPEC,
  );
  return runtimePluginsPromise;
}

async function ensureSubagentRegistryPluginRuntimeLoaded(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  allowGatewaySubagentBinding?: boolean;
}) {
  const ensureRuntimePluginsLoaded = subagentRegistryDeps.ensureRuntimePluginsLoaded;
  if (ensureRuntimePluginsLoaded) {
    ensureRuntimePluginsLoaded(params);
    return;
  }
  (await loadRuntimePluginsModule()).ensureRuntimePluginsLoaded(params);
}

async function resolveSubagentRegistryContextEngine(cfg: OpenClawConfig) {
  const initModule = await loadContextEngineInitModule();
  const registryModule = await loadContextEngineRegistryModule();
  const ensureContextEnginesInitialized =
    subagentRegistryDeps.ensureContextEnginesInitialized ??
    initModule.ensureContextEnginesInitialized;
  const resolveContextEngine =
    subagentRegistryDeps.resolveContextEngine ?? registryModule.resolveContextEngine;
  ensureContextEnginesInitialized();
  return await resolveContextEngine(cfg);
}

function persistSubagentRuns() {
  subagentRegistryDeps.persistSubagentRunsToDisk(subagentRuns);
}

export function scheduleSubagentOrphanRecovery(params?: { delayMs?: number; maxRetries?: number }) {
  const now = Date.now();
  if (now - lastOrphanRecoveryScheduleAt < ORPHAN_RECOVERY_DEBOUNCE_MS) {
    return;
  }
  lastOrphanRecoveryScheduleAt = now;
  void import("./subagent-orphan-recovery.js").then(
    ({ scheduleOrphanRecovery }) => {
      scheduleOrphanRecovery({
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
    error?: string;
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

function schedulePendingLifecycleError(params: { runId: string; endedAt: number; error?: string }) {
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
    void completeSubagentRun({
      runId: params.runId,
      endedAt: pending.endedAt,
      outcome: {
        status: "error",
        error: pending.error,
      },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      sendFarewell: true,
      accountId: entry.requesterOrigin?.accountId,
      triggerCleanup: true,
    });
  }, LIFECYCLE_ERROR_RETRY_GRACE_MS);
  timer.unref?.();
  pendingLifecycleErrorByRunId.set(params.runId, {
    timer,
    endedAt: params.endedAt,
    error: params.error,
  });
}

async function notifyContextEngineSubagentEnded(params: {
  childSessionKey: string;
  reason: SubagentEndReason;
  workspaceDir?: string;
}) {
  try {
    const cfg = subagentRegistryDeps.loadConfig();
    await ensureSubagentRegistryPluginRuntimeLoaded({
      config: cfg,
      workspaceDir: params.workspaceDir,
      allowGatewaySubagentBinding: true,
    });
    const engine = await resolveSubagentRegistryContextEngine(cfg);
    if (!engine.onSubagentEnded) {
      return;
    }
    await engine.onSubagentEnded(params);
  } catch (err) {
    log.warn("context-engine onSubagentEnded failed (best-effort)", { err });
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
}) {
  if (params.entry.endedHookEmittedAt) {
    return;
  }
  const cfg = subagentRegistryDeps.loadConfig();
  await ensureSubagentRegistryPluginRuntimeLoaded({
    config: cfg,
    workspaceDir: params.entry.workspaceDir,
    allowGatewaySubagentBinding: true,
  });
  const reason = params.reason ?? params.entry.endedReason ?? SUBAGENT_ENDED_REASON_COMPLETE;
  const outcome = resolveLifecycleOutcomeFromRunOutcome(params.entry.outcome);
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
  clearPendingLifecycleError,
  countPendingDescendantRuns,
  suppressAnnounceForSteerRestart,
  shouldEmitEndedHookForRun,
  emitSubagentEndedHookForRun,
  notifyContextEngineSubagentEnded,
  resumeSubagentRun,
  captureSubagentCompletionReply: (sessionKey, options) =>
    subagentRegistryDeps.captureSubagentCompletionReply(sessionKey, options),
  cleanupBrowserSessionsForLifecycleEnd: (args) =>
    subagentRegistryDeps.cleanupBrowserSessionsForLifecycleEnd(args),
  runSubagentAnnounceFlow: (params) => subagentRegistryDeps.runSubagentAnnounceFlow(params),
  warn: (message, meta) => log.warn(message, meta),
});

const {
  clearScheduledResumeTimers,
  completeCleanupBookkeeping,
  completeSubagentRun,
  finalizeResumedAnnounceGiveUp,
  refreshFrozenResultFromSession,
  startSubagentAnnounceCleanupFlow,
} = subagentLifecycleController;

function resumeSubagentRun(runId: string) {
  if (!runId || resumedRuns.has(runId)) {
    return;
  }
  const entry = subagentRuns.get(runId);
  if (!entry) {
    return;
  }
  if (entry.cleanupCompletedAt) {
    return;
  }
  // Skip entries that have exhausted their retry budget or expired (#18264).
  if ((entry.announceRetryCount ?? 0) >= MAX_ANNOUNCE_RETRY_COUNT) {
    void finalizeResumedAnnounceGiveUp({
      runId,
      entry,
      reason: "retry-limit",
    });
    return;
  }
  if (
    entry.expectsCompletionMessage !== true &&
    typeof entry.endedAt === "number" &&
    Date.now() - entry.endedAt > ANNOUNCE_EXPIRY_MS
  ) {
    void finalizeResumedAnnounceGiveUp({
      runId,
      entry,
      reason: "expiry",
    });
    return;
  }

  const now = Date.now();
  const delayMs = resolveAnnounceRetryDelayMs(entry.announceRetryCount ?? 0);
  const earliestRetryAt = (entry.lastAnnounceRetryAt ?? 0) + delayMs;
  if (
    entry.expectsCompletionMessage === true &&
    entry.lastAnnounceRetryAt &&
    now < earliestRetryAt
  ) {
    const waitMs = Math.max(1, earliestRetryAt - now);
    const scheduledEntry = entry;
    const timer = setTimeout(() => {
      resumeRetryTimers.delete(timer);
      if (subagentRuns.get(runId) !== scheduledEntry) {
        return;
      }
      resumedRuns.delete(runId);
      resumeSubagentRun(runId);
    }, waitMs);
    timer.unref?.();
    resumeRetryTimers.add(timer);
    resumedRuns.add(runId);
    return;
  }

  if (typeof entry.endedAt === "number" && entry.endedAt > 0) {
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
  const cfg = subagentRegistryDeps.loadConfig();
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, entry.runTimeoutSeconds);
  void subagentRunManager.waitForSubagentCompletion(runId, waitTimeoutMs, entry);
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
    if (subagentRuns.size === 0) {
      return;
    }
    // Resume pending work.
    ensureListener();
    // Always start sweeper — session-mode runs (no archiveAtMs) also need TTL cleanup.
    startSweeper();
    for (const runId of subagentRuns.keys()) {
      resumeSubagentRun(runId);
    }

    // Cold-start restore path: queue the same recovery pass that restart
    // startup also uses so resumed children are handled through one seam.
    scheduleSubagentOrphanRecovery();
  } catch {
    // ignore restore failures
  }
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
    void sweepSubagentRuns();
  }, 60_000);
  sweeper.unref?.();
}

function stopSweeper() {
  if (!sweeper) {
    return;
  }
  clearInterval(sweeper);
  sweeper = null;
}

async function sweepSubagentRuns() {
  if (sweepInProgress) {
    return;
  }
  sweepInProgress = true;
  try {
    const now = Date.now();
    let mutated = false;
    for (const [runId, entry] of subagentRuns.entries()) {
      // Session-mode runs have no archiveAtMs — apply absolute TTL after cleanup completes.
      // Use cleanupCompletedAt (not endedAt) to avoid interrupting deferred cleanup flows.
      if (!entry.archiveAtMs) {
        if (
          typeof entry.cleanupCompletedAt === "number" &&
          now - entry.cleanupCompletedAt > SESSION_RUN_TTL_MS
        ) {
          clearPendingLifecycleError(runId);
          void notifyContextEngineSubagentEnded({
            childSessionKey: entry.childSessionKey,
            reason: "swept",
            workspaceDir: entry.workspaceDir,
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
      void notifyContextEngineSubagentEnded({
        childSessionKey: entry.childSessionKey,
        reason: "swept",
        workspaceDir: entry.workspaceDir,
      });
    }
    // Sweep orphaned pendingLifecycleError entries (absolute TTL).
    for (const [runId, pending] of pendingLifecycleErrorByRunId.entries()) {
      if (now - pending.endedAt > PENDING_ERROR_TTL_MS) {
        clearPendingLifecycleError(runId);
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
          await refreshFrozenResultFromSession(evt.sessionKey);
        }
        return;
      }
      if (phase === "start") {
        clearPendingLifecycleError(evt.runId);
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
      const error = typeof evt.data?.error === "string" ? evt.data.error : undefined;
      if (phase === "error") {
        schedulePendingLifecycleError({
          runId: evt.runId,
          endedAt,
          error,
        });
        return;
      }
      clearPendingLifecycleError(evt.runId);
      const outcome: SubagentRunOutcome = evt.data?.aborted
        ? { status: "timeout" }
        : { status: "ok" };
      await completeSubagentRun({
        runId: evt.runId,
        endedAt,
        outcome,
        reason: SUBAGENT_ENDED_REASON_COMPLETE,
        sendFarewell: true,
        accountId: entry.requesterOrigin?.accountId,
        triggerCleanup: true,
      });
    })();
  });
}

const subagentRunManager = createSubagentRunManager({
  runs: subagentRuns,
  resumedRuns,
  endedHookInFlightRunIds,
  persist: persistSubagentRuns,
  callGateway: (request) => subagentRegistryDeps.callGateway(request),
  loadConfig: () => subagentRegistryDeps.loadConfig(),
  ensureRuntimePluginsLoaded: (args: {
    config: OpenClawConfig;
    workspaceDir?: string;
    allowGatewaySubagentBinding?: boolean;
  }) => ensureSubagentRegistryPluginRuntimeLoaded(args),
  ensureListener,
  startSweeper,
  stopSweeper,
  resumeSubagentRun,
  clearPendingLifecycleError,
  resolveSubagentWaitTimeoutMs,
  notifyContextEngineSubagentEnded,
  completeCleanupBookkeeping,
  completeSubagentRun,
});

configureSubagentRegistrySteerRuntime({
  replaceSubagentRunAfterSteer: (params) => subagentRunManager.replaceSubagentRunAfterSteer(params),
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
}) {
  return subagentRunManager.replaceSubagentRunAfterSteer(params);
}

export function registerSubagentRun(params: RegisterSubagentRunParams) {
  subagentRunManager.registerSubagentRun(params);
}

export function resetSubagentRegistryForTests(opts?: { persist?: boolean }) {
  clearScheduledResumeTimers();
  for (const timer of resumeRetryTimers) {
    clearTimeout(timer);
  }
  resumeRetryTimers.clear();
  subagentRuns.clear();
  resumedRuns.clear();
  endedHookInFlightRunIds.clear();
  clearAllPendingLifecycleErrors();
  contextEngineInitPromise = null;
  contextEngineRegistryPromise = null;
  runtimePluginsPromise = null;
  subagentAnnouncePromise = null;
  browserCleanupPromise = null;
  resetAnnounceQueuesForTests();
  stopSweeper();
  sweepInProgress = false;
  restoreAttempted = false;
  if (listenerStop) {
    listenerStop();
    listenerStop = null;
  }
  listenerStarted = false;
  if (opts?.persist !== false) {
    persistSubagentRuns();
  }
}

export const __testing = {
  setDepsForTest(overrides?: Partial<SubagentRegistryDeps>) {
    subagentRegistryDeps = overrides
      ? {
          ...defaultSubagentRegistryDeps,
          ...overrides,
        }
      : defaultSubagentRegistryDeps;
  },
} as const;

export function addSubagentRunForTests(entry: SubagentRunRecord) {
  subagentRuns.set(entry.runId, entry);
}

export function releaseSubagentRun(runId: string) {
  subagentRunManager.releaseSubagentRun(runId);
}

export function resolveRequesterForChildSession(childSessionKey: string): {
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
} | null {
  const runsSnapshot = subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns);
  const resolved = resolveRequesterForChildSessionFromRuns(runsSnapshot, childSessionKey);
  if (resolved === null) {
    return null;
  }
  const requesterOrigin = normalizeDeliveryContext(resolved.requesterOrigin);
  return {
    requesterSessionKey: resolved.requesterSessionKey,
    requesterOrigin,
  };
}

export function isSubagentSessionRunActive(childSessionKey: string): boolean {
  return isSubagentSessionRunActiveFromRuns(subagentRuns, childSessionKey);
}

export function shouldIgnorePostCompletionAnnounceForSession(childSessionKey: string): boolean {
  return shouldIgnorePostCompletionAnnounceForSessionFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
}

export function markSubagentRunTerminated(params: {
  runId?: string;
  childSessionKey?: string;
  reason?: string;
}): number {
  return subagentRunManager.markSubagentRunTerminated(params);
}

export function listSubagentRunsForRequester(
  requesterSessionKey: string,
  options?: { requesterRunId?: string },
): SubagentRunRecord[] {
  return listRunsForRequesterFromRuns(subagentRuns, requesterSessionKey, options);
}

export function listSubagentRunsForController(controllerSessionKey: string): SubagentRunRecord[] {
  return listRunsForControllerFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    controllerSessionKey,
  );
}

export function countActiveRunsForSession(requesterSessionKey: string): number {
  return countActiveRunsForSessionFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    requesterSessionKey,
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

export function countPendingDescendantRunsExcludingRun(
  rootSessionKey: string,
  excludeRunId: string,
): number {
  return countPendingDescendantRunsExcludingRunFromRuns(
    subagentRegistryDeps.getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
    excludeRunId,
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
    if (!latest || entry.createdAt > latest.createdAt) {
      latest = entry;
    }
  }

  return latest;
}

export function initSubagentRegistry() {
  restoreSubagentRunsOnce();
}
