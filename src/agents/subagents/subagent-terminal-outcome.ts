import {
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agent-run-terminal-outcome.js";
import { isAbortedAgentStopReason } from "../run-termination.js";

/** Subagents apply explicit cancellation ownership before incomplete liveness projections. */
export const classifySubagentTerminalOutcome = (outcome: AgentRunTerminalOutcome) =>
  isAbortedAgentStopReason(outcome.stopReason)
    ? "cancellation"
    : classifyAgentRunTerminalOutcome(outcome);
