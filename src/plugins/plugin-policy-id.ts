// Derives the case-insensitive key used to match plugin ids against config policy lists.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

/**
 * Canonicalizes a plugin id for comparison against `plugins.allow`, `plugins.deny`, and
 * `plugins.entries`, which are lowercase-normalized when config is normalized. A manifest declares
 * its id in whatever case its author chose, so policy must compare this derived key rather than the
 * declared id. The declared id itself stays untouched: the loader matches it against the plugin's
 * runtime export id, and rewriting it would break plugins whose export matches a mixed-case manifest.
 */
export function normalizePluginPolicyId(id: string): string {
  return normalizeOptionalLowercaseString(id) ?? "";
}
