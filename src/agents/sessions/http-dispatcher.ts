import { parseStrictNonNegativeInteger } from "../../infra/parse-finite-number.js";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") {
      return 0;
    }
    if (trimmed.length === 0) {
      return undefined;
    }
    return parseStrictNonNegativeInteger(trimmed);
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}
