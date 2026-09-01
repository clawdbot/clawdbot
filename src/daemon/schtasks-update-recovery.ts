/** A failed native compensation, distinct from an untouched update refusal. */
export class ScheduledTaskAutoStartRecoveryError extends AggregateError {
  // Environment context is private so ordinary error inspection cannot log secrets.
  readonly #serviceEnv: NodeJS.ProcessEnv;

  constructor(errors: unknown[], message: string, serviceEnv: NodeJS.ProcessEnv) {
    super(errors, message, { cause: errors.at(-1) });
    this.name = "ScheduledTaskAutoStartRecoveryError";
    this.#serviceEnv = { ...serviceEnv };
  }

  get serviceEnv(): NodeJS.ProcessEnv {
    return this.#serviceEnv;
  }
}
