export class FeishuRetryableSyntheticEventError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FeishuRetryableSyntheticEventError";
  }
}

export function isFeishuRetryableSyntheticEventError(
  error: unknown,
): error is FeishuRetryableSyntheticEventError {
  return (
    error instanceof FeishuRetryableSyntheticEventError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "FeishuRetryableSyntheticEventError")
  );
}
