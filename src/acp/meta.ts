export function readString(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): string | undefined {
  if (!meta) return undefined;
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function readBool(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): boolean | undefined {
  if (!meta) return undefined;
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

export function readNumber(
  meta: Record<string, unknown> | null | undefined,
  keys: string[],
): number | undefined {
  if (!meta) return undefined;
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}
