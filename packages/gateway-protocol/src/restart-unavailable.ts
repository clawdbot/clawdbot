/** Structured error reason used while the gateway drains for a restart. */
export const GATEWAY_RESTART_UNAVAILABLE_REASON = "gateway-restarting";
/** Structured error reason used while the gateway drains for a suspension. */
export const GATEWAY_SUSPEND_UNAVAILABLE_REASON = "gateway-suspending";

/** Detects the structured retryable error emitted while a restart drain refuses work. */
export function isGatewayRestartUnavailableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("details" in error)) {
    return false;
  }
  const details = error.details;
  if (typeof details !== "object" || details === null || !("reason" in details)) {
    return false;
  }
  return details.reason === GATEWAY_RESTART_UNAVAILABLE_REASON;
}
