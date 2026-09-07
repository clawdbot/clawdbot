import {
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agent-run-terminal-outcome.js";
import type { AgentRunDisposition } from "../internal-event-contract.js";
import { isAbortedAgentStopReason } from "../run-termination.js";
import type { SubagentRunOutcome } from "./announce/subagent-announce-output.js";

/** Subagents apply explicit cancellation ownership after canonical timeout attribution. */
export function classifySubagentTerminalOutcome(outcome: AgentRunTerminalOutcome) {
  const classification = classifyAgentRunTerminalOutcome(outcome);
  return classification === "timeout" || !isAbortedAgentStopReason(outcome.stopReason)
    ? classification
    : "cancellation";
}

/** Read legacy wait evidence through the same public disposition as new outcomes. */
export function resolveSubagentRunDisposition(
  outcome: SubagentRunOutcome | undefined,
): AgentRunDisposition {
  if (outcome?.disposition) {
    return outcome.disposition;
  }
  if (outcome?.status === "timeout" && outcome.timeoutDisposition) {
    return outcome.timeoutDisposition === "child-unconfirmed" ? "still-running" : "exited";
  }
  return "exited";
}
