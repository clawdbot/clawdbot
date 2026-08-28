/** Shared create- and run-time defaults for cron result delivery. */

/**
 * Keep create-time normalization, direct service persistence, and run-time
 * planning on one target policy; disagreement silently drops cron results.
 */
export function shouldDefaultCronDeliveryToAnnounce(params: {
  payloadKind: unknown;
  sessionTarget: unknown;
}): boolean {
  if (
    params.payloadKind !== "agentTurn" &&
    params.payloadKind !== "command" &&
    params.payloadKind !== "script"
  ) {
    return false;
  }
  return (
    params.sessionTarget === "isolated" ||
    params.sessionTarget === "current" ||
    (typeof params.sessionTarget === "string" && params.sessionTarget.startsWith("session:"))
  );
}
