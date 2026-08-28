import type { cleanupBrowserSessionsForLifecycleEnd } from "../../../browser-lifecycle-cleanup.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { callGateway as defaultCallGateway } from "../../../gateway/call.js";
// This type-only leaf exists solely to keep lifecycle sibling modules from importing the controller.
// Keeping the controller out of their dependency graph satisfies the architecture cycle gate.
import type { DetachedTaskFindResult } from "../../../tasks/detached-task-runtime-contract.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

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

export type ScheduledRequesterSettleWake = {
  timer: ReturnType<typeof setTimeout>;
  deadline: number;
  rearmGeneration?: number;
};
