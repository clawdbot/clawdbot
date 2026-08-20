import { asOptionalRecord } from "./record-coerce.js";

/** Parses JSON without throwing, returning undefined for invalid input. */
export function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** Parses JSON into a non-array record, returning undefined for every other result. */
export function safeParseJsonRecord(value: string): Record<string, unknown> | undefined {
  return asOptionalRecord(safeParseJson(value));
}
