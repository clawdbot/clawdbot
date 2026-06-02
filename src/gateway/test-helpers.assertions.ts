import { expect } from "vitest";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(isRecord(value), `${label} must be an object`).toBe(true);
  return value as Record<string, unknown>;
}

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
