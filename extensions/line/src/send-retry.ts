// Line plugin module implements push retry policy behavior.
import { HTTPFetchError } from "@line/bot-sdk";
import { collectErrorGraphCandidates, extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  classifyTransientNetworkErrorCode,
  createChannelApiRetryRunner,
} from "openclaw/plugin-sdk/retry-runtime";

/** The LINE HTTP response carried by an error graph, when the request reached LINE. */
export function findLineHttpError(error: unknown): HTTPFetchError | undefined {
  return collectErrorGraphCandidates(error, (candidate) => [candidate.cause, candidate.error]).find(
    (candidate): candidate is HTTPFetchError => candidate instanceof HTTPFetchError,
  );
}

/**
 * LINE answered this attempt with a client error, so it rejected the request and
 * sent nothing.
 *
 * Narrower than the in-request policy below: a rate limit or a request timeout
 * can still succeed on a later delivery attempt, so they stay ambiguous even
 * though neither is worth replaying inside the same send.
 */
function isDefinitiveAttemptRejection(error: unknown): boolean {
  const status = findLineHttpError(error)?.status;
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

// A push that was retried can only prove "nothing was sent" when LINE itself
// refused every attempt. Any attempt LINE never answered is treated as unproven
// here, including a pre-connect failure that core can still prove by other
// means, because this module cannot tell the two apart from the error alone.
const pushErrorsWithAmbiguousAttempt = new WeakSet<object>();

/** True when LINE refused every attempt of this push, so none of them was sent. */
export function isLineDefinitiveRejection(error: unknown): boolean {
  if (typeof error === "object" && error !== null && pushErrorsWithAmbiguousAttempt.has(error)) {
    return false;
  }
  return isDefinitiveAttemptRejection(error);
}

function isRetryableLinePushError(error: unknown): boolean {
  const httpError = findLineHttpError(error);
  if (httpError) {
    // LINE documents server errors and transport failures as the retriable
    // outcomes; every 4xx (429 included) answers "retries don't change the result".
    return httpError.status >= 500;
  }
  // A transport failure never reached a LINE response, so the retry key decides
  // whether the earlier attempt already landed.
  return collectErrorGraphCandidates(error, (candidate) => [candidate.cause, candidate.error]).some(
    (candidate) => classifyTransientNetworkErrorCode(extractErrorCode(candidate)) !== undefined,
  );
}

/**
 * Pushes are non-idempotent without a retry key, so the generic message-matching
 * fallback stays off and only the classification above may replay a request.
 */
const runLinePushAttempts = createChannelApiRetryRunner({
  shouldRetry: isRetryableLinePushError,
  strictShouldRetry: true,
  verbose: true,
});

export const runLinePushWithRetries: typeof runLinePushAttempts = (fn, label) => {
  let sawAmbiguousAttempt = false;
  return runLinePushAttempts(async () => {
    try {
      return await fn();
    } catch (error) {
      sawAmbiguousAttempt ||= !isDefinitiveAttemptRejection(error);
      throw error;
    }
  }, label).catch((error: unknown) => {
    if (sawAmbiguousAttempt && typeof error === "object" && error !== null) {
      pushErrorsWithAmbiguousAttempt.add(error);
    }
    throw error;
  });
};
