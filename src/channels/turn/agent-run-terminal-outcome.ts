import { isRecord } from "@openclaw/normalization-core/record-coerce";

export type AgentRunTerminalOutcome = "completed" | "failed";

const AGENT_RUN_TERMINAL_OUTCOME: unique symbol = Symbol.for(
  "openclaw.agentRunTerminalOutcome",
) as never;

export function recordAgentRunTerminalOutcome<T extends object>(
  result: T,
  outcome: AgentRunTerminalOutcome,
): T {
  return Object.assign(result, { [AGENT_RUN_TERMINAL_OUTCOME]: outcome });
}

export function readAgentRunTerminalOutcome(result: unknown): AgentRunTerminalOutcome | undefined {
  const outcome =
    isRecord(result) && Object.hasOwn(result, AGENT_RUN_TERMINAL_OUTCOME)
      ? Reflect.get(result, AGENT_RUN_TERMINAL_OUTCOME)
      : undefined;
  return outcome === "completed" || outcome === "failed" ? outcome : undefined;
}
