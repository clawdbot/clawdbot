// Shared reply dispatcher type contracts for visible and message-tool delivery.
import type { ReplyPayload } from "../types.js";

export type ReplyDispatchKind = "tool" | "block" | "final";

export type ReplyFollowupAdmissionBarrierTimeoutPolicy = {
  /** Absolute failsafe for owner activity that never settles. */
  maxTimeoutMs: number;
  /** Extend by another default settle interval while bounded owner work remains active. */
  shouldExtend: () => boolean;
};

export type ReplyDispatchRuntimeInfo = {
  kind: ReplyDispatchKind;
  assistantMessageIndex?: number;
};

export type ReplyDispatchBeforeDeliver = (
  payload: ReplyPayload,
  info: ReplyDispatchRuntimeInfo,
) => Promise<ReplyPayload | null> | ReplyPayload | null;

/** An owner-declared settlement budget for one before-delivery callback. */
export type ReplyDispatchBeforeDeliverOptions = {
  /** Positive finite per-callback deadline in milliseconds; omit for the dispatcher default. */
  timeoutMs?: number;
};

export type ReplyDispatcher = {
  sendToolResult: (payload: ReplyPayload) => boolean;
  sendBlockReply: (payload: ReplyPayload) => boolean;
  sendFinalReply: (payload: ReplyPayload) => boolean;
  appendBeforeDeliver?: (
    hook: ReplyDispatchBeforeDeliver,
    options?: ReplyDispatchBeforeDeliverOptions,
  ) => void;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<ReplyDispatchKind, number>;
  getCancelledCounts?: () => Record<ReplyDispatchKind, number>;
  getFailedCounts: () => Record<ReplyDispatchKind, number>;
  markComplete: () => void;
  /** Owner-declared deadline for holding queued follow-ups behind all queued deliveries. */
  resolveFollowupAdmissionBarrierTimeoutPolicy?: () =>
    | ReplyFollowupAdmissionBarrierTimeoutPolicy
    | undefined;
};

/**
 * Internal view for defensive outcome-count accounting. Some non-conforming
 * runtime dispatcher variants (for example plugin-provided dispatchers) may omit
 * these readers even though the public ReplyDispatcher contract requires
 * getFailedCounts. Read the counters through this view so the guards stay
 * type-correct without weakening the SDK-visible ReplyDispatcher type.
 */
export type DispatcherOutcomeCountsView = {
  getCancelledCounts?: () => Record<ReplyDispatchKind, number>;
  getFailedCounts?: () => Record<ReplyDispatchKind, number>;
};

export function readDispatcherFailedCounts(
  dispatcher: DispatcherOutcomeCountsView,
): Record<ReplyDispatchKind, number> {
  return dispatcher.getFailedCounts?.() ?? { tool: 0, block: 0, final: 0 };
}
