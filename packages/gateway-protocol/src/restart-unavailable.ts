/** Structured error reason used while the gateway drains for a restart. */
export const GATEWAY_RESTART_UNAVAILABLE_REASON = "gateway-restarting";
/** Structured error reason used while the gateway drains for a suspension. */
export const GATEWAY_SUSPEND_UNAVAILABLE_REASON = "gateway-suspending";

/** Detects the structured retryable error emitted while a restart drain refuses work. */
export function isGatewayRestartUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  // SAFETY: optional read off an untrusted shape; the reason equality gates the result.
  const details = (error as { details?: unknown }).details;
  return (
    typeof details === "object" &&
    details !== null &&
    // SAFETY: same untrusted-shape read, guarded by the equality check.
    (details as { reason?: unknown }).reason === GATEWAY_RESTART_UNAVAILABLE_REASON
  );
}
