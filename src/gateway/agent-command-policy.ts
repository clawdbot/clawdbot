/** Commands routed through `agent` that mutate session lifecycle state. */
export const AGENT_SESSION_RESET_COMMAND_RE = /^\/(new|reset)(?:\s+([\s\S]*))?$/i;

/** Returns true when an agent message requests a session reset. */
export function isAgentSessionResetCommand(message: unknown): boolean {
  return typeof message === "string" && AGENT_SESSION_RESET_COMMAND_RE.test(message);
}
