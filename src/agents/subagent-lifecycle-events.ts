/**
 * Shared subagent lifecycle event literals.
 *
 * Event writers and readers use these constants to keep subagent target,
 * end-reason, and outcome values stable across registry/runtime boundaries.
 */
/** Target kind used for subagent lifecycle events. */
export const SUBAGENT_TARGET_KIND_SUBAGENT = "subagent" as const;

/** End reason for a completed subagent run. */
export const SUBAGENT_ENDED_REASON_COMPLETE = "subagent-complete" as const;
/** End reason for a failed subagent run. */
export const SUBAGENT_ENDED_REASON_ERROR = "subagent-error" as const;
/** End reason for an explicitly killed subagent run. */
export const SUBAGENT_ENDED_REASON_KILLED = "subagent-killed" as const;

/** Allowed subagent lifecycle end reason literals. */
export type SubagentLifecycleEndedReason =
  | typeof SUBAGENT_ENDED_REASON_COMPLETE
  | typeof SUBAGENT_ENDED_REASON_ERROR
  | typeof SUBAGENT_ENDED_REASON_KILLED;

/** Successful subagent lifecycle outcome. */
export const SUBAGENT_ENDED_OUTCOME_OK = "ok" as const;
/** Error subagent lifecycle outcome. */
export const SUBAGENT_ENDED_OUTCOME_ERROR = "error" as const;
/** Timeout subagent lifecycle outcome. */
export const SUBAGENT_ENDED_OUTCOME_TIMEOUT = "timeout" as const;
/** Killed subagent lifecycle outcome. */
export const SUBAGENT_ENDED_OUTCOME_KILLED = "killed" as const;

/** Allowed subagent lifecycle outcome literals. */
export type SubagentLifecycleEndedOutcome =
  | typeof SUBAGENT_ENDED_OUTCOME_OK
  | typeof SUBAGENT_ENDED_OUTCOME_ERROR
  | typeof SUBAGENT_ENDED_OUTCOME_TIMEOUT
  | typeof SUBAGENT_ENDED_OUTCOME_KILLED;
