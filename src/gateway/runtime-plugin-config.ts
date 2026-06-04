import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";

// Gateway plugin config applies auto-enable rules against the current manifest
// snapshot. The WeakMap cache is keyed by config object plus snapshot identity,
// which are process-stable until an explicit reload/install flow replaces them.
type CachedGatewayPluginConfig = {
  snapshot: PluginMetadataSnapshot;
  config: OpenClawConfig;
};

const gatewayPluginConfigCache = new WeakMap<OpenClawConfig, CachedGatewayPluginConfig>();

/** Resolves runtime config with plugin auto-enable applied for gateway startup/reload paths. */
export function resolveGatewayPluginConfig(params: { config: OpenClawConfig }): OpenClawConfig {
  const currentSnapshot = getCurrentPluginMetadataSnapshot({
    config: params.config,
    allowWorkspaceScopedSnapshot: true,
  });
  if (!currentSnapshot) {
    return applyPluginAutoEnable({
      config: params.config,
    }).config;
  }

  const cached = gatewayPluginConfigCache.get(params.config);
  if (cached?.snapshot === currentSnapshot) {
    return cached.config;
  }

  const config = applyPluginAutoEnable({
    config: params.config,
    manifestRegistry: currentSnapshot.manifestRegistry,
    discovery: currentSnapshot.discovery,
  }).config;
  gatewayPluginConfigCache.set(params.config, { snapshot: currentSnapshot, config });
  return config;
}
