import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ReplyDispatchSettledCounts } from "./reply-dispatcher.types.js";

const REPLY_DISPATCH_DELIVERY_ERROR_CODE = "REPLY_DISPATCH_DELIVERY_ERROR";

export type ReplyDispatchDeliveryOutcome =
  | "delivered"
  | "delivered-not-visible"
  | "cancelled"
  | "failed-before-deliver"
  | "failed-deliver";

export class ReplyDispatchDeliveryError extends Error {
  readonly code = REPLY_DISPATCH_DELIVERY_ERROR_CODE;

  constructor(readonly outcome: ReplyDispatchDeliveryOutcome) {
    super("queued reply delivery failed");
    this.name = "ReplyDispatchDeliveryError";
  }
}

export function isReplyDispatchDeliveryError(error: unknown): error is ReplyDispatchDeliveryError {
  return (
    isRecord(error) &&
    error.code === REPLY_DISPATCH_DELIVERY_ERROR_CODE &&
    (error.outcome === "delivered" ||
      error.outcome === "delivered-not-visible" ||
      error.outcome === "cancelled" ||
      error.outcome === "failed-before-deliver" ||
      error.outcome === "failed-deliver")
  );
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
