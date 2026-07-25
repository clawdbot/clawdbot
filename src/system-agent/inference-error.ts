type SystemAgentInferenceStage = "agent-turn" | "planner" | "conversation";

/** Safe public error for an OpenClaw turn that could not complete with intelligence. */
export class SystemAgentInferenceUnavailableError extends Error {
  readonly code = "SYSTEM_AGENT_INFERENCE_UNAVAILABLE";

  constructor(
    readonly stage: SystemAgentInferenceStage,
    readonly failures: readonly unknown[] = [],
  ) {
    super(
      "OpenClaw could not reach working inference. Run `openclaw onboard` to reconnect and live-test AI, then try again.",
    );
    this.name = "SystemAgentInferenceUnavailableError";
  }
}

export function isSystemAgentInferenceUnavailableError(
  error: unknown,
): error is SystemAgentInferenceUnavailableError {
  return (
    error instanceof SystemAgentInferenceUnavailableError ||
    (error instanceof Error &&
      "code" in error &&
      error.code === "SYSTEM_AGENT_INFERENCE_UNAVAILABLE")
  );
}
