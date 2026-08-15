import prettyMilliseconds from "pretty-ms";

function normalizeSingleUnitDurationMs(ms: number): number {
  const roundedMs = Math.round(ms);
  if (roundedMs < 1000) {
    return roundedMs;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return seconds * 1000;
  }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return minutes * 60_000;
  }
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) {
    return hours * 3_600_000;
  }
  return Math.round(ms / 86_400_000) * 86_400_000;
}

/** Keep single-unit rounding identical for compact and verbose core displays. */
export function formatSingleUnitDuration(ms: number, verbose = false): string {
  return prettyMilliseconds(normalizeSingleUnitDurationMs(ms), {
    hideYear: true,
    unitCount: 1,
    verbose,
  });
}
