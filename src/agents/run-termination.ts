export const AGENT_RUN_ABORTED_STOP_REASON = "aborted" as const;
export const AGENT_RUN_ABORTED_ERROR = "agent run aborted" as const;

export function isAbortedAgentStopReason(
  value: unknown,
): value is typeof AGENT_RUN_ABORTED_STOP_REASON {
  return value === AGENT_RUN_ABORTED_STOP_REASON;
}
