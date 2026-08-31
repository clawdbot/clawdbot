// Adapts the dependency-free retry scheduler to core runtime facilities.
import {
  createRetryRunner,
  resolveRetryConfig,
  toRetryError,
  type RetryConfig,
  type RetryInfo,
  type RetryOptions,
} from "../../packages/retry/src/index.js";
import { getRetryAttemptErrors, recordRetryAttemptErrors } from "./retry-attempt-errors.js";
import { generateSecureFraction } from "./secure-random.js";

export { resolveRetryConfig, type RetryConfig, type RetryInfo, type RetryOptions };

function createRetryFailure(rawAttemptErrors: readonly unknown[]): Error {
  const attemptErrors = rawAttemptErrors.flatMap((err) => getRetryAttemptErrors(err) ?? [err]);
  const failure = toRetryError(
    attemptErrors.at(-1) ?? new Error("Retry failed"),
    "Non-Error thrown",
  );
  if (attemptErrors.length > 1) {
    // Preserve terminal-error identity while carrying all attempts into
    // duplicate-send decisions outside the channel adapter.
    recordRetryAttemptErrors(failure, attemptErrors);
  }
  return failure;
}

/** Runs an async operation until it succeeds, policy stops, or attempts are exhausted. */
export const retryAsync = createRetryRunner({
  random: generateSecureFraction,
  createFailure: createRetryFailure,
});
