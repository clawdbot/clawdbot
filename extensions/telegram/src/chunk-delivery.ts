import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { isSafeToRetrySendError, isTelegramBadRequestError } from "./network-errors.js";

// A missing chat/thread invalidates the route for every remaining chunk.
// Draining would only repeat the same bad target instead of preserving content.
const TELEGRAM_TERMINAL_BAD_REQUEST_RE = /\b(?:chat|message thread) not found\b/i;

type PartialDeliveryResult = Parameters<typeof createChannelPartialDeliveryError>[1];

export function mergeTelegramPartialDeliveryError(
  error: unknown,
  priorDeliveryResult: PartialDeliveryResult,
): ReturnType<typeof createChannelPartialDeliveryError> {
  if (!isChannelPartialDeliveryError(error)) {
    return createChannelPartialDeliveryError(error, priorDeliveryResult);
  }
  const currentDeliveryResult = error.deliveryResult;
  const messageIds = [
    ...new Set([
      ...(priorDeliveryResult.messageIds ?? []),
      ...(currentDeliveryResult.messageIds ?? []),
    ]),
  ];
  let receipt = currentDeliveryResult.receipt ?? priorDeliveryResult.receipt;
  if (priorDeliveryResult.receipt && currentDeliveryResult.receipt) {
    receipt = createMessageReceiptFromOutboundResults({
      results: [
        { receipt: priorDeliveryResult.receipt },
        { receipt: currentDeliveryResult.receipt },
      ],
    });
    // A per-message observer receipt can overlap a whole accepted album.
    // Keep every physical part once, with the observer's actual placement metadata.
    const parts = new Map<string, (typeof receipt.parts)[number]>();
    for (const part of receipt.parts) {
      parts.set(part.platformMessageId, { ...parts.get(part.platformMessageId), ...part });
    }
    receipt.parts = [...parts.values()];
    for (const [index, part] of receipt.parts.entries()) {
      part.index = index;
    }
  }
  return createChannelPartialDeliveryError(error, {
    ...priorDeliveryResult,
    ...currentDeliveryResult,
    ...(messageIds.length > 0 ? { messageIds } : {}),
    ...(receipt ? { receipt } : {}),
    visibleReplySent: true,
  });
}

export function isTelegramSkippableChunkSendError(error: unknown): boolean {
  if (isSafeToRetrySendError(error)) {
    return true;
  }
  // A structured Telegram 400 is a definite rejection, so later chunks cannot
  // duplicate this one. HTTP/5xx failures remain ambiguous and stop immediately.
  return (
    isTelegramBadRequestError(error) &&
    !TELEGRAM_TERMINAL_BAD_REQUEST_RE.test(formatErrorMessage(error))
  );
}
