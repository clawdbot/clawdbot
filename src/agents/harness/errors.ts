/**
 * Agent harness error helpers.
 *
 * Registry and runtime callers use this stable error type to distinguish missing
 * harness selection from ordinary harness execution failures.
 */
/** Error thrown when a requested harness id is not registered. */
export class MissingAgentHarnessError extends Error {
  readonly harnessId: string;

  constructor(harnessId: string) {
    super(`Requested agent harness "${harnessId}" is not registered.`);
    this.name = "MissingAgentHarnessError";
    this.harnessId = harnessId;
  }
}

/** Returns whether an error is a missing harness error. */
export function isMissingAgentHarnessError(err: unknown): err is MissingAgentHarnessError {
  return err instanceof MissingAgentHarnessError;
}

/** A harness lost ownership of the session generation before the attempt could start. */
export class AgentHarnessSessionSupersededError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentHarnessSessionSupersededError";
  }
}
