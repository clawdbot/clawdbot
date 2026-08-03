/**
 * HTTP session dispatcher config helpers.
 *
 * Parses idle-timeout values shared by server and config surfaces.
 */
import { parseStrictNonNegativeInteger } from "../../infra/parse-finite-number.js";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

/** Parses idle timeout values, using `0` for the explicit disabled sentinel. */
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
