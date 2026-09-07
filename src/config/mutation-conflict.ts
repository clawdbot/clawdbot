/** Raised when a config write loses an optimistic snapshot race. */
export class ConfigMutationConflictError extends Error {
  readonly retryable: boolean;

  constructor(message: string, params: { retryable?: boolean } = {}) {
    super(message);
    this.name = "ConfigMutationConflictError";
    this.retryable = params.retryable ?? true;
  }
}
export const GUARDED_CONFIG_INCLUDE_WRITE_ERROR =
  "This approved operation cannot update include-owned configuration. Use a trusted shell for this change.";
