import {
  asNullableRecord,
  hasNonEmptyString as sharedHasNonEmptyString,
  isRecord,
} from "openclaw/plugin-sdk/text-runtime";

export { asNullableRecord as asRecord, isRecord };

export const hasNonEmptyString = sharedHasNonEmptyString;

export function normalizeString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}
