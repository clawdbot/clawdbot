/** Shared fail-closed parser for the system-profile cookie import domain filter. */

/**
 * Normalize the optional `domains` filter for system-profile cookie import.
 *
 * Import copies real browser session cookies, so a caller that meant to scope
 * the import must never be silently widened to "import everything". A present
 * but malformed or empty filter throws; an absent filter (undefined/null)
 * returns undefined, meaning no domain restriction.
 */
export function parseSystemProfileDomains(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error("domains must be an array of domain strings");
  }
  const cleaned = raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (cleaned.length === 0) {
    throw new Error("domains must include at least one non-empty domain");
  }
  return cleaned;
}
