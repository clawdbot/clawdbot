import pLimit from "p-limit";
import { runWithGatewayIndependentRootWorkContinuation } from "../../../process/gateway-work-admission.js";
import type { AcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import {
  ensureCompletionState,
  ensureDeliveryState,
  getDeliveryLastError,
} from "./subagent-delivery-state.js";
import {
  finalizeResumedAnnounceGiveUp,
  retryDeferredCompletedAnnounces,
  startSubagentAnnounceCleanupFlow,
} from "./subagent-registry-lifecycle-announce-cleanup.js";
import { completeSubagentRunAttempt } from "./subagent-registry-lifecycle-completion.js";
import type {
  CleanupBookkeepingParams,
  ScheduledRequesterSettleWake,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle-context.js";
import { refreshFrozenResultFromSession } from "./subagent-registry-lifecycle-delivery.js";
import {
  completeCleanupBookkeeping,
  scheduleRequesterSettleWake,
} from "./subagent-registry-lifecycle-wake.js";
import { settleRequesterTurnAfterSessionSpawns } from "./subagent-registry-requester-yield.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";

export type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle-context.js";

// Restored rows can arrive in a large burst. Limit only that startup catch-up
// so ordinary live settles keep their existing latency and concurrency.
const RESTORED_REQUESTER_SETTLE_WAKE_CONCURRENCY = 2;

export class SubagentLifecycleController {
  private readonly scheduledResumeTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly pendingRequesterSettleWakeRearms = new Set<string>();
  private readonly scheduledRequesterSettleWakeRuns = new Set<string>();
  private readonly restoredRequesterSettleWakeRuns = new Set<string>();
  private readonly restoredRequesterSettleWakeLimit = pLimit(
    RESTORED_REQUESTER_SETTLE_WAKE_CONCURRENCY,
  );
  private readonly scheduledRequesterSettleWakeTimers = new Map<
    string,
    ScheduledRequesterSettleWake
  >();
  private readonly terminalCompletionLocks = new Map<string, Promise<void>>();
  private readonly terminalGenerations = new WeakMap<SubagentRunRecord, number>();
  private readonly cleanupGenerations = new WeakMap<SubagentRunRecord, number>();
  private readonly progressEndedEntries = new WeakSet<SubagentRunRecord>();
  private readonly cleanupFailureCounts = new WeakMap<SubagentRunRecord, number>();

  constructor(readonly options: SubagentLifecycleOptions) {}

  newerGenerationOwnsSession(entry: SubagentRunRecord): boolean {
    return (
      entry.killReconciliation?.supersededAt !== undefined ||
      Array.from(this.options.runs.values()).some(
        (candidate) =>
          candidate.runId !== entry.runId &&
          candidate.childSessionKey === entry.childSessionKey &&
          compareSubagentRunGeneration(candidate, entry) > 0,
      )
    );
  }

  async acquireTerminalCompletionLock(runId: string): Promise<() => void> {
    const previous = this.terminalCompletionLocks.get(runId) ?? Promise.resolve();
    let releaseLock = () => {};
    const current = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    this.terminalCompletionLocks.set(runId, current);
    await previous;
    return () => {
      releaseLock();
      if (this.terminalCompletionLocks.get(runId) === current) {
        this.terminalCompletionLocks.delete(runId);
      }
    };
  }

  clearScheduledResumeTimers = () => {
    for (const timer of this.scheduledResumeTimers) {
      clearTimeout(timer);
    }
    this.scheduledResumeTimers.clear();
    for (const scheduled of this.scheduledRequesterSettleWakeTimers.values()) {
      clearTimeout(scheduled.timer);
    }
    this.scheduledRequesterSettleWakeTimers.clear();
    this.pendingRequesterSettleWakeRearms.clear();
  };

  addScheduledResumeTimer = (timer: ReturnType<typeof setTimeout>): void =>
    void this.scheduledResumeTimers.add(timer);
  deleteScheduledResumeTimer = (timer: ReturnType<typeof setTimeout>): void =>
    void this.scheduledResumeTimers.delete(timer);

  bumpCleanupGeneration(entry: SubagentRunRecord): number {
    const generation = (this.cleanupGenerations.get(entry) ?? 0) + 1;
    this.cleanupGenerations.set(entry, generation);
    return generation;
  }

  isCleanupGeneration = (entry: SubagentRunRecord, generation: number): boolean =>
    this.cleanupGenerations.get(entry) === generation;
  isCleanupGenerationCurrent = (
    runId: string,
    entry: SubagentRunRecord,
    generation: number,
  ): boolean =>
    this.options.runs.get(runId) === entry &&
    entry.pauseReason !== "sessions_yield" &&
    this.isCleanupGeneration(entry, generation) &&
    !this.newerGenerationOwnsSession(entry);
  isCleanupAttemptCurrent = (
    runId: string,
    entry: SubagentRunRecord,
    generation: number,
  ): boolean =>
    entry.cleanupHandled === true && this.isCleanupGenerationCurrent(runId, entry, generation);
  isEndedHookOwnerCurrent = (runId: string, entry: SubagentRunRecord): boolean => {
    const current = this.options.runs.get(runId);
    return (current === undefined || current === entry) && !this.newerGenerationOwnsSession(entry);
  };

  bumpTerminalGeneration(entry: SubagentRunRecord): number {
    const generation = (this.terminalGenerations.get(entry) ?? 0) + 1;
    this.terminalGenerations.set(entry, generation);
    return generation;
  }

  isTerminalCallbackCurrent = (
    runId: string,
    entry: SubagentRunRecord,
    generation: number,
  ): boolean =>
    this.options.runs.get(runId) === entry &&
    entry.pauseReason !== "sessions_yield" &&
    this.terminalGenerations.get(entry) === generation;
  hasProgressEnded = (entry: SubagentRunRecord): boolean => this.progressEndedEntries.has(entry);
  markProgressEnded = (entry: SubagentRunRecord): void => void this.progressEndedEntries.add(entry);
  clearCleanupFailureCount = (entry: SubagentRunRecord): void =>
    void this.cleanupFailureCounts.delete(entry);

  incrementCleanupFailureCount(entry: SubagentRunRecord): number {
    const count = (this.cleanupFailureCounts.get(entry) ?? 0) + 1;
    this.cleanupFailureCounts.set(entry, count);
    return count;
  }

  getRequesterSettleWakeTimer = (runId: string): ScheduledRequesterSettleWake | undefined =>
    this.scheduledRequesterSettleWakeTimers.get(runId);
  setRequesterSettleWakeTimer = (runId: string, value: ScheduledRequesterSettleWake): void =>
    void this.scheduledRequesterSettleWakeTimers.set(runId, value);
  deleteRequesterSettleWakeTimer = (runId: string): void =>
    void this.scheduledRequesterSettleWakeTimers.delete(runId);
  hasScheduledRequesterSettleWakeRun = (runId: string): boolean =>
    this.scheduledRequesterSettleWakeRuns.has(runId);
  markRequesterSettleWakeRunScheduled = (runId: string): void =>
    void this.scheduledRequesterSettleWakeRuns.add(runId);
  runRequesterSettleWake = (runId: string, run: () => Promise<unknown>): Promise<unknown> =>
    this.restoredRequesterSettleWakeRuns.delete(runId)
      ? this.restoredRequesterSettleWakeLimit(run)
      : run();
  unmarkRequesterSettleWakeRunScheduled = (runId: string): void =>
    void this.scheduledRequesterSettleWakeRuns.delete(runId);
  markRequesterSettleWakeRearm = (runId: string): void =>
    void this.pendingRequesterSettleWakeRearms.add(runId);
  takeRequesterSettleWakeRearm = (runId: string): boolean =>
    this.pendingRequesterSettleWakeRearms.delete(runId);

  completeSubagentRun = async (completeParams: SubagentCompletionRequest) => {
    // Task finalization can make the run disappear from suspension blockers
    // before browser/MCP retirement and cleanup delivery hand off. Own this
    // entire transition as an independent root so that boundary stays atomic.
    // Callers can detach while retaining parent ALS, so nesting is intentional.
    await runWithGatewayIndependentRootWorkContinuation(async () => {
      await completeSubagentRunAttempt(this, completeParams);
    });
  };

  completeCleanupBookkeeping = (params: CleanupBookkeepingParams) => {
    completeCleanupBookkeeping(this, params, (excludeRunId) =>
      retryDeferredCompletedAnnounces(this, excludeRunId),
    );
  };

  static discardTerminalDelivery(
    this: void,
    entry: SubagentRunRecord,
    completedAt: number,
    reason: "dismissed" | "expired" = "dismissed",
  ): void {
    const delivery = ensureDeliveryState(entry);
    const payload = delivery.payload;
    if (reason === "dismissed") {
      delivery.disposition = "intentional_non_delivery";
      delivery.dismissedAt = completedAt;
    } else {
      delivery.discardedAt = completedAt;
      delivery.discardReason = "expired";
      delivery.discardedPayloadSummary = {
        requesterSessionKey: payload?.requesterSessionKey ?? entry.requesterSessionKey,
        childSessionKey: payload?.childSessionKey ?? entry.childSessionKey,
        childRunId: payload?.childRunId ?? entry.runId,
        endedAt: payload?.endedAt ?? entry.execution.endedAt,
        status: payload?.outcome?.status ?? entry.execution.outcome?.status,
        lastError: getDeliveryLastError(entry) ?? null,
      };
    }
    Object.assign(delivery, { status: "discarded", queueId: undefined, nextAttemptAt: undefined });
    delivery.payload = undefined;
    Object.assign(delivery, { createdAt: undefined, lastAttemptAt: undefined });
    Object.assign(delivery, {
      attemptCount: undefined,
      lastError: undefined,
      announcedAt: undefined,
    });
    Object.assign(delivery, { suspendedAt: undefined, suspendedReason: undefined });
    Object.assign(entry, { wakeOnDescendantSettle: undefined, cleanupHandled: true });
    const completion = ensureCompletionState(entry);
    Object.assign(completion, { fallbackResultText: undefined, fallbackCapturedAt: undefined });
    entry.cleanupCompletedAt = completedAt;
  }

  finalizeResumedAnnounceGiveUp = (params: Parameters<typeof finalizeResumedAnnounceGiveUp>[1]) =>
    finalizeResumedAnnounceGiveUp(this, params);

  refreshFrozenResultFromSession = (sessionKey: string) =>
    refreshFrozenResultFromSession(this, sessionKey);

  resumeRequesterSettleWake = (
    runId: string,
    entry: SubagentRunRecord,
    source: "live" | "restore" = "live",
  ) => {
    if (source === "restore" && !this.hasScheduledRequesterSettleWakeRun(runId)) {
      this.restoredRequesterSettleWakeRuns.add(runId);
    }
    scheduleRequesterSettleWake(this, runId, entry);
  };

  settleRequesterTurnAfterSessionSpawns = (
    args: {
      requesterSessionKey: string;
      requesterAgentId?: string;
      requesterTurnRunId: string;
      requesterYielded: boolean;
      acceptedSessionSpawns: readonly AcceptedSessionSpawn[];
    },
    source: "live" | "restore" = "live",
  ) =>
    settleRequesterTurnAfterSessionSpawns({
      ...args,
      runs: this.options.runs,
      persistOrThrow: (...runIds) => this.options.persistOrThrow(...runIds),
      schedule: (runId, entry) => {
        if (this.hasScheduledRequesterSettleWakeRun(runId)) {
          this.markRequesterSettleWakeRearm(runId);
          return;
        }
        if (source === "restore") {
          this.restoredRequesterSettleWakeRuns.add(runId);
        }
        scheduleRequesterSettleWake(this, runId, entry);
      },
    });

  startSubagentAnnounceCleanupFlow = (runId: string, entry: SubagentRunRecord): boolean =>
    startSubagentAnnounceCleanupFlow(this, runId, entry);
}
