/** Coerces cron schedule number fields with strict safe-range parsing. */
import { parseStrictFiniteNumber } from "@openclaw/normalization-core/number-coercion";

/** Coerces schedule numeric fields without accepting partial, non-finite, or unsafe values. */
export function coerceFiniteScheduleNumber(value: unknown): number | undefined {
  const parsed = parseStrictFiniteNumber(value);
  return parsed !== undefined && Math.abs(parsed) <= Number.MAX_SAFE_INTEGER ? parsed : undefined;
}
