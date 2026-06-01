const NON_TERMINAL_AGENT_RUN_STATUSES = new Set(["accepted", "started", "in_flight"]);

/** Returns true for agent-run statuses that still need polling or live updates. */
export function isNonTerminalAgentRunStatus(status: unknown): boolean {
  return typeof status === "string" && NON_TERMINAL_AGENT_RUN_STATUSES.has(status);
}
