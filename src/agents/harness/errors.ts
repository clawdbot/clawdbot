export class MissingAgentHarnessError extends Error {
  readonly harnessId: string;

  constructor(harnessId: string) {
    super(`Requested agent harness "${harnessId}" is not registered.`);
    this.name = "MissingAgentHarnessError";
    this.harnessId = harnessId;
  }
}

export function isMissingAgentHarnessError(err: unknown): err is MissingAgentHarnessError {
  return err instanceof MissingAgentHarnessError;
}
