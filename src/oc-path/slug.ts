/**
 * Slug derivation for OcPath section/item addressing.
 *
 * A slug is the kebab-case lowercase form of a heading or item text:
 *   "Tool Guidance"          → "tool-guidance"
 *   "  Restricted Data  "    → "restricted-data"
 *   "deny-rule-1"            → "deny-rule-1"   (already a slug)
 *   "API_KEY"                → "api-key"
 *   "Multi-tenant isolation" → "multi-tenant-isolation"
 *   "deny: secrets"          → "deny-secrets"  (colon + space → hyphen)
 *
 * Deterministic + idempotent. Used by parse to pre-compute slugs for
 * blocks and items, and by resolveOcPath to match section/item names.
 *
 * @module @openclaw/oc-path/slug
 */

const NON_SLUG_CHARS = /[^a-z0-9-]+/g;
const COLLAPSE_HYPHENS = /-+/g;
const TRIM_HYPHENS = /^-+|-+$/g;

/**
 * Convert arbitrary text into a slug usable as an OcPath segment.
 *
 * Rules:
 *   1. Lowercase
 *   2. Replace `_` with `-`
 *   3. Replace any non-`[a-z0-9-]` runs with a single `-`
 *   4. Collapse repeated `-`
 *   5. Trim leading/trailing `-`
 *
 * Returns the empty string for input that has no slug-valid characters
 * (e.g., `"!!"` → `""`); callers should treat empty slugs as not
 * matchable rather than as wildcards.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(NON_SLUG_CHARS, '-')
    .replace(COLLAPSE_HYPHENS, '-')
    .replace(TRIM_HYPHENS, '');
}
