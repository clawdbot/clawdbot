type CrestodianInferenceStage = "agent-turn" | "planner" | "conversation";

/** Safe public error for a Crestodian turn that could not complete with intelligence. */
export class CrestodianInferenceUnavailableError extends Error {
  readonly code = "CRESTODIAN_INFERENCE_UNAVAILABLE";

  constructor(
    readonly stage: CrestodianInferenceStage,
    readonly failures: readonly unknown[] = [],
  ) {
    super(
      "Crestodian could not reach working inference. Run `openclaw onboard` to reconnect and live-test AI, then try again.",
    );
    this.name = "CrestodianInferenceUnavailableError";
  }
}

export function isCrestodianInferenceUnavailableError(
  error: unknown,
): error is CrestodianInferenceUnavailableError {
  return (
    error instanceof CrestodianInferenceUnavailableError ||
    (error instanceof Error && "code" in error && error.code === "CRESTODIAN_INFERENCE_UNAVAILABLE")
  );
}
