/**
 * Shared agent run termination constants.
 *
 * Runtime and stream consumers use these stable literals to recognize user or
 * controller aborts without matching free-form error text.
 */
/** Stop reason emitted when an agent run is aborted. */
export const AGENT_RUN_ABORTED_STOP_REASON = "aborted" as const;
/** Error text used for aborted agent runs. */
export const AGENT_RUN_ABORTED_ERROR = "agent run aborted" as const;

/** Returns whether a stop reason is the stable aborted-run reason. */
export function isAbortedAgentStopReason(
  value: unknown,
): value is typeof AGENT_RUN_ABORTED_STOP_REASON {
  return value === AGENT_RUN_ABORTED_STOP_REASON;
}
