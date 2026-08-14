import { parseDateFirstTimestampMs } from "openclaw/plugin-sdk/number-runtime";

/** Preserve Pi JSONL's date-first string contract while accepting numeric millisecond values. */
export function parsePiSessionTimestampMs(value: unknown): number | undefined {
  return parseDateFirstTimestampMs(value);
}
