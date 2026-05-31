import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

function readMetaValue<T>(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
  normalize: (value: unknown) => T | undefined,
): T | undefined {
  if (!meta) {
    return undefined;
  }
  for (const key of keys) {
    const normalized = normalize(meta[key]);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return undefined;
}

export function readString(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): string | undefined {
  return readMetaValue(meta, keys, normalizeOptionalString);
}

export function readBool(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): boolean | undefined {
  return readMetaValue(meta, keys, (value) => (typeof value === "boolean" ? value : undefined));
}

export function readNumber(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): number | undefined {
  return readMetaValue(meta, keys, (value) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined,
  );
}

export function readNonNegativeInteger(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): number | undefined {
  return readMetaValue(meta, keys, (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined,
  );
}
