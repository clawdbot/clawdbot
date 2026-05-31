import { parseStrictFiniteNumber } from "@openclaw/normalization-core/number-coercion";

export function coerceFiniteScheduleNumber(value: unknown): number | undefined {
  return parseStrictFiniteNumber(value);
}
