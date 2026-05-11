import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserFormField } from "./client-actions.types.js";

export const DEFAULT_FILL_FIELD_TYPE = "text";

type BrowserFormFieldValue = NonNullable<BrowserFormField["value"]>;

function normalizeBrowserFormFieldRef(value: unknown): string {
  return normalizeOptionalString(value) ?? "";
}

function normalizeBrowserFormFieldType(value: unknown): string {
  const type = normalizeOptionalString(value) ?? "";
  return type || DEFAULT_FILL_FIELD_TYPE;
}

export function normalizeBrowserFormFieldValue(value: unknown): BrowserFormFieldValue | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

export function normalizeBrowserFormField(
  record: Record<string, unknown>,
): BrowserFormField | null {
  const ref = normalizeBrowserFormFieldRef(record.ref);
  if (!ref) {
    return null;
  }
  const type = normalizeBrowserFormFieldType(record.type);
  const value = normalizeBrowserFormFieldValue(record.value);
  return value === undefined ? { ref, type } : { ref, type, value };
}
