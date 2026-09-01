// Keep attempt history off the thrown object so retryAsync preserves the
// terminal error's identity and shape for existing callers.
const retryAttemptErrors = new WeakMap<object, readonly unknown[]>();

export function recordRetryAttemptErrors(error: object, attemptErrors: readonly unknown[]): void {
  retryAttemptErrors.set(error, [...attemptErrors]);
}

export function getRetryAttemptErrors(err: unknown): readonly unknown[] | undefined {
  return err !== null && (typeof err === "object" || typeof err === "function")
    ? retryAttemptErrors.get(err)
    : undefined;
}
