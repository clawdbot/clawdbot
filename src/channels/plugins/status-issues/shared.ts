export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function formatMatchMetadata(params: {
  matchKey?: unknown;
  matchSource?: unknown;
}): string | undefined {
  const matchKey =
    typeof params.matchKey === "string"
      ? params.matchKey
      : typeof params.matchKey === "number"
        ? String(params.matchKey)
        : undefined;
  const matchSource = asString(params.matchSource);
  const parts = [
    matchKey ? `matchKey=${matchKey}` : null,
    matchSource ? `matchSource=${matchSource}` : null,
  ].filter((entry): entry is string => Boolean(entry));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function appendMatchMetadata(
  message: string,
  params: { matchKey?: unknown; matchSource?: unknown },
): string {
  const meta = formatMatchMetadata(params);
  return meta ? `${message} (${meta})` : message;
}
