import { GatewayRequestError } from "../../api/gateway.ts";

const SESSION_RETRY_DEFAULT_MS = 500;
const SESSION_RETRY_MIN_MS = 100;
const SESSION_RETRY_MAX_MS = 30_000;

export function sessionRetryDelayMs(error: unknown): number | null {
  if (!(error instanceof GatewayRequestError) || !error.retryable) {
    return null;
  }
  const requested =
    typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)
      ? error.retryAfterMs
      : SESSION_RETRY_DEFAULT_MS;
  return Math.min(Math.max(requested, SESSION_RETRY_MIN_MS), SESSION_RETRY_MAX_MS);
}
