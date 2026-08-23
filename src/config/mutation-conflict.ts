/** Raised when a config write loses an optimistic snapshot race. */
export class ConfigMutationConflictError extends Error {
  readonly currentHash: string | null;
  readonly retryable: boolean;

  constructor(message: string, params: { currentHash: string | null; retryable?: boolean }) {
    super(message);
    this.name = "ConfigMutationConflictError";
    this.currentHash = params.currentHash;
    this.retryable = params.retryable ?? true;
  }
}
