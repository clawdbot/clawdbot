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
  partialDeliveryResult: () => PartialDeliveryResult;
}) {
  let acceptedCount = 0;
  let firstRejectedError: unknown;

  const throwAfterAccepted = (error: unknown): never => {
    if (acceptedCount === 0 || isChannelPartialDeliveryError(error)) {
      throw error;
    }
    throw createChannelPartialDeliveryError(error, params.partialDeliveryResult());
  };

  const reject = (error: unknown): false => {
    if (!isTelegramSkippableChunkSendError(error)) {
      throwAfterAccepted(error);
    }
    firstRejectedError ??= error;
    params.invalidate();
    params.onRejected(error);
    return false;
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
      return true;
    },
    recordAccepted,
    reject,
    finish() {
      if (firstRejectedError !== undefined) {
        throwAfterAccepted(firstRejectedError);
      }
    },
  };
}
