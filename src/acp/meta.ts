import { normalizeOptionalString } from "../shared/string-coerce.js";

export function readString(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): string | undefined {
  if (!meta) {
    return undefined;
  }
  for (const key of keys) {
    const value = normalizeOptionalString(meta[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function readBool(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): boolean | undefined {
  if (!meta) {
    return undefined;
  }
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

export function readNumber(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): number | undefined {
  if (!meta) {
    return undefined;
  }
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export function readNonNegativeInteger(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): number | undefined {
  if (!meta) {
    return undefined;
  }
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}
