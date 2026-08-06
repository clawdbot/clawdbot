// Gateway test assertion helpers narrow unknown protocol payloads to records
// and assert selected fields with useful labels.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";

export { isRecord };

/** Requires an unknown value to be a record and throws with a test label. */
export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(isRecord(value), `${label} must be an object`).toBe(true);
  return value as Record<string, unknown>;
}

/** Asserts selected record fields without losing type narrowing at call sites. */
export function expectRecordFields(
  value: unknown,
  label: string,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}
