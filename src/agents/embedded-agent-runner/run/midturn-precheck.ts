/**
 * Signals mid-turn prechecks that require preemptive compaction routing.
 */
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

/**
 * Captures the token-pressure snapshot that made the mid-turn tool-result guard
 * stop the attempt before another model call.
 */
export type MidTurnPrecheckRequest = {
  route: Exclude<PreemptiveCompactionRoute, "fits">;
  estimatedPromptTokens: number;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  effectiveReserveTokens: number;
};

/** Stable message used to identify synthetic mid-turn overflow errors in session cleanup. */
export const MID_TURN_PRECHECK_ERROR_MESSAGE =
  "Context overflow: prompt too large for the model (mid-turn precheck).";

/**
 * Internal control-flow signal thrown after a tool result makes the next prompt
 * exceed budget. The attempt runner catches it and routes through the overflow
 * recovery path instead of treating it as an ordinary provider failure.
 */
export class MidTurnPrecheckSignal extends Error {
  readonly request: MidTurnPrecheckRequest;

  constructor(request: MidTurnPrecheckRequest) {
    super(MID_TURN_PRECHECK_ERROR_MESSAGE);
    this.name = "MidTurnPrecheckSignal";
    this.request = request;
  }
}

/** Narrows unknown errors to the mid-turn overflow signal used by attempt cleanup. */
export function isMidTurnPrecheckSignal(error: unknown): error is MidTurnPrecheckSignal {
  return error instanceof MidTurnPrecheckSignal;
}
