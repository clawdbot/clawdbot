// Normalizes plugin allowlist config used by loading and validation.
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
  if (!Array.isArray(allow) || allow.includes(pluginId)) {
    // Missing allowlist means unrestricted plugin loading; avoid creating a new restrictive list.
    return cfg;
  }
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: [...allow, pluginId],
    },
  } as T;
}
