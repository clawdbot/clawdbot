import prettyMilliseconds from "pretty-ms";
import {
  durationUnitMs,
  resolveSingleUnitDurationParts,
  type DurationPart,
} from "./duration-parts.js";

export function formatDurationParts(parts: DurationPart[], verbose = false): string {
  return parts
    .map(({ value, unit }) =>
      prettyMilliseconds(BigInt(value) * BigInt(durationUnitMs[unit]), {
        hideYear: unit !== "year",
        unitCount: 1,
        verbose,
      }),
    )
    .join(" ");
}

/** Keep single-unit rounding identical for compact and verbose core displays. */
export function formatSingleUnitDuration(ms: number, verbose = false): string {
  return formatDurationParts(resolveSingleUnitDurationParts(ms), verbose);
}
