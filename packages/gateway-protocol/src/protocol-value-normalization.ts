export {
  asNullableRecord as asProtocolRecord,
  isRecord as isProtocolRecord,
} from "@openclaw/normalization-core/record-coerce";

/** Checks string presence without changing wire-significant whitespace. */
export function isNonEmptyProtocolString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Trims an optional untrusted string and rejects empty results. */
export function normalizeOptionalProtocolString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
