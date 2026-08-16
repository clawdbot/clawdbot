// Line plugin module implements push retry policy behavior.
import { createHash, randomUUID } from "node:crypto";
import { HTTPFetchError } from "@line/bot-sdk";
import { collectErrorGraphCandidates, extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  classifyTransientNetworkErrorCode,
  createChannelApiRetryRunner,
} from "openclaw/plugin-sdk/retry-runtime";

/** LINE keeps a retry key for 24 hours; past that a replay delivers a second copy. */
export const LINE_RETRY_KEY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Derives the retry key for one platform send. A durable intent id produces the
 * same key in every process, so recovery can replay the exact request that may
 * already have been accepted; unqueued sends fall back to a fresh key.
 * The key spans both indices because core numbers the parts it plans while the
 * payload sender numbers the pushes one part fans out into.
 */
export function resolveLinePushRetryKey(params: {
  deliveryQueueId?: string | null;
  partIndex?: number;
  pushIndex?: number;
}): string {
  const durableId = params.deliveryQueueId?.trim();
  if (!durableId) {
    return randomUUID();
  }
  const digest = createHash("sha256")
    .update(`line:push-retry-key:${durableId}:${params.partIndex ?? 0}:${params.pushIndex ?? 0}`)
    .digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    digest.slice(12, 16),
    digest.slice(16, 20),
    digest.slice(20, 32),
  ].join("-");
}

export function getLinePushHttpStatus(error: unknown): number | undefined {
  return collectErrorGraphCandidates(error, (candidate) => [candidate.cause, candidate.error]).find(
    (candidate): candidate is HTTPFetchError => candidate instanceof HTTPFetchError,
  )?.status;
}

export function isRetryableLinePushError(error: unknown): boolean {
  const candidates = collectErrorGraphCandidates(error, (candidate) => [
    candidate.cause,
    candidate.error,
  ]);
  const httpError = candidates.find(
    (candidate): candidate is HTTPFetchError => candidate instanceof HTTPFetchError,
  );
  if (httpError) {
    // LINE documents server errors and transport failures as the retriable
    // outcomes; every 4xx (429 included) answers "retries don't change the result".
    return httpError.status >= 500;
  }
  // A transport failure never reached a LINE response, so the retry key decides
  // whether the earlier attempt already landed.
  return candidates.some(
    (candidate) => classifyTransientNetworkErrorCode(extractErrorCode(candidate)) !== undefined,
  );
}

/**
 * Pushes are non-idempotent without a retry key, so the generic message-matching
 * fallback stays off and only the classification above may replay a request.
 */
export const runLinePushWithRetries = createChannelApiRetryRunner({
  shouldRetry: isRetryableLinePushError,
  strictShouldRetry: true,
  verbose: true,
});
