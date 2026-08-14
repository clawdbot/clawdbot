import { GatewayRequestError } from "../../api/gateway.ts";

const DEFAULT_RETRY_MS = 500;
const MAX_RETRY_MS = 5_000;

export function isRetryableStartupUnavailable(err: unknown, method: string): boolean {
  const code =
    err instanceof GatewayRequestError
      ? err.gatewayCode
      : err && typeof err === "object" && "code" in err
        ? String(err.code)
        : "";
  if (
    code !== "UNAVAILABLE" ||
    !err ||
    typeof err !== "object" ||
    !("retryable" in err) ||
    err.retryable !== true
  ) {
    return false;
  }
  if ("command" in err && typeof err.command === "string") {
    return err.command === method;
  }
  const details = err instanceof GatewayRequestError ? err.details : undefined;
  if (!details || typeof details !== "object") {
    return true;
  }
  const detailMethod = (details as { method?: unknown }).method;
  return typeof detailMethod !== "string" || detailMethod === method;
}

export function isUnknownGatewayMethodError(err: unknown, method: string): boolean {
  const code =
    err instanceof GatewayRequestError
      ? err.gatewayCode
      : err && typeof err === "object" && "code" in err
        ? String(err.code)
        : "";
  return (
    code === "INVALID_REQUEST" &&
    err instanceof Error &&
    (!("command" in err) || err.command === method) &&
    err.message.includes(`unknown method: ${method}`)
  );
}

export function resolveStartupRetryDelayMs(err: unknown): number {
  const retryAfterMs =
    err && typeof err === "object" && "retryAfterMs" in err && typeof err.retryAfterMs === "number"
      ? err.retryAfterMs
      : DEFAULT_RETRY_MS;
  return Math.min(Math.max(retryAfterMs, 100), MAX_RETRY_MS);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
