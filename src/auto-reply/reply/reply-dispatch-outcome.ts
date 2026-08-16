import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ReplyDispatchSettledCounts } from "./reply-dispatcher.types.js";

export type ReplyDispatchDeliveryOutcome =
  | "delivered"
  | "delivered-not-visible"
  | "cancelled"
  | "failed-before-deliver"
  | "failed-deliver";

export function isReplyDispatchProvenInvisible(outcome: ReplyDispatchDeliveryOutcome): boolean {
  return (
    outcome === "delivered-not-visible" ||
    outcome === "cancelled" ||
    outcome === "failed-before-deliver"
  );
}

export function isExplicitlyNonVisibleDelivery(result: unknown): boolean {
  return isRecord(result) && result.visibleReplySent === false;
}

export function createReplyDispatchSettledCounts(): ReplyDispatchSettledCounts {
  return {
    delivered: 0,
    deliveredNotVisible: 0,
    cancelled: 0,
    failedBeforeSend: 0,
    failedAfterSend: 0,
  };
}
