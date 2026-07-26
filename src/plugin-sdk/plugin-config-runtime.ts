// Plugin config runtime helpers load and normalize plugin-owned configuration at execution time.
import type { OpenClawConfig } from "../config/types.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../plugins/config-state.js";

export { normalizePluginsConfig, resolveEffectiveEnableState };
export { mergeDeep } from "../infra/deep-merge.js";

/** Requires an already-resolved runtime config at plugin runtime boundaries. */
export function requireRuntimeConfig(config: OpenClawConfig, context: string): OpenClawConfig {
  if (config) {
    return config;
  }
  throw new Error(
    `${context} requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.`,
  );
}

/** Reads a plugin's object-shaped `plugins.entries[id].config` block from resolved config. */
export function resolvePluginConfigObject(
  config: OpenClawConfig | undefined,
  pluginId: string,
): Record<string, unknown> | undefined {
  const pluginConfig = normalizePluginsConfig(config?.plugins).entries[pluginId]?.config;
  return pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig)
    ? (pluginConfig as Record<string, unknown>)
    : undefined;
}

/** Resolves live plugin config through a loader, falling back to startup config when unavailable. */
export function resolveLivePluginConfigObject(
  runtimeConfigLoader: (() => OpenClawConfig | undefined) | undefined,
  pluginId: string,
  startupPluginConfig?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof runtimeConfigLoader !== "function") {
    return startupPluginConfig;
  }
  return resolvePluginConfigObject(runtimeConfigLoader(), pluginId);
}
