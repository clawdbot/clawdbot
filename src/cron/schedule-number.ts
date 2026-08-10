/** Coerces cron schedule time fields with strict Date-range parsing. */
import {
  asDateTimestampMs,
  parseStrictFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";

/** Coerces temporal schedule fields without accepting partial, non-finite, or invalid-Date values. */
export function coerceFiniteScheduleNumber(value: unknown): number | undefined {
  const parsed = parseStrictFiniteNumber(value);
  return asDateTimestampMs(parsed);
}
