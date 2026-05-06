const NON_TERMINAL_AGENT_RUN_STATUSES = new Set(["accepted", "started", "in_flight"]);

export function isNonTerminalAgentRunStatus(status: unknown): boolean {
  return typeof status === "string" && NON_TERMINAL_AGENT_RUN_STATUSES.has(status);
}
