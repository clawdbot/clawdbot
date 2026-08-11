// Normalizes plugin allowlist config used by loading and validation.
import { normalizePluginPolicyId } from "../plugins/plugin-policy-id.js";

type PluginAllowlistConfigCarrier = {
  plugins?: {
    allow?: string[];
  };
};

/** Return a config copy with `pluginId` appended to an existing restrictive plugin allowlist. */
export function ensurePluginAllowlisted<T extends PluginAllowlistConfigCarrier>(
  cfg: T,
  pluginId: string,
): T {
  const allow = cfg.plugins?.allow;
  const policyId = normalizePluginPolicyId(pluginId);
  // Allow entries are keyed by the derived policy id once config is normalized, so membership
  // compares that key and a genuinely missing entry is written in the same canonical form — an
  // exact compare appends a case-variant duplicate beside the operator's normalized entry.
  if (
    !Array.isArray(allow) ||
    allow.some((allowed) => normalizePluginPolicyId(allowed) === policyId)
  ) {
    // Missing allowlist means unrestricted plugin loading; avoid creating a new restrictive list.
    return cfg;
  }
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: [...allow, policyId],
    },
  } as T;
}
