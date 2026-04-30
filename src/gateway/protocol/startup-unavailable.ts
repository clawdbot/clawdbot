export const GATEWAY_STARTUP_UNAVAILABLE_REASON = "startup-sidecars";
export const GATEWAY_STARTUP_RETRY_AFTER_MS = 500;
export const GATEWAY_STARTUP_RETRY_MIN_MS = 100;
export const GATEWAY_STARTUP_RETRY_MAX_MS = 2_000;

export type GatewayStartupUnavailableDetails = {
  reason: typeof GATEWAY_STARTUP_UNAVAILABLE_REASON;
};

export function gatewayStartupUnavailableDetails(): GatewayStartupUnavailableDetails {
  return { reason: GATEWAY_STARTUP_UNAVAILABLE_REASON };
}

export function isGatewayStartupUnavailableDetails(
  details: unknown,
): details is GatewayStartupUnavailableDetails {
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { reason?: unknown }).reason === GATEWAY_STARTUP_UNAVAILABLE_REASON
  );
}

export function isRetryableGatewayStartupUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const shaped = error as {
    code?: unknown;
    gatewayCode?: unknown;
    retryable?: unknown;
    details?: unknown;
  };
  const code = shaped.gatewayCode ?? shaped.code;
  return (
    code === "UNAVAILABLE" &&
    shaped.retryable === true &&
    isGatewayStartupUnavailableDetails(shaped.details)
  );
}

export function resolveGatewayStartupRetryAfterMs(error: unknown): number | null {
  if (!isRetryableGatewayStartupUnavailableError(error)) {
    return null;
  }
  const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
  const raw =
    typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)
      ? retryAfterMs
      : GATEWAY_STARTUP_RETRY_AFTER_MS;
  return Math.min(
    Math.max(Math.floor(raw), GATEWAY_STARTUP_RETRY_MIN_MS),
    GATEWAY_STARTUP_RETRY_MAX_MS,
  );
}
