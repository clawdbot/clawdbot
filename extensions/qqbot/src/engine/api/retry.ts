/**
 * Generic retry engine for QQ Bot API requests.
 *
 * Replaces the three separate retry implementations in the old `api.ts`:
 * - `apiRequestWithRetry` (upload retry with exponential backoff)
 * - `partFinishWithRetry` (part-finish retry + persistent retry on specific biz codes)
 * - `completeUploadWithRetry` (unconditional retry for complete-upload)
 *
 * All three patterns are expressed as a single `withRetry` function
 * parameterized by `RetryPolicy` and optional `PersistentRetryPolicy`.
 */

import type { EngineLogger } from "../types.js";
import { formatErrorMessage } from "../utils/format.js";

/** Standard retry policy with exponential or fixed backoff. */
export interface RetryPolicy {
  /** Maximum retry attempts (excluding the initial attempt). */
  maxRetries: number;
  /** Base delay in milliseconds. */
  baseDelayMs: number;
  /** Backoff strategy. */
  backoff: "exponential" | "fixed";
  /**
   * Predicate to decide whether an error is retryable.
   * Return `false` to immediately rethrow.
   * Defaults to always-retry when omitted.
   */
  shouldRetry?: (error: Error, attempt: number) => boolean;
}

/**
 * Persistent retry policy for specific business error codes.
 *
 * When `shouldPersistRetry` returns true, the engine switches from
 * the standard retry loop into a tight fixed-interval loop bounded
 * only by the total timeout.
 */
export interface PersistentRetryPolicy {
  /** Total timeout in milliseconds for the persistent retry loop. */
  timeoutMs: number;
  /** Fixed interval between retries in milliseconds. */
  intervalMs: number;
  /** Predicate to decide whether an error triggers persistent retry. */
  shouldPersistRetry: (error: Error) => boolean;
}

/**
 * Execute an async operation with configurable retry semantics.
 *
 * @param fn - The async operation to retry.
 * @param policy - Standard retry configuration.
 * @param persistentPolicy - Optional persistent retry for specific error codes.
 * @param logger - Optional logger for retry diagnostics.
 * @returns The result of the first successful invocation.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  persistentPolicy?: PersistentRetryPolicy,
  logger?: EngineLogger,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(formatErrorMessage(err));

      // Check for persistent-retry trigger before standard retry logic.
      if (persistentPolicy?.shouldPersistRetry(lastError)) {
        (logger?.warn ?? logger?.error)?.(
          `[qqbot:retry] Hit persistent-retry trigger, entering persistent loop (timeout=${persistentPolicy.timeoutMs / 1000}s)`,
        );
        return await persistentRetryLoop(fn, persistentPolicy, logger);
      }

      // Check whether this error is retryable under the standard policy.
      if (policy.shouldRetry?.(lastError, attempt) === false) {
        throw lastError;
      }

      // Schedule the next retry with the configured backoff.
      if (attempt < policy.maxRetries) {
        const delay =
          policy.backoff === "exponential"
            ? policy.baseDelayMs * Math.pow(2, attempt)
            : policy.baseDelayMs;

        logger?.debug?.(
          `[qqbot:retry] Attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message.slice(0, 100)}`,
        );
        await sleep(delay);
      }
    }
  }

  throw lastError!;
}

/**
 * Persistent retry loop: fixed-interval retries bounded by a total timeout.
 *
 * Used for `upload_part_finish` when the server returns specific business
 * error codes indicating the backend is still processing.
 */
async function persistentRetryLoop<T>(
  fn: () => Promise<T>,
  policy: PersistentRetryPolicy,
  logger?: EngineLogger,
): Promise<T> {
  const deadline = Date.now() + policy.timeoutMs;
  let attempt = 0;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      const result = await fn();
      logger?.debug?.(`[qqbot:retry] Persistent retry succeeded after ${attempt} retries`);
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(formatErrorMessage(err));

      // If the error is no longer retryable, abort immediately.
      if (!policy.shouldPersistRetry(lastError)) {
        logger?.error?.(`[qqbot:retry] Persistent retry: error is no longer retryable, aborting`);
        throw lastError;
      }

      attempt++;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }

      const actualDelay = Math.min(policy.intervalMs, remaining);
      (logger?.warn ?? logger?.error)?.(
        `[qqbot:retry] Persistent retry #${attempt}: retrying in ${actualDelay}ms (remaining=${Math.round(remaining / 1000)}s)`,
      );
      await sleep(actualDelay);
    }
  }

  logger?.error?.(
    `[qqbot:retry] Persistent retry timed out after ${policy.timeoutMs / 1000}s (${attempt} attempts)`,
  );
  throw lastError ?? new Error(`Persistent retry timed out (${policy.timeoutMs / 1000}s)`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============ Pre-built Retry Policies ============

/** Standard upload retry: exponential backoff, skip 400/401/timeout errors. */
export const UPLOAD_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1000,
  backoff: "exponential",
  shouldRetry: (error) => {
    const msg = error.message;
    return !(
      msg.includes("400") ||
      msg.includes("401") ||
      msg.includes("Invalid") ||
      msg.includes("timeout") ||
      msg.includes("Timeout")
    );
  },
};

/** Complete-upload retry: unconditional retry with exponential backoff. */
export const COMPLETE_UPLOAD_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 2000,
  backoff: "exponential",
  // Always retry — complete-upload failures are often transient server-side.
};

/** Part-finish standard retry policy. */
export const PART_FINISH_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1000,
  backoff: "exponential",
};

/**
 * Build a persistent retry policy for part-finish with a specific timeout.
 *
 * @param retryTimeoutMs - Total timeout (defaults to 2 minutes).
 * @param retryableCodes - Business error codes that trigger persistent retry.
 */
export function buildPartFinishPersistentPolicy(
  retryTimeoutMs?: number,
  retryableCodes: Set<number> = PART_FINISH_RETRYABLE_CODES,
): PersistentRetryPolicy {
  return {
    timeoutMs: retryTimeoutMs ?? 2 * 60 * 1000,
    intervalMs: 1000,
    shouldPersistRetry: (error) => {
      if (retryableCodes.size === 0) {
        return false;
      }
      // Check for ApiError with matching bizCode.
      if ("bizCode" in error && typeof (error as { bizCode?: number }).bizCode === "number") {
        return retryableCodes.has((error as { bizCode: number }).bizCode);
      }
      return false;
    },
  };
}

/** Business error codes that trigger persistent part-finish retry. */
export const PART_FINISH_RETRYABLE_CODES: Set<number> = new Set([40093001]);

/** upload_prepare error code indicating daily limit exceeded. */
export const UPLOAD_PREPARE_FALLBACK_CODE = 40093002;
