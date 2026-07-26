/** Compatibility helpers that auto-enable bundled plugins for legacy and Vitest flows. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginEntryConfig } from "../config/types.plugins.js";
import { readBundledDiscoveryMode } from "./bundled-discovery-state.js";
import { hasExplicitPluginConfig } from "./config-policy.js";
import { normalizePluginId } from "./config-state.js";

/** Returns config with selected bundled plugins explicitly enabled when compat rules require it. */
export function withBundledPluginEnablementCompat(params: {
  config: OpenClawConfig | undefined;
  pluginIds: readonly string[];
}): OpenClawConfig | undefined {
  const existingEntries = params.config?.plugins?.entries ?? {};
  const forcePluginsEnabled = params.config?.plugins?.enabled === false;
  const allow = params.config?.plugins?.allow;
  const bypassAllowlist = readBundledDiscoveryMode() === "compat";
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
    if (existingEntries[pluginId] !== undefined) {
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
      entries: {
        ...existingEntries,
        ...nextEntries,
      },
    },
  };
}

/** Enables bundled plugins in Vitest when tests did not provide explicit plugin config. */
export function withBundledPluginVitestCompat(params: {
  config: OpenClawConfig | undefined;
  pluginIds: readonly string[];
  env?: NodeJS.ProcessEnv;
}): OpenClawConfig | undefined {
  const env = params.env ?? process.env;
  const isVitest = Boolean(env.VITEST);
  if (
    !isVitest ||
    hasExplicitPluginConfig(params.config?.plugins) ||
    params.pluginIds.length === 0
  ) {
    return params.config;
  }

  const entries = Object.fromEntries(
    params.pluginIds.map((pluginId) => [pluginId, { enabled: true } satisfies PluginEntryConfig]),
  );

  return {
    ...params.config,
    plugins: {
      ...params.config?.plugins,
      enabled: true,
      allow: [...params.pluginIds],
      entries: {
        ...entries,
        ...params.config?.plugins?.entries,
      },
      slots: {
        ...params.config?.plugins?.slots,
        memory: "none",
      },
    },
  };
}
