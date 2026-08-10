/** Coerces cron schedule time fields with strict Date-range parsing. */
import {
  MAX_DATE_TIMESTAMP_MS,
  parseStrictFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";

/** Coerces temporal schedule fields without accepting partial, non-finite, or invalid-Date values. */
export function coerceFiniteScheduleNumber(value: unknown): number | undefined {
  const parsed = parseStrictFiniteNumber(value);
  return parsed !== undefined && Math.abs(parsed) <= MAX_DATE_TIMESTAMP_MS ? parsed : undefined;
}
