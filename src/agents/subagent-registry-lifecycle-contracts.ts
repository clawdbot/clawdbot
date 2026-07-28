import type { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { callGateway as defaultCallGateway } from "../gateway/call.js";
import type { DetachedTaskFindResult } from "../tasks/detached-task-runtime-contract.js";
import type { SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type CaptureSubagentCompletionReply =
  (typeof import("./subagent-announce.js"))["captureSubagentCompletionReply"];
type RunSubagentAnnounceFlow = (typeof import("./subagent-announce.js"))["runSubagentAnnounceFlow"];
type MaybeWakeRequesterAfterAllChildrenSettled =
  (typeof import("./subagent-announce.requester-settle-wake.js"))["maybeWakeRequesterAfterAllChildrenSettled"];
export type SubagentRegistryLifecycleParams = {
  runs: Map<string, SubagentRunRecord>;
  resumedRuns: Set<string>;
  subagentAnnounceTimeoutMs: number;
  getRuntimeConfig(): OpenClawConfig;
  persist(): void;
  persistOrThrow(): void;
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
  notifyContextEngineSubagentEnded(args: {
    childSessionKey: string;
    reason: "completed" | "deleted";
    agentDir?: string;
    workspaceDir?: string;
  }): Promise<void>;
  retireSupersededRun(runId: string, entry: SubagentRunRecord): Promise<void>;
  resumeSubagentRun(runId: string): void;
  callGateway: typeof defaultCallGateway;
  captureSubagentCompletionReply: CaptureSubagentCompletionReply;
  cleanupBrowserSessionsForLifecycleEnd?: typeof cleanupBrowserSessionsForLifecycleEnd;
  runSubagentAnnounceFlow: RunSubagentAnnounceFlow;
  maybeWakeRequesterAfterAllChildrenSettled: MaybeWakeRequesterAfterAllChildrenSettled;
  warn(message: string, meta?: Record<string, unknown>): void;
};

export type SubagentRegistryLifecycleState = {
  scheduledResumeTimers: Set<ReturnType<typeof setTimeout>>;
  pendingRequesterSettleWakeRearms: Set<string>;
  scheduledRequesterSettleWakeRuns: Set<string>;
  scheduledRequesterSettleWakeTimers: Map<string, ReturnType<typeof setTimeout>>;
  terminalCompletionLocks: Map<string, Promise<void>>;
  terminalGenerations: WeakMap<SubagentRunRecord, number>;
  cleanupGenerations: WeakMap<SubagentRunRecord, number>;
  progressEndedEntries: WeakSet<SubagentRunRecord>;
};

export function createSubagentRegistryLifecycleState(): SubagentRegistryLifecycleState {
  return {
    scheduledResumeTimers: new Set(),
    pendingRequesterSettleWakeRearms: new Set(),
    scheduledRequesterSettleWakeRuns: new Set(),
    scheduledRequesterSettleWakeTimers: new Map(),
    terminalCompletionLocks: new Map(),
    terminalGenerations: new WeakMap(),
    cleanupGenerations: new WeakMap(),
    progressEndedEntries: new WeakSet(),
  };
}
