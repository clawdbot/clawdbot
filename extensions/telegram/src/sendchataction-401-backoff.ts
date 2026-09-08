// Telegram plugin module implements sendchataction 401 and transient backoff behavior.
import { GrammyError, type Bot, type Transformer } from "grammy";
import {
  computeBackoff,
  sleepWithAbort,
  waitForAbortSignal,
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
  logger,
  maxConsecutive401 = 10,
  minIntervalMs = 0,
  now = () => Date.now(),
}: CreateTelegramSendChatActionHandlerParams) {
  let consecutive401Failures = 0;
  let consecutiveTransientFailures = 0;
  let suspended = false;
  let transientCooldownUntilMs = 0;
  let failureVersion = 0;
  let authorizationRetryTail = Promise.resolve();
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

  const assertNotCoolingDown = () => {
    const remainingMs = transientCooldownUntilMs - now();
    if (remainingMs > 0) {
      throw new Error(`sendChatAction transient cooldown active for ${Math.ceil(remainingMs)}ms`);
    }
  };

  const sendChatAction = async (
    chatId: number | string,
    action: ChatAction,
    threadParams: TelegramSendChatActionParams | undefined,
    send: () => Promise<true>,
  ): Promise<void> => {
    if (suspended) {
      return;
    }

    const attemptedAt = now();
    // Reject cooldown starts so channel typing guards can stop their keepalive loops.
    assertNotCoolingDown();

    const threadId = threadParams?.message_thread_id;
    const key =
      minIntervalMs > 0
        ? `${String(chatId)}:${action}${threadId === undefined ? "" : `:${threadId}`}`
        : undefined;
    if (key) {
      const blockedUntil = blockedUntilByKey.get(key);
      if (blockedUntil !== undefined && attemptedAt < blockedUntil) {
        return;
      }
      blockedUntilByKey.set(key, Number.POSITIVE_INFINITY);
    }

    try {
      await send();
    } finally {
      if (key) {
        blockedUntilByKey.set(key, attemptedAt + minIntervalMs);
      }
    }
  };

  const sendWithBackoff = async <T>(send: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    signal.throwIfAborted();
    if (suspended) {
      throw new Error("sendChatAction suspended");
    }
    assertNotCoolingDown();
    let attemptFailureVersion = failureVersion;
    let releaseAuthorizationRetry: (() => void) | undefined;
    try {
      if (consecutive401Failures > 0) {
        // Only one authorization retry may sleep or send for this account at a time.
        const previousRetry = authorizationRetryTail;
        const retryFinished = new Promise<void>((resolve) => {
          releaseAuthorizationRetry = resolve;
        });
        // A canceled waiter can release its node without releasing its predecessor.
        authorizationRetryTail = previousRetry.then(() => retryFinished);
        await Promise.race([
          previousRetry,
          waitForAbortSignal(signal).then(() => {
            throw new DOMException("Chat action canceled", "AbortError");
          }),
        ]);
        signal.throwIfAborted();
        if (suspended) {
          throw new Error("sendChatAction suspended");
        }
        assertNotCoolingDown();
      }
      let failuresBeforeBackoff = consecutive401Failures;
      while (failuresBeforeBackoff > 0) {
        const backoffMs = computeBackoff(BACKOFF_POLICY, failuresBeforeBackoff);
        logger(
          `sendChatAction backoff: waiting ${backoffMs}ms before retry ` +
            `(failure ${consecutive401Failures}/${maxConsecutive401})`,
        );
        await sleepWithAbort(backoffMs, signal);
        // Another topic can change account state while this request backs off.
        if (suspended) {
          throw new Error("sendChatAction suspended");
        }
        assertNotCoolingDown();
        // Earlier in-flight calls can add failures; repeat only for a higher failure count.
        if (consecutive401Failures <= failuresBeforeBackoff) {
          break;
        }
        failuresBeforeBackoff = consecutive401Failures;
      }

      attemptFailureVersion = failureVersion;
      const result = await send();
      // A request admitted before a newer failure cannot establish account recovery.
      if (attemptFailureVersion !== failureVersion) {
        return result;
      }
      if (consecutive401Failures > 0) {
        logger(`sendChatAction recovered after ${consecutive401Failures} consecutive 401 failures`);
        consecutive401Failures = 0;
      }
      clearTransientCooldown();
      return result;
    } catch (error) {
      if (signal.aborted && error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      if (is401Error(error)) {
        if (attemptFailureVersion === failureVersion) {
          clearTransientCooldown();
        }
        failureVersion++;
        consecutive401Failures++;

        if (consecutive401Failures >= maxConsecutive401) {
          suspended = true;
          logger(
            `CRITICAL: sendChatAction suspended after ${consecutive401Failures} consecutive 401 errors. ` +
              `Bot token is likely invalid. Telegram may DELETE the bot if requests continue. ` +
              `Replace the Telegram token in config/env, then restart the Gateway.`,
          );
        } else {
          logger(
            `sendChatAction 401 error (${consecutive401Failures}/${maxConsecutive401}). ` +
              `Retrying with exponential backoff.`,
          );
        }
      } else if (isTransientSendChatActionError(error)) {
        failureVersion++;
        consecutiveTransientFailures++;
        const cooldownMs = resolveTransientCooldownMs(error, consecutiveTransientFailures);
        const cooldownStartedAt = now();
        // Keep transient failures rejected through the same-chat coalesce window;
        // otherwise the next typing keepalive can look successful and reset its guard.
        const coalescingUntilMs = cooldownStartedAt + minIntervalMs;
        transientCooldownUntilMs = Math.max(
          transientCooldownUntilMs,
          cooldownStartedAt + cooldownMs,
          coalescingUntilMs,
        );
        const effectiveCooldownMs = Math.max(0, transientCooldownUntilMs - cooldownStartedAt);
        logger(
          `sendChatAction transient error (${consecutiveTransientFailures}). ` +
            `Cooling down ${effectiveCooldownMs}ms before retry.`,
        );
      } else if (attemptFailureVersion === failureVersion) {
        clearTransientCooldown();
      }
      throw error;
    } finally {
      releaseAuthorizationRetry?.();
    }
  };

  // Install before the scheduler so admission runs after its final queue wait.
  const apiTransformer: Transformer = async (prev, method, payload, signal) => {
    if (method !== "sendChatAction") {
      return prev(method, payload, signal);
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }
    try {
      return await sendWithBackoff(async () => {
        const result = await prev(method, payload, signal);
        if (!result.ok) {
          throw new GrammyError(`Call to '${method}' failed!`, result, method, payload);
        }
        return result;
      }, controller.signal);
    } finally {
      signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  };

  return {
    apiTransformer,
    sendChatAction,
    isSuspended: () => suspended,
    reset,
  };
}
