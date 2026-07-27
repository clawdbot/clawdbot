export const GOOGLE_MEET_MAX_PROBE_TIMEOUT_MS = 120_000;

export function resolveGoogleMeetProbeTimeoutMs(
  input: number | undefined,
  fallback: number,
): number {
  if (input === undefined) {
    return Math.min(Math.max(fallback, 1), GOOGLE_MEET_MAX_PROBE_TIMEOUT_MS);
  }
  if (!Number.isFinite(input) || input <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  return Math.min(Math.trunc(input), GOOGLE_MEET_MAX_PROBE_TIMEOUT_MS);
}
