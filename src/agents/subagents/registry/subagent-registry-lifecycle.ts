import type { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { callGateway as defaultCallGateway } from "../../../gateway/call.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import type { DetachedTaskFindResult } from "../../../tasks/detached-task-runtime-contract.js";
import type { AcceptedSessionSpawn } from "../../accepted-session-spawn.js";
import {
  ensureCompletionState,
  ensureDeliveryState,
  getDeliveryLastError,
} from "./subagent-delivery-state.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import {
  finalizeResumedAnnounceGiveUp,
  retryDeferredCompletedAnnounces,
  startSubagentAnnounceCleanupFlow,
} from "./subagent-registry-lifecycle-announce-cleanup.js";
import { completeSubagentRunAttempt } from "./subagent-registry-lifecycle-completion.js";
import { refreshFrozenResultFromSession } from "./subagent-registry-lifecycle-delivery.js";
import {
  completeCleanupBookkeeping,
  scheduleRequesterSettleWake,
  type ScheduledRequesterSettleWake,
} from "./subagent-registry-lifecycle-wake.js";
import { settleRequesterTurnAfterSessionSpawns } from "./subagent-registry-requester-yield.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";

type CaptureSubagentCompletionReply =
  (typeof import("../announce/subagent-announce.js"))["captureSubagentCompletionReply"];
type RunSubagentAnnounceFlow =
  (typeof import("../announce/subagent-announce.js"))["runSubagentAnnounceFlow"];
type MaybeWakeRequesterAfterAllChildrenSettled =
  (typeof import("../announce/subagent-announce.requester-settle-wake.js"))["maybeWakeRequesterAfterAllChildrenSettled"];
type BrowserCleanup = typeof cleanupBrowserSessionsForLifecycleEnd;

export type SubagentLifecycleOptions = {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  subagentAnnounceTimeoutMs: number;
  getRuntimeConfig(): OpenClawConfig;
  persist(...runIds: string[]): void;
  persistOrThrow(...runIds: string[]): void;
  clearPendingLifecycleError(runId: string): void;
  countPendingDescendantRuns(rootSessionKey: string): number;
  suppressAnnounceForSteerRestart(entry?: SubagentRunRecord): boolean;
  resolveSubagentTask(entry: SubagentRunRecord): DetachedTaskFindResult;
  shouldEmitEndedHookForRun(args: {
    entry: SubagentRunRecord;
    reason: SubagentLifecycleEndedReason;
  }): boolean;
  emitSubagentEndedHookForRun(args: {
    entry: SubagentRunRecord;
    reason?: SubagentLifecycleEndedReason;
    sendFarewell?: boolean;
    accountId?: string;
    isCurrent?: () => boolean;
  }): Promise<void>;
  emitSubagentProgressEndedForRun(entry: SubagentRunRecord): Promise<void>;
  notifyContextEngineSubagentEnded(
    args: {
      childSessionKey: string;
      reason: "completed" | "deleted";
      agentDir?: string;
      workspaceDir?: string;
    },
    options?: { isCurrent?: () => boolean },
  ): Promise<void>;
  retireSupersededRun(runId: string, entry: SubagentRunRecord): Promise<void>;
  resumeSubagentRun(runId: string): void;
  callGateway: typeof defaultCallGateway;
  captureSubagentCompletionReply: CaptureSubagentCompletionReply;
  cleanupBrowserSessionsForLifecycleEnd?: BrowserCleanup;
  loadCleanupBrowserSessionsForLifecycleEnd?: () => Promise<BrowserCleanup>;
  runSubagentAnnounceFlow: RunSubagentAnnounceFlow;
  maybeWakeRequesterAfterAllChildrenSettled: MaybeWakeRequesterAfterAllChildrenSettled;
  warn(message: string, meta?: Record<string, unknown>): void;
};

export interface SubagentLifecycleCommonContext {
  readonly options: SubagentLifecycleOptions;
  newerGenerationOwnsSession(entry: SubagentRunRecord): boolean;
}

export interface SubagentLifecycleCompletionContext extends SubagentLifecycleCommonContext {
  acquireTerminalCompletionLock(runId: string): Promise<() => void>;
  bumpCleanupGeneration(entry: SubagentRunRecord): number;
  bumpTerminalGeneration(entry: SubagentRunRecord): number;
  hasProgressEnded(entry: SubagentRunRecord): boolean;
  isTerminalCallbackCurrent(runId: string, entry: SubagentRunRecord, generation: number): boolean;
  markProgressEnded(entry: SubagentRunRecord): void;
  startSubagentAnnounceCleanupFlow(runId: string, entry: SubagentRunRecord): boolean;
}

export interface SubagentLifecycleCleanupContext extends SubagentLifecycleCommonContext {
  addScheduledResumeTimer(timer: ReturnType<typeof setTimeout>): void;
  bumpCleanupGeneration(entry: SubagentRunRecord): number;
  clearCleanupFailureCount(entry: SubagentRunRecord): void;
  deleteScheduledResumeTimer(timer: ReturnType<typeof setTimeout>): void;
  incrementCleanupFailureCount(entry: SubagentRunRecord): number;
  isCleanupAttemptCurrent(runId: string, entry: SubagentRunRecord, generation: number): boolean;
  isCleanupGeneration(entry: SubagentRunRecord, generation: number): boolean;
  isCleanupGenerationCurrent(runId: string, entry: SubagentRunRecord, generation: number): boolean;
  isEndedHookOwnerCurrent(runId: string, entry: SubagentRunRecord): boolean;
  startSubagentAnnounceCleanupFlow(runId: string, entry: SubagentRunRecord): boolean;
}

export interface SubagentLifecycleAnnounceCleanupContext
  extends SubagentLifecycleCleanupContext, SubagentLifecycleWakeContext {
  completeCleanupBookkeeping(args: CleanupBookkeepingParams): void;
}

export interface SubagentLifecycleWakeContext extends SubagentLifecycleCommonContext {
  deleteRequesterSettleWakeTimer(runId: string): void;
  getRequesterSettleWakeTimer(runId: string): ScheduledRequesterSettleWake | undefined;
  hasScheduledRequesterSettleWakeRun(runId: string): boolean;
  markRequesterSettleWakeRearm(runId: string): void;
  markRequesterSettleWakeRunScheduled(runId: string): void;
  setRequesterSettleWakeTimer(runId: string, value: ScheduledRequesterSettleWake): void;
  takeRequesterSettleWakeRearm(runId: string): boolean;
  unmarkRequesterSettleWakeRunScheduled(runId: string): void;
}

export type CleanupBookkeepingParams = {
  runId: string;
  entry: SubagentRunRecord;
  cleanup: "delete" | "keep";
  completedAt: number;
  preserveTranscript?: boolean;
  provisionalKill?: boolean;
  skipRequesterSettleWake?: boolean;
};

export class SubagentLifecycleController {
  private readonly scheduledResumeTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly pendingRequesterSettleWakeRearms = new Set<string>();
  private readonly scheduledRequesterSettleWakeRuns = new Set<string>();
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
    await runWithGatewayIndependentRootWorkAdmission(async () => {
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

  resumeRequesterSettleWake = (runId: string, entry: SubagentRunRecord) =>
    scheduleRequesterSettleWake(this, runId, entry);

  settleRequesterTurnAfterSessionSpawns = (args: {
    requesterSessionKey: string;
    requesterTurnRunId: string;
    requesterYielded: boolean;
    acceptedSessionSpawns: readonly AcceptedSessionSpawn[];
  }) =>
    settleRequesterTurnAfterSessionSpawns({
      ...args,
      runs: this.options.runs,
      persistOrThrow: (...runIds) => this.options.persistOrThrow(...runIds),
      schedule: (runId, entry) => {
        if (this.hasScheduledRequesterSettleWakeRun(runId)) {
          this.markRequesterSettleWakeRearm(runId);
          return;
        }
        scheduleRequesterSettleWake(this, runId, entry);
      },
    });

  startSubagentAnnounceCleanupFlow = (runId: string, entry: SubagentRunRecord): boolean =>
    startSubagentAnnounceCleanupFlow(this, runId, entry);
}
