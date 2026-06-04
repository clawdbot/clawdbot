/**
 * Shared agent-run status predicates for gateway wait loops and delivery announcements.
 * Keep the status set aligned with the gateway protocol values that can still transition.
 */
/** Statuses that are not final and should keep waiters/subscribers attached. */
const NON_TERMINAL_AGENT_RUN_STATUSES = new Set(["accepted", "started", "in_flight"]);

/** Returns true for agent-run statuses that still need polling or live updates. */
export function isNonTerminalAgentRunStatus(status: unknown): boolean {
  return typeof status === "string" && NON_TERMINAL_AGENT_RUN_STATUSES.has(status);
}
