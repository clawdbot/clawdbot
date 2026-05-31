import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

/**
 * Normalize optional gateway URL-input hostname allowlists.
 *
 * Semantics are intentionally:
 * - missing / empty / whitespace-only list => no hostname allowlist restriction
 * - deny-all URL fetching => use the corresponding `allowUrl: false` switch
 */
export function normalizeInputHostnameAllowlist(
  values: string[] | undefined,
): string[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  const normalized = normalizeTrimmedStringList(values);
  return normalized.length > 0 ? normalized : undefined;
}
