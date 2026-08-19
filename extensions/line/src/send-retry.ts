// Line plugin module implements push retry policy behavior.
import { HTTPFetchError } from "@line/bot-sdk";
import { collectErrorGraphCandidates, extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  classifyTransientNetworkErrorCode,
  createChannelApiRetryRunner,
} from "openclaw/plugin-sdk/retry-runtime";

function isRetryableLinePushError(error: unknown): boolean {
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
