// Line plugin module implements push retry policy behavior.
import { HTTPFetchError } from "@line/bot-sdk";
import { collectErrorGraphCandidates, extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  classifyTransientNetworkErrorCode,
  createChannelApiRetryRunner,
} from "openclaw/plugin-sdk/retry-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { describeLineQuotaRefusal, isLineMessageQuotaExhausted } from "./message-quota.js";
import type { LineMessageQuota } from "./types.js";

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

/** How long any refused send may spend asking LINE about the allowance. */
const REFUSAL_QUOTA_BUDGET_MS = 2_000;

/**
 * Refines a refusal verdict with the account's monthly allowance.
 *
 * LINE answers both "too many requests right now" and "no monthly messages left"
 * with 429, and only the first is worth retrying: the allowance resets on the
 * calendar month, so durable delivery would hold the reply for weeks while the
 * operator sees nothing. The quota is read from LINE, which owns it, so the two
 * cases stay apart without matching provider error text. An unreadable quota
 * keeps the plain verdict, so a rate limit stays retryable exactly as before.
 */
async function resolveLineRefusalRetryable(params: {
  error: unknown;
  readQuota: () => Promise<LineMessageQuota | undefined>;
}): Promise<boolean | undefined> {
  const retryable = resolveLineNonDispatchRetryable(params.error);
  if (retryable !== true || findLineHttpError(params.error)?.status !== 429) {
    return retryable;
  }
  const quota = await params.readQuota();
  return quota && isLineMessageQuotaExhausted(quota) ? false : retryable;
}

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

/**
 * The single explanation every LINE refusal report goes through.
 *
 * Both the durable outbound adapter and the direct inbound reply sender end at
 * the same push API and can be refused for the same spent allowance, so they
 * share one verdict and one operator-facing reason instead of each deciding for
 * itself. The allowance is read at most once per refusal.
 */
export async function explainLineRefusal(params: {
  error: unknown;
  readQuota: () => Promise<LineMessageQuota | undefined>;
}): Promise<{ retryable: boolean | undefined; reason: string }> {
  let quota: LineMessageQuota | undefined;
  let read = false;
  const readOnce = async () => {
    if (!read) {
      read = true;
      // The refusal already has a verdict; the allowance only refines it. Every
      // refusal report shares this one deadline so a stalled allowance endpoint
      // can never hold a retryable 429 back from the delivery that is waiting on
      // it — the original verdict stands instead.
      quota = await withTimeout(
        params.readQuota(),
        REFUSAL_QUOTA_BUDGET_MS,
        "line quota refusal",
      ).catch(() => undefined);
    }
    return quota;
  };
  const retryable = await resolveLineRefusalRetryable({ error: params.error, readQuota: readOnce });
  const reason =
    describeLineQuotaRefusal(quota) ??
    (params.error instanceof Error ? params.error.message : "LINE rejected the message");
  return { retryable, reason };
}
