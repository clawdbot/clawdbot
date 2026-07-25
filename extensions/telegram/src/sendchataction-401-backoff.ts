// Telegram plugin module implements sendchataction 401 and transient backoff behavior.
import type { Bot } from "grammy";
import {
  computeBackoff,
  sleepWithAbort,
  type BackoffPolicy,
} from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isRecoverableTelegramNetworkError,
  isTelegramRateLimitError,
  isTelegramServerError,
  readTelegramRetryAfterMs,
} from "./network-errors.js";

type TelegramSendChatActionLogger = (message: string) => void;

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
   * Send a chat action with automatic 401 backoff and transient cooldown.
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

type CreateTelegramSendChatActionHandlerParams = {
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
  // When a structured Telegram error_code is present, trust it exclusively.
  // A 429 with retry_after=401 renders as "(429: Too Many Requests: retry after 401)"
  // whose message contains the substring "401" — that must NOT trigger the 401
  // suspension path. The sibling classifiers in network-errors.ts also use
  // error_code before message heuristics; see hasTelegramErrorCode.
  if (
    typeof error === "object" &&
    error !== null &&
    "error_code" in error &&
    typeof (error as { error_code: unknown }).error_code === "number"
  ) {
    return (error as { error_code: number }).error_code === 401;
  }
  // Fallback for non-Telegram errors without a structured error_code:
  // match "unauthorized" case-insensitively, but do NOT use bare "401"
  // substring matching — that was the root cause of #94787.
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  return normalizeLowercaseStringOrEmpty(message).includes("unauthorized");
}

class TelegramSendChatActionTransientCooldownError extends Error {
  constructor(remainingMs: number) {
    super(`sendChatAction transient cooldown active for ${Math.ceil(remainingMs)}ms`);
    this.name = "TelegramSendChatActionTransientCooldownError";
  }
}

function isTransientSendChatActionError(error: unknown): boolean {
  return (
    isTelegramRateLimitError(error) ||
    isTelegramServerError(error) ||
    isRecoverableTelegramNetworkError(error, { context: "action" })
  );
}

function resolveTransientCooldownMs(error: unknown, attempt: number): number {
  const retryAfterMs = readTelegramRetryAfterMs(error);
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return retryAfterMs;
  }
  return computeBackoff(BACKOFF_POLICY, attempt);
}

/**
 * Creates a GLOBAL (per-account) handler for sendChatAction that tracks 401 and
 * transient errors across all message contexts. This prevents the infinite loop
 * that caused Telegram to delete bots (issue #27092).
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
  let consecutiveTransientFailures = 0;
  let suspended = false;
  let transientCooldownUntilMs = 0;
  const blockedUntilByKey = new Map<string, number>();

  const clearTransientCooldown = () => {
    consecutiveTransientFailures = 0;
    transientCooldownUntilMs = 0;
  };

  const reset = () => {
    consecutive401Failures = 0;
    clearTransientCooldown();
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

    const attemptedAt = now();
    const remainingTransientCooldownMs = transientCooldownUntilMs - attemptedAt;
    if (remainingTransientCooldownMs > 0) {
      // Reject transient cooldown starts so channel typing guards can count the
      // failure and stop keepalive loops instead of silently hammering Telegram.
      throw new TelegramSendChatActionTransientCooldownError(remainingTransientCooldownMs);
    }

    const key = minIntervalMs > 0 ? `${String(chatId)}:${action}` : undefined;
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
      clearTransientCooldown();
    } catch (error) {
      if (is401Error(error)) {
        clearTransientCooldown();
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
      } else if (isTransientSendChatActionError(error)) {
        consecutiveTransientFailures++;
        const cooldownMs = resolveTransientCooldownMs(error, consecutiveTransientFailures);
        const cooldownStartedAt = now();
        // Keep transient failures rejected through the same-chat coalesce window;
        // otherwise the next typing keepalive can look successful and reset its guard.
        const coalescingUntilMs = key ? attemptedAt + minIntervalMs : 0;
        transientCooldownUntilMs = Math.max(cooldownStartedAt + cooldownMs, coalescingUntilMs);
        const effectiveCooldownMs = Math.max(0, transientCooldownUntilMs - cooldownStartedAt);
        logger(
          `sendChatAction transient error (${consecutiveTransientFailures}). ` +
            `Cooling down ${effectiveCooldownMs}ms before retry.`,
        );
      } else {
        clearTransientCooldown();
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
