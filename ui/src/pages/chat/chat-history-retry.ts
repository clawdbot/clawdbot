import { GatewayRequestError } from "../../api/gateway.ts";

const DEFAULT_RETRY_MS = 500;
const MAX_RETRY_MS = 5_000;

export function isRetryableStartupUnavailable(
  err: unknown,
  method: string,
): err is GatewayRequestError {
  if (!(err instanceof GatewayRequestError)) {
    return false;
  }
  if (err.gatewayCode !== "UNAVAILABLE" || !err.retryable) {
    return false;
  }
  const details = err.details;
  if (!details || typeof details !== "object") {
    return true;
  }
  const detailMethod = (details as { method?: unknown }).method;
  return typeof detailMethod !== "string" || detailMethod === method;
}

export function isUnknownGatewayMethodError(
  err: unknown,
  method: string,
): err is GatewayRequestError {
  return (
    err instanceof GatewayRequestError &&
    err.gatewayCode === "INVALID_REQUEST" &&
    err.message.includes(`unknown method: ${method}`)
  );
}

export function resolveStartupRetryDelayMs(err: GatewayRequestError): number {
  const retryAfterMs = typeof err.retryAfterMs === "number" ? err.retryAfterMs : DEFAULT_RETRY_MS;
  return Math.min(Math.max(retryAfterMs, 100), MAX_RETRY_MS);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
