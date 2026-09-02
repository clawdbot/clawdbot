// Line plugin module implements push retry policy behavior.
import { HTTPFetchError } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { collectErrorGraphCandidates, extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  classifyTransientNetworkErrorCode,
  createChannelApiRetryRunner,
} from "openclaw/plugin-sdk/retry-runtime";
import { readLineAccountMessageQuota } from "./probe.js";

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
 * A 429 proves this attempt was refused but remains retryable by durable
 * delivery. A 408 stays ambiguous because the request may have reached LINE.
 */
function resolveAttemptNonDispatchRetryable(error: unknown): boolean | undefined {
  const status = findLineHttpError(error)?.status;
  if (status === 429) {
    return true;
  }
  // The send owner consumes retry-key 409 as an accepted delivery. Never let a
  // wrapped/injected form cross this boundary as proof that nothing was sent.
  if (status === 409) {
    return undefined;
  }
  return status !== undefined && status >= 400 && status < 500 && status !== 408
    ? false
    : undefined;
}

// A push that was retried can only prove "nothing was sent" when LINE itself
// refused every attempt. Any attempt LINE never answered is treated as unproven
// here, including a pre-connect failure that core can still prove by other
// means, because this module cannot tell the two apart from the error alone.
const pushErrorsWithAmbiguousAttempt = new WeakSet<object>();

/** Retryability when LINE refused every attempt, or undefined when delivery is ambiguous. */
export function resolveLineNonDispatchRetryable(error: unknown): boolean | undefined {
  const hasAmbiguousAttempt = collectErrorGraphCandidates(error, (candidate) => [
    candidate.cause,
    candidate.error,
  ]).some(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      pushErrorsWithAmbiguousAttempt.has(candidate),
  );
  if (hasAmbiguousAttempt) {
    return undefined;
  }
  return resolveAttemptNonDispatchRetryable(error);
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
      sawAmbiguousAttempt ||= resolveAttemptNonDispatchRetryable(error) === undefined;
      throw error;
    }
  }, label).catch((error: unknown) => {
    if (sawAmbiguousAttempt && typeof error === "object" && error !== null) {
      pushErrorsWithAmbiguousAttempt.add(error);
    }
    throw error;
  });
};

export async function explainLineRefusal(params: {
  error: unknown;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<{ retryable: boolean | undefined; reason: string }> {
  const retryable = resolveLineNonDispatchRetryable(params.error);
  const quota =
    retryable === true && findLineHttpError(params.error)?.status === 429
      ? await readLineAccountMessageQuota(params)
      : undefined;
  const exhausted = quota?.kind === "limited" && quota.used >= quota.limit;
  return {
    retryable: exhausted ? false : retryable,
    reason: exhausted
      ? `LINE refused the push: ${quota.used}/${quota.limit} monthly messages used. Check the account allowance or plan before retrying.`
      : params.error instanceof Error
        ? params.error.message
        : "LINE rejected the message",
  };
}
