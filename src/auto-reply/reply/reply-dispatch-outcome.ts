import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ReplyDispatchSettledCounts } from "./reply-dispatcher.types.js";

const REPLY_DISPATCH_DELIVERY_ERROR_CODE = "REPLY_DISPATCH_DELIVERY_ERROR";

export const REPLY_DISPATCH_OUTCOME_COUNTS = {
  delivered: "delivered",
  "delivered-not-visible": "deliveredNotVisible",
  "channel-transform": "deliveredNotVisible",
  cancelled: "cancelled",
  "failed-before-deliver": "failedBeforeSend",
  "failed-deliver": "failedAfterSend",
} as const satisfies Record<string, keyof ReplyDispatchSettledCounts>;
export type ReplyDispatchDeliveryOutcome = keyof typeof REPLY_DISPATCH_OUTCOME_COUNTS;

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
    typeof error.outcome === "string" &&
    Object.hasOwn(REPLY_DISPATCH_OUTCOME_COUNTS, error.outcome)
  );
}

export function shouldRetryReplyDispatch(outcome: ReplyDispatchDeliveryOutcome): boolean {
  return (
    outcome === "delivered-not-visible" ||
    outcome === "cancelled" ||
    outcome === "failed-before-deliver"
  );
}

/** Identityless completion proves ambiguity, not queue custody or an intentional no-send. */
export function isReplyDispatchDeliveryPending(result: unknown): boolean {
  return (
    isRecord(result) &&
    isRecord(result.suppression) &&
    result.suppression.reason === "adapter_returned_no_identity"
  );
}

export function resolveReplyDispatchDeliveryOutcome(result: unknown): ReplyDispatchDeliveryOutcome {
  if (isReplyDispatchDeliveryPending(result)) {
    return "delivered-not-visible";
  }
  if (!isRecord(result) || result.visibleReplySent !== false) {
    return "delivered";
  }
  return isRecord(result.suppression) && result.suppression.reason === "channel_transform"
    ? "channel-transform"
    : "delivered-not-visible";
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
