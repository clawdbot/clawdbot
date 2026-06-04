import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

// Hostname normalization is intentionally display/compare-oriented: lowercase,
// trim brackets for IPv6 literals, and remove trailing DNS dots.
/** Normalize a hostname for policy comparisons. */
export function normalizeHostname(hostname: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(hostname).replace(/\.+$/, "");
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}
