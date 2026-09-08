/** Structured error reason used while the gateway drains for a restart. */
export const GATEWAY_RESTART_UNAVAILABLE_REASON = "gateway-restarting";
/** Structured error reason used while the gateway drains for a suspension. */
export const GATEWAY_SUSPEND_UNAVAILABLE_REASON = "gateway-suspending";

/** Detects the structured retryable error emitted while a restart drain refuses work. */
export function isGatewayRestartUnavailableError(error: unknown): boolean {
  return hasUnavailableReason(error, GATEWAY_RESTART_UNAVAILABLE_REASON);
}

/** Detects the structured retryable error emitted while suspension refuses work. */
export function isGatewaySuspendUnavailableError(error: unknown): boolean {
  return hasUnavailableReason(error, GATEWAY_SUSPEND_UNAVAILABLE_REASON);
}

function hasUnavailableReason(error: unknown, reason: string): boolean {
  if (!error || typeof error !== "object" || !("details" in error)) {
    return false;
  }
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    "reason" in details &&
    details.reason === reason
  );
}
