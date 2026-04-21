/**
 * AllowFrom normalization — zero external dependency version.
 *
 * Extracted from channel-config-shared.ts. The original used
 * `normalizeStringifiedOptionalString` from plugin-sdk, which is
 * just `String(x).trim()` for non-null primitives.
 */

/** Normalize a config entry to a trimmed string (empty string for null/undefined). */
function normalizeEntry(entry: unknown): string {
  if (entry === null || entry === undefined) {
    return "";
  }
  if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
    return String(entry).trim();
  }
  return "";
}

/** Normalize allowFrom entries: strip `qqbot:` prefix, uppercase. */
export function formatAllowFrom(params: { allowFrom: unknown[] | undefined | null }): string[] {
  return (params.allowFrom ?? [])
    .map((entry) => normalizeEntry(entry))
    .filter((entry): entry is string => entry.length > 0)
    .map((entry) => entry.replace(/^qqbot:/i, ""))
    .map((entry) => entry.toUpperCase());
}
