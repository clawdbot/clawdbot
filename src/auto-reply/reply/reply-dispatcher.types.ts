// Shared reply dispatcher type contracts for visible and message-tool delivery.
import type { ReplyPayload } from "../types.js";

export type ReplyDispatchKind = "tool" | "block" | "final";

export type ReplyDispatchBeforeDeliver = (
  payload: ReplyPayload,
  info: { kind: ReplyDispatchKind },
) => Promise<ReplyPayload | null> | ReplyPayload | null;

export type ReplyDispatcher = {
  sendToolResult: (payload: ReplyPayload) => boolean;
  sendBlockReply: (payload: ReplyPayload) => boolean;
  sendFinalReply: (payload: ReplyPayload) => boolean;
  appendBeforeDeliver?: (hook: ReplyDispatchBeforeDeliver) => void;
  waitForIdle: () => Promise<void>;
  getQueuedCounts: () => Record<ReplyDispatchKind, number>;
  getCancelledCounts?: () => Record<ReplyDispatchKind, number>;
  getFailedCounts: () => Record<ReplyDispatchKind, number>;
  markComplete: () => void;
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
