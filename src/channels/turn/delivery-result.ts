// Delivery-result adapters for channel turn receipts.
import { formatErrorMessage } from "../../infra/errors.js";
import { listMessageReceiptPlatformIds } from "../message/receipt.js";
import type { MessageReceipt } from "../message/types.js";
import type {
  ChannelDeliveryIntent,
  ChannelDeliveryOutcome,
  ChannelDeliveryResult,
} from "./types.js";

const CHANNEL_PARTIAL_DELIVERY_ERROR_CODE = "CHANNEL_PARTIAL_DELIVERY";

type ChannelPartialDeliveryEnvelope = {
  code: typeof CHANNEL_PARTIAL_DELIVERY_ERROR_CODE;
  deliveryResult: ChannelDeliveryOutcome & { visibleReplySent: true };
};

export type ChannelPartialDeliveryError = Error & ChannelPartialDeliveryEnvelope;

/** Preserves provider-visible delivery facts when a later native operation fails. */
export function createChannelPartialDeliveryError(
  cause: unknown,
  deliveryResult: ChannelDeliveryOutcome & { visibleReplySent: true },
): ChannelPartialDeliveryError & { sentBeforeError: true; visibleReplySent: true } {
  return Object.assign(new Error(formatErrorMessage(cause), { cause }), {
    code: "CHANNEL_PARTIAL_DELIVERY" as const,
    deliveryResult,
    sentBeforeError: true as const,
    visibleReplySent: true as const,
  });
}

export function isChannelPartialDeliveryError(
  error: unknown,
): error is ChannelPartialDeliveryEnvelope {
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return false;
  }
  const candidate = error as { code?: unknown; deliveryResult?: unknown };
  return (
    candidate.code === CHANNEL_PARTIAL_DELIVERY_ERROR_CODE &&
    Boolean(
      candidate.deliveryResult &&
      typeof candidate.deliveryResult === "object" &&
      !Array.isArray(candidate.deliveryResult) &&
      (candidate.deliveryResult as { visibleReplySent?: unknown }).visibleReplySent === true,
    )
  );
}

/** Converts a normalized message receipt into the delivery result shape used by channel turns. */
export function createChannelDeliveryResultFromReceipt(params: {
  receipt: MessageReceipt;
  threadId?: string;
  replyToId?: string;
  visibleReplySent?: boolean;
  content?: string;
  deliveryIntent?: ChannelDeliveryIntent;
}): ChannelDeliveryResult {
  const messageIds = listMessageReceiptPlatformIds(params.receipt);
  return {
    ...(messageIds.length > 0 ? { messageIds } : {}),
    receipt: params.receipt,
    ...(params.threadId ? { threadId: params.threadId } : {}),
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    ...(params.visibleReplySent === undefined ? {} : { visibleReplySent: params.visibleReplySent }),
    ...(params.content === undefined ? {} : { content: params.content }),
    ...(params.deliveryIntent ? { deliveryIntent: params.deliveryIntent } : {}),
  };
}
