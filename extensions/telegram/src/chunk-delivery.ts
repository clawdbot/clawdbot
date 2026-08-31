import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
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
  return createChannelPartialDeliveryError(error, {
    ...priorDeliveryResult,
    ...currentDeliveryResult,
    ...(messageIds.length > 0 ? { messageIds } : {}),
    visibleReplySent: true,
  });
}

function isTelegramSkippableChunkSendError(error: unknown): boolean {
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

export function createTelegramChunkDeliveryTracker(params: {
  invalidate: () => void;
  onRejected: (error: unknown) => void;
  isSilentSkip?: (error: unknown) => boolean;
  onSilentSkip?: (error: unknown) => void;
  partialDeliveryResult: () => PartialDeliveryResult;
}) {
  let acceptedCount = 0;
  let firstRejectedError: unknown;
  let firstSilentSkipError: unknown;

  const throwAfterAccepted = (error: unknown): never => {
    if (acceptedCount === 0) {
      throw error;
    }
    throw mergeTelegramPartialDeliveryError(error, params.partialDeliveryResult());
  };

  const reject = (error: unknown): "rejected" | "silent-skip" => {
    if (params.isSilentSkip?.(error)) {
      firstSilentSkipError ??= error;
      params.onSilentSkip?.(error);
      return "silent-skip";
    }
    if (!isTelegramSkippableChunkSendError(error)) {
      throwAfterAccepted(error);
    }
    firstRejectedError ??= error;
    params.invalidate();
    params.onRejected(error);
    return "rejected";
  };

  const recordAccepted = async <T>(result: T, record: (result: T) => Promise<void>) => {
    acceptedCount += 1;
    try {
      await record(result);
    } catch (error) {
      throwAfterAccepted(error);
    }
  };

  return {
    async attempt<T>(send: () => Promise<T>, record: (result: T) => Promise<void>) {
      let result: T;
      try {
        result = await send();
      } catch (error) {
        return reject(error);
      }
      await recordAccepted(result, record);
      return "accepted" as const;
    },
    recordAccepted,
    reject,
    fail: throwAfterAccepted,
    finish() {
      if (firstRejectedError !== undefined) {
        throwAfterAccepted(firstRejectedError);
      }
      if (acceptedCount === 0 && firstSilentSkipError !== undefined) {
        throwAfterAccepted(firstSilentSkipError);
      }
    },
  };
}
