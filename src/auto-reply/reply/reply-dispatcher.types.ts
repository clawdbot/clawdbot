// Shared reply dispatcher type contracts for visible and message-tool delivery.
import type { ReplyPayload } from "../types.js";
import type { NormalizeReplyOutcome } from "./normalize-reply-skip-reason.js";

export type ReplyDispatchKind = "tool" | "block" | "final";

export type ReplyDispatchSettledCounts = {
  delivered: number;
  deliveredNotVisible: number;
  cancelled: number;
  failedBeforeSend: number;
  failedAfterSend: number;
};

export type ReplyDispatchReceipt = {
  counts: Record<ReplyDispatchKind, ReplyDispatchSettledCounts>;
  anyVisibleDelivered: boolean;
  /** Delivery is queued or ambiguous; another send could duplicate it. */
  hasPendingDelivery?: true;
};

export function mapReplyDispatchCounts<T>(
  counts: Record<ReplyDispatchKind, T>,
  select: (counts: T) => number,
): Record<ReplyDispatchKind, number> {
  return { tool: select(counts.tool), block: select(counts.block), final: select(counts.final) };
}

export type ReplyFollowupAdmissionBarrierTimeoutPolicy = {
  /** Absolute failsafe for owner activity that never settles. */
  maxTimeoutMs: number;
  /** Extend by another default settle interval while bounded owner work remains active. */
  shouldExtend: () => boolean;
};

export type ReplyDispatchRuntimeInfo = {
  kind: ReplyDispatchKind;
  assistantMessageIndex?: number;
  /** @internal Claim direct-send custody immediately before recipient-visible platform I/O. */
  onPlatformSendDispatch?: () => Promise<void>;
  /** @internal Synchronously fence custody after claiming it and before provider I/O. */
  assertPlatformSendAuthorized?: () => void;
  /** @internal Bind this delivery's host-owned completion to a transformed payload. */
  bindPendingFinalDelivery?: <T extends ReplyPayload>(payload: T) => T;
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
  /** @internal Preserve the delivery owner's preparation through dispatcher wrappers. */
  prepareReplyPayload?: (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
  ) => NormalizeReplyOutcome<ReplyPayload>;
  sendToolResult: (payload: ReplyPayload) => boolean;
  sendBlockReply: (payload: ReplyPayload) => boolean;
  sendFinalReply: (payload: ReplyPayload) => boolean;
  appendBeforeDeliver?: (
    hook: ReplyDispatchBeforeDeliver,
    options?: ReplyDispatchBeforeDeliverOptions,
  ) => void;
  supportsSettledReceipt?: true;
  waitForIdle: () => Promise<void | ReplyDispatchReceipt>;
  /** @deprecated Remove in the next Plugin SDK major; retains admission-time counts. */
  getQueuedCounts: () => Record<ReplyDispatchKind, number>;
  /** @deprecated Remove in the next Plugin SDK major; derived from settled receipts. */
  getCancelledCounts?: () => Record<ReplyDispatchKind, number>;
  /** @deprecated Remove in the next Plugin SDK major; derived from settled receipts. */
  getFailedCounts: () => Record<ReplyDispatchKind, number>;
  markComplete: () => void;
  /** Owner-declared deadline for holding queued follow-ups behind all queued deliveries. */
  resolveFollowupAdmissionBarrierTimeoutPolicy?: () =>
    | ReplyFollowupAdmissionBarrierTimeoutPolicy
    | undefined;
};
