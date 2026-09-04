import { durationUnitMs, type DurationPart } from "./format-duration-internal.js";

// Exact display stays outside startup formatting; health uses weeks, cron uses days.
export function resolveExactDurationParts(ms?: number | null, showWeeks = false) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return undefined;
  }
  let remaining = BigInt(Math.round(ms));
  const parts: DurationPart[] = [];
  for (const unit of ["week", "day", "hour", "minute", "second", "millisecond"] as const) {
    const value = remaining / BigInt(durationUnitMs[unit]);
    if (value > 0n && (unit !== "week" || showWeeks)) {
      parts.push({ value, unit });
      remaining %= BigInt(durationUnitMs[unit]);
    }
  }
  return parts.length ? parts : [{ value: 0, unit: "millisecond" } satisfies DurationPart];
}

export function formatExactDuration(ms: number, fallback = "n/a", showWeeks = false): string {
  return (
    resolveExactDurationParts(ms, showWeeks)
      ?.map(({ value, unit }) => `${value}${unit === "millisecond" ? "ms" : unit[0]}`)
      .join(" ") ?? fallback
  );
}
