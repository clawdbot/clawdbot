import { zoomMeetingsInvalidRequest as invalidRequest } from "./errors.js";

export function resolveZoomMeetingsProbeTimeoutMs(
  input: number | undefined,
  fallback: number,
): number {
  if (input === undefined) {
    return Math.min(Math.max(fallback, 1), 120_000);
  }
  if (!Number.isFinite(input) || input <= 0) {
    throw invalidRequest("timeoutMs must be a positive number");
  }
  return Math.min(Math.trunc(input), 120_000);
}
