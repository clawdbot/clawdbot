/**
 * Browser form field normalization.
 *
 * Converts model/client fill field payloads into the compact field shape used
 * by Playwright and Chrome MCP fill actions.
 */
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserFormField } from "./client-actions.types.js";

/** Default field type for fill actions when no type is provided. */
export const DEFAULT_FILL_FIELD_TYPE = "text";

/** Keys accepted in one fill field entry. */
const FIELD_ENTRY_KEYS = new Set(["ref", "type", "value"]);

type BrowserFormFieldValue = NonNullable<BrowserFormField["value"]>;

function normalizeBrowserFormFieldRef(value: unknown): string {
  return normalizeOptionalString(value) ?? "";
}

function normalizeBrowserFormFieldType(value: unknown): string {
  const type = normalizeOptionalString(value) ?? "";
  return type || DEFAULT_FILL_FIELD_TYPE;
}

/** Normalize a form field value to the types accepted by fill actions. */
export function normalizeBrowserFormFieldValue(value: unknown): BrowserFormFieldValue | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

export function normalizeBrowserFormField(
  record: Record<string, unknown>,
  index: number,
): BrowserFormField {
  const prefix = `fields[${index}]`;
  const ref = normalizeBrowserFormFieldRef(record.ref);
  if (!ref) {
    throw new Error(`${prefix} must include ref`);
  }
  for (const key of Object.keys(record)) {
    if (!FIELD_ENTRY_KEYS.has(key)) {
      throw new Error(
        `${prefix} unsupported field key "${key}"; supported keys are ref, type, value`,
      );
    }
  }
  const type = normalizeBrowserFormFieldType(record.type);
  if (record.value === undefined || record.value === null) {
    return { ref, type };
  }
  const value = normalizeBrowserFormFieldValue(record.value);
  if (value === undefined) {
    throw new Error(`${prefix} value must be a string, number, boolean, or null`);
  }
  return { ref, type, value };
}

/** Normalize form field descriptors and preserve the failing entry index. */
export function normalizeBrowserFormFields(entries: unknown[]): BrowserFormField[] {
  return entries.map((field, index) => {
    if (!isRecord(field)) {
      throw new Error(`fields[${index}] must be an object`);
    }
    return normalizeBrowserFormField(field, index);
  });
}
