import { parseStrictFiniteNumber } from "@openclaw/normalization-core/number-coercion";

/** Coerces schedule numeric fields without accepting partial or non-finite numbers. */
export function coerceFiniteScheduleNumber(value: unknown): number | undefined {
  return parseStrictFiniteNumber(value);
}
