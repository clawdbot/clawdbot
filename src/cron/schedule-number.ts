import { parseStrictFiniteNumber } from "../shared/number-coercion.js";

export function coerceFiniteScheduleNumber(value: unknown): number | undefined {
  return parseStrictFiniteNumber(value);
}
