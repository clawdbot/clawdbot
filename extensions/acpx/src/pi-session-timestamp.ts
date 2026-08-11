import { asFiniteNumber } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Preserve Pi JSONL's date-first string contract while accepting numeric millisecond values. */
export function parsePiSessionTimestampMs(value: unknown): number | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return asFiniteNumber(value);
}
