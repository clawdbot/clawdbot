import { asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Reads QQBot config objects, including array-backed legacy values. */
export function readQqbotObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? asRecord(value) : undefined;
}
