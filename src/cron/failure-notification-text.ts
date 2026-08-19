import type { FailoverReason } from "../agents/failover/signal.js";

/** Keeps arbitrary runtime errors in automation history instead of chat copy. */
export function cronFailureDetailLines(errorReason: FailoverReason | undefined): string[] {
  return errorReason ? [`Cause: ${errorReason}`] : ["Check automation history for details."];
}
