/** Carries and discovers canonical terminal outcomes through thrown-error boundaries. */
import type { AgentRunTerminalOutcome } from "./agent-run-terminal-outcome.js";

/** Carries a canonical terminal outcome when an embedded attempt exits by throwing. */
export class AgentRunTerminalOutcomeError extends Error {
  readonly terminalOutcome: AgentRunTerminalOutcome;

  constructor(error: unknown, terminalOutcome: AgentRunTerminalOutcome) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "AgentRunTerminalOutcomeError";
    this.terminalOutcome = terminalOutcome;
  }
}

/** Finds a canonical terminal outcome through ordinary error wrapper boundaries. */
export function findAgentRunTerminalOutcome(error: unknown): AgentRunTerminalOutcome | undefined {
  let candidate = error;
  const seen = new Set<object>();
  while (candidate && typeof candidate === "object" && !seen.has(candidate)) {
    seen.add(candidate);
    if (candidate instanceof AgentRunTerminalOutcomeError) {
      return candidate.terminalOutcome;
    }
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return undefined;
}
