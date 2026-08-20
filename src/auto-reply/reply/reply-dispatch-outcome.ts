import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ReplyDispatchSettledCounts } from "./reply-dispatcher.types.js";

export type ReplyDispatchDeliveryOutcome =
  | "delivered"
  | "delivered-not-visible"
  | "cancelled"
  | "failed-before-deliver"
  | "failed-deliver";

export class ReplyDispatchDeliveryError extends Error {
  constructor(readonly outcome: ReplyDispatchDeliveryOutcome) {
    super("queued reply delivery failed");
    this.name = "ReplyDispatchDeliveryError";
  }
}

export function isReplyDispatchDeliveryError(error: unknown): error is ReplyDispatchDeliveryError {
  return error instanceof ReplyDispatchDeliveryError;
}

export function isReplyDispatchProvenInvisible(outcome: ReplyDispatchDeliveryOutcome): boolean {
  return outcome !== "delivered" && outcome !== "failed-deliver";
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
