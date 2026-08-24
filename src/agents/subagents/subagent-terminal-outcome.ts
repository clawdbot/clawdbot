import {
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agent-run-terminal-outcome.js";
import { isAbortedAgentStopReason } from "../run-termination.js";

/** Subagents apply explicit cancellation ownership after canonical timeout attribution. */
export function classifySubagentTerminalOutcome(outcome: AgentRunTerminalOutcome) {
  const classification = classifyAgentRunTerminalOutcome(outcome);
  return classification === "timeout" || !isAbortedAgentStopReason(outcome.stopReason)
    ? classification
    : "cancellation";
}
