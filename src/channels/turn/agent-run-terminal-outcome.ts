import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type AgentRunTerminalOutcome = "completed" | "failed";

const AGENT_RUN_TERMINAL_OUTCOME: unique symbol = Symbol.for(
  "openclaw.agentRunTerminalOutcome",
) as never;
// Keep the existing SDK outcome carrier unchanged; diagnostics must stay out of JSON.
const AGENT_RUN_TERMINAL_ERROR = Symbol.for("openclaw.agentRunTerminalError");

export function recordAgentRunTerminalOutcome<T extends object>(
  result: T,
  outcome: AgentRunTerminalOutcome,
  error?: string,
): T {
  return Object.assign(result, {
    [AGENT_RUN_TERMINAL_OUTCOME]: outcome,
    [AGENT_RUN_TERMINAL_ERROR]: outcome === "failed" ? error : undefined,
  });
}

export function readAgentRunTerminalOutcome(result: unknown): AgentRunTerminalOutcome | undefined {
  const outcome =
    isRecord(result) && Object.hasOwn(result, AGENT_RUN_TERMINAL_OUTCOME)
      ? Reflect.get(result, AGENT_RUN_TERMINAL_OUTCOME)
      : undefined;
  return outcome === "completed" || outcome === "failed" ? outcome : undefined;
}

/** Carries the producer's final diagnostic without changing the JSON response. */
export function readAgentRunTerminalError(result: unknown): string | undefined {
  if (
    !isRecord(result) ||
    readAgentRunTerminalOutcome(result) !== "failed" ||
    !Object.hasOwn(result, AGENT_RUN_TERMINAL_ERROR)
  ) {
    return undefined;
  }
  const error = Reflect.get(result, AGENT_RUN_TERMINAL_ERROR);
  return typeof error === "string" ? error : undefined;
}
