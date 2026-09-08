/** A scoped guard rejected the request before a physical write. */
export class CodexAppServerScopedRequestRejectedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAppServerScopedRequestRejectedError";
  }
}

/** Raised when a thread subscription may be live on a client OpenClaw no longer controls. */
export class CodexAppServerUnsafeSubscriptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAppServerUnsafeSubscriptionError";
  }
}
