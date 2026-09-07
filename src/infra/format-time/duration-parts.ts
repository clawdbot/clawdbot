// Browser-safe duration quantities; formatting remains with each presentation owner.
export const durationUnitMs = {
  year: 31_536_000_000,
  week: 604_800_000,
  day: 86_400_000,
  hour: 3_600_000,
  minute: 60_000,
  second: 1_000,
  millisecond: 1,
} as const;

export type DurationPart = { value: number | bigint; unit: keyof typeof durationUnitMs };

function resolveDurationParts(ms: number, unitCount: number, showYears = false): DurationPart[] {
  const days = BigInt(Math.trunc(ms / durationUnitMs.day));
  const parts: DurationPart[] = [
    { value: showYears ? days / 365n : 0n, unit: "year" },
    { value: showYears ? days % 365n : days, unit: "day" },
    { value: Math.trunc((ms / durationUnitMs.hour) % 24), unit: "hour" },
    { value: Math.trunc((ms / durationUnitMs.minute) % 60), unit: "minute" },
    { value: Math.trunc((ms / durationUnitMs.second) % 60), unit: "second" },
    // Large floats can retain a remainder after second-rounding; only subsecond input uses ms.
    { value: ms < 1_000 ? Math.trunc(ms) : 0, unit: "millisecond" },
  ];
  // pretty-ms counts nonzero units, so an empty middle bucket must not hide the next one.
  const selected = parts.filter(({ value }) => value !== 0 && value !== 0n).slice(0, unitCount);
  return selected.length ? selected : [{ value: 0, unit: "millisecond" }];
}

export function resolveCompactDurationParts(ms?: number | null, showYears = false) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) {
    return undefined;
  }
  const roundedMs = Math.round(ms);
  return resolveDurationParts(
    roundedMs < 1_000 ? roundedMs : Math.round(ms / 1_000) * 1_000,
    2,
    showYears,
  );
}

export function resolveSingleUnitDurationParts(ms: number): DurationPart[] {
  let scale: number = durationUnitMs.millisecond;
  for (const unit of ["second", "minute", "hour", "day"] as const) {
    const nextScale = durationUnitMs[unit];
    if (Math.round(ms / scale) * scale < nextScale) {
      break;
    }
    scale = nextScale;
  }
  return resolveDurationParts(Math.round(ms / scale) * scale, 1);
}
