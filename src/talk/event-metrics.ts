export { asOptionalRecord as talkEventPayloadRecord } from "../shared/record-coerce.js";

export function firstFiniteTalkEventNumber(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}
