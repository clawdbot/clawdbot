/**
 * Slug derivation: kebab-case lowercase, deterministic, idempotent.
 * Used by parse + resolve for section/item addressing.
 *
 * @module @openclaw/oc-path/slug
 */

const NON_SLUG_CHARS = /[^a-z0-9-]+/g;
const COLLAPSE_HYPHENS = /-+/g;
const TRIM_HYPHENS = /^-+|-+$/g;

/** Empty string for input with no slug-valid chars; callers treat as not matchable. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(NON_SLUG_CHARS, "-")
    .replace(COLLAPSE_HYPHENS, "-")
    .replace(TRIM_HYPHENS, "");
}
