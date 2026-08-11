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

/**
 * True when a channel `preferOver` declaration names a plugin. Manifest ids and `preferOver`
 * entries are authored independently, so both sides compare through the derived policy key above.
 * Schema ownership and auto-enable's replacement selection must read this one predicate: comparing
 * declared ids in either place lets config validation apply a replacement's channel schema while
 * the runtime keeps serving the incumbent, accepting keys the running channel does not own.
 */
export function declaresPluginPreferenceOver(
  preferOver: readonly string[] | undefined,
  pluginId: string | undefined,
): boolean {
  const target = normalizeOptionalLowercaseString(pluginId);
  if (!target) {
    return false;
  }
  return (preferOver ?? []).some((entry) => normalizePluginPolicyId(entry) === target);
}
