/** Compatibility helper that auto-enables bundled plugins for legacy flows. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginEntryConfig } from "../config/types.plugins.js";
import { readBundledDiscoveryModeMemoized } from "./bundled-discovery-state.js";
import { normalizePluginId } from "./config-state.js";

/** Returns config with selected bundled plugins explicitly enabled when compat rules require it. */
export function withBundledPluginEnablementCompat(params: {
  config: OpenClawConfig | undefined;
  pluginIds: readonly string[];
  env?: NodeJS.ProcessEnv;
  activation?: "defaults" | "selected";
}): OpenClawConfig | undefined {
  if (params.pluginIds.length === 0) {
    return params.config;
  }
  const existingEntries = params.config?.plugins?.entries ?? {};
  const selectPlugins = params.activation !== "defaults";
  const forcePluginsEnabled = selectPlugins && params.config?.plugins?.enabled === false;
  const allow = params.config?.plugins?.allow;
  const bypassAllowlist = readBundledDiscoveryModeMemoized(params.env) === "compat";
  const allowSet =
    !bypassAllowlist && Array.isArray(allow) && allow.length > 0
      ? new Set(allow.map((pluginId) => normalizePluginId(pluginId)).filter(Boolean))
      : undefined;
  let hasEligiblePlugin = false;
  let changed = false;
  const nextEntries: Record<string, PluginEntryConfig> = { ...existingEntries };
  const nextAllow = bypassAllowlist && Array.isArray(allow) ? new Set(allow) : undefined;

  for (const pluginId of params.pluginIds) {
    if (allowSet && !allowSet.has(pluginId)) {
      continue;
    }
    hasEligiblePlugin = true;
    const beforeAllowSize = nextAllow?.size;
    nextAllow?.add(pluginId);
    if (nextAllow && nextAllow.size !== beforeAllowSize) {
      changed = true;
    }
    if (!selectPlugins || existingEntries[pluginId] !== undefined) {
      continue;
    }
    nextEntries[pluginId] = { enabled: true };
    changed = true;
  }

  if (!changed) {
    if (!forcePluginsEnabled || !hasEligiblePlugin) {
      return params.config;
    }
  }

  return {
    ...params.config,
    plugins: {
      ...params.config?.plugins,
      ...(forcePluginsEnabled ? { enabled: true } : {}),
      ...(nextAllow ? { allow: [...nextAllow] } : {}),
      ...(selectPlugins ? { entries: nextEntries } : {}),
    },
  };
}
