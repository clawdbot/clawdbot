import type { Bot } from "grammy";
import {
  computeBackoff,
  sleepWithAbort,
  type BackoffPolicy,
} from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export type TelegramSendChatActionLogger = (message: string) => void;

type ChatAction =
  | "typing"
  | "upload_photo"
  | "record_video"
  | "upload_video"
  | "record_voice"
  | "upload_voice"
  | "upload_document"
  | "find_location"
  | "record_video_note"
  | "upload_video_note"
  | "choose_sticker";

type TelegramSendChatActionParams = Parameters<Bot["api"]["sendChatAction"]>[2];

type SendChatActionFn = (
  chatId: number | string,
  action: ChatAction,
  threadParams?: TelegramSendChatActionParams,
) => Promise<true>;

export type TelegramSendChatActionHandler = {
  /**
   * Send a chat action with automatic 401 backoff and circuit breaker.
   * Safe to call from multiple concurrent message contexts.
   */
  sendChatAction: (
    chatId: number | string,
    action: ChatAction,
    threadParams?: TelegramSendChatActionParams,
  ) => Promise<void>;
  isSuspended: () => boolean;
  reset: () => void;
};

export type CreateTelegramSendChatActionHandlerParams = {
  sendChatActionFn: SendChatActionFn;
  logger: TelegramSendChatActionLogger;
  maxConsecutive401?: number;
  minIntervalMs?: number;
  now?: () => number;
};

const BACKOFF_POLICY: BackoffPolicy = {
  initialMs: 1000,
  maxMs: 300_000, // 5 minutes
  factor: 2,
  jitter: 0.1,
};

function is401Error(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  return (
    message.includes("401") || normalizeLowercaseStringOrEmpty(message).includes("unauthorized")
  );
}

/**
 * Creates a GLOBAL (per-account) handler for sendChatAction that tracks 401 errors
 * across all message contexts. This prevents the infinite loop that caused Telegram
 * to delete bots (issue #27092).
 *
 * When a 401 occurs, exponential backoff is applied (1s → 2s → 4s → ... → 5min).
 * After maxConsecutive401 failures (default 10), all sendChatAction calls are
 * suspended until reset() is called.
 */
export function createTelegramSendChatActionHandler({
  sendChatActionFn,
  logger,
  maxConsecutive401 = 10,
  minIntervalMs = 0,
  now = () => Date.now(),
}: CreateTelegramSendChatActionHandlerParams): TelegramSendChatActionHandler {
  let consecutive401Failures = 0;
  let suspended = false;
  const blockedUntilByKey = new Map<string, number>();

  const reset = () => {
    consecutive401Failures = 0;
    suspended = false;
    blockedUntilByKey.clear();
  };

  const sendChatAction = async (
    chatId: number | string,
    action: ChatAction,
    threadParams?: TelegramSendChatActionParams,
  ): Promise<void> => {
    if (suspended) {
      return;
    }

    const key = minIntervalMs > 0 ? `${String(chatId)}:${action}` : undefined;
    const attemptedAt = key ? now() : 0;
    if (key) {
      const blockedUntil = blockedUntilByKey.get(key);
      if (blockedUntil !== undefined && attemptedAt < blockedUntil) {
        return;
      }
      blockedUntilByKey.set(key, Number.POSITIVE_INFINITY);
    }

    if (consecutive401Failures > 0) {
      const backoffMs = computeBackoff(BACKOFF_POLICY, consecutive401Failures);
      logger(
        `sendChatAction backoff: waiting ${backoffMs}ms before retry ` +
          `(failure ${consecutive401Failures}/${maxConsecutive401})`,
      );
      await sleepWithAbort(backoffMs);
    }

    try {
      await sendChatActionFn(chatId, action, threadParams);
      // Success: reset failure counter
      if (consecutive401Failures > 0) {
        logger(`sendChatAction recovered after ${consecutive401Failures} consecutive 401 failures`);
        consecutive401Failures = 0;
      }
    } catch (error) {
      if (is401Error(error)) {
        consecutive401Failures++;

        if (consecutive401Failures >= maxConsecutive401) {
          suspended = true;
          logger(
            `CRITICAL: sendChatAction suspended after ${consecutive401Failures} consecutive 401 errors. ` +
              `Bot token is likely invalid. Telegram may DELETE the bot if requests continue. ` +
              `Replace the token and restart: openclaw channels restart telegram`,
          );
        } else {
          logger(
            `sendChatAction 401 error (${consecutive401Failures}/${maxConsecutive401}). ` +
              `Retrying with exponential backoff.`,
          );
        }
      }
      throw error;
    } finally {
      if (key) {
        blockedUntilByKey.set(key, attemptedAt + minIntervalMs);
      }
    }
  };

  return {
    sendChatAction,
    isSuspended: () => suspended,
    reset,
  };
}
