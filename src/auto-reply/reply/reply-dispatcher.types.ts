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
