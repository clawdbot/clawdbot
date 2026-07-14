// Delivery result types define the normalized channel send contract plus
// partial-failure metadata for multi-payload outbound sends.
import type { MessageReceipt } from "../../channels/message/types.js";
import type { ChannelId } from "../../channels/plugins/channel-id.types.js";

/** Successful channel send result normalized for core delivery accounting. */
export type OutboundDeliveryResult = {
  channel: Exclude<ChannelId, "none">;
  messageId: string;
  chatId?: string;
  channelId?: string;
  roomId?: string;
  conversationId?: string;
  timestamp?: number;
  toJid?: string;
  pollId?: string;
  receipt?: MessageReceipt;
  // Channel docking: stash channel-specific fields here to avoid core type churn.
  meta?: Record<string, unknown>;
};

/** Count platform sends without double-counting equivalent receipt representations. */
export function countPhysicalOutboundSends(results: readonly OutboundDeliveryResult[]): number {
  return results.reduce((count, result) => {
    const receipt = result.receipt;
    if (!receipt) {
      return count + 1;
    }
    // Parts and platform ids describe the same sends. Prefer parts so aggregate
    // receipts preserve multiplicity without counting both representations.
    const receiptCount =
      receipt.parts.length > 0 ? receipt.parts.length : receipt.platformMessageIds.length;
    return count + Math.max(1, receiptCount);
  }, 0);
}

/** Reason a payload was intentionally not sent after normalization or hooks. */
export type OutboundPayloadDeliverySuppressionReason =
  | "cancelled_by_message_sending_hook"
  | "cancelled_by_reply_payload_sending_hook"
  | "empty_after_message_sending_hook"
  | "empty_after_reply_payload_sending_hook"
  | "no_visible_payload"
  | "adapter_returned_no_identity";

/** Delivery phase where a failure occurred. */
export type OutboundDeliveryFailureStage = "platform_send" | "queue" | "unknown";
export type OutboundPayloadDeliveryKind = "text" | "media" | "other";

const PLATFORM_MESSAGE_NOT_DISPATCHED_ERROR_CODE = "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED";

/**
 * Provider assertion that retrying cannot duplicate a recipient-visible send.
 * Never use this after a finalization/send call returned an ambiguous result.
 */
export class PlatformMessageNotDispatchedError extends Error {
  readonly code = PLATFORM_MESSAGE_NOT_DISPATCHED_ERROR_CODE;

  constructor(message: string, options: { cause: unknown }) {
    super(message, { cause: options.cause });
    this.name = "PlatformMessageNotDispatchedError";
  }
}

export function isPlatformMessageNotDispatchedError(
  error: unknown,
): error is PlatformMessageNotDispatchedError {
  return error instanceof PlatformMessageNotDispatchedError;
}

/** Per-payload delivery status emitted to callers and channel send summaries. */
export type OutboundPayloadDeliveryOutcome =
  | {
      index: number;
      status: "sent";
      results: OutboundDeliveryResult[];
      /** Effective post-hook, post-render payload kind. */
      deliveryKind?: OutboundPayloadDeliveryKind;
    }
  | {
      index: number;
      status: "suppressed";
      reason: OutboundPayloadDeliverySuppressionReason;
      hookEffect?: {
        cancelReason?: string;
        metadata?: Record<string, unknown>;
      };
    }
  | {
      index: number;
      status: "failed";
      error: unknown;
      sentBeforeError: boolean;
      stage: OutboundDeliveryFailureStage;
      /** Identified platform sends from this payload before its terminal failure. */
      results?: OutboundDeliveryResult[];
      /** Effective post-hook, post-render payload kind when platform delivery began. */
      deliveryKind?: OutboundPayloadDeliveryKind;
    };

/** Error carrying partial delivery results when an outbound send fails mid-batch. */
export class OutboundDeliveryError extends Error {
  readonly results: OutboundDeliveryResult[];
  readonly payloadOutcomes: OutboundPayloadDeliveryOutcome[];
  readonly sentBeforeError: boolean;
  readonly stage: OutboundDeliveryFailureStage;

  constructor(
    message: string,
    options: {
      cause: unknown;
      results?: readonly OutboundDeliveryResult[];
      payloadOutcomes?: readonly OutboundPayloadDeliveryOutcome[];
      stage?: OutboundDeliveryFailureStage;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "OutboundDeliveryError";
    this.results = [...(options.results ?? [])];
    this.payloadOutcomes = [...(options.payloadOutcomes ?? [])];
    this.sentBeforeError = this.results.length > 0;
    this.stage = options.stage ?? "unknown";
  }
}

/** Narrows unknown failures to outbound delivery errors with partial-send metadata. */
export function isOutboundDeliveryError(error: unknown): error is OutboundDeliveryError {
  return error instanceof OutboundDeliveryError;
}
