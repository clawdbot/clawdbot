import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import type { PluginRecord } from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";

type EnabledPluginRecord = Pick<
  PluginRecord,
  "id" | "origin" | "packageName" | "trustedOfficialInstall" | "channelIds"
>;

/** Lists loaded plugin identities, or configured manifest identities before runtime activation. */
export function listEnabledPluginRecords(config: OpenClawConfig): EnabledPluginRecord[] {
  const registry = getActivePluginRegistry();
  if (registry) {
    return registry.plugins.filter(
      (plugin) =>
        plugin.enabled &&
        plugin.status === "loaded" &&
        (plugin.format === "bundle" || plugin.imported !== false),
    );
  }

  const normalizedConfig = normalizePluginsConfig(config.plugins);
  return loadPluginManifestRegistryCore({ config })
    .plugins.filter(
      (plugin) =>
        resolveEffectivePluginActivationState({
          id: plugin.id,
          origin: plugin.origin,
          channelIds: plugin.channels,
          config: normalizedConfig,
          rootConfig: config,
          enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin),
        }).enabled,
    )
    .map((plugin) => ({
      id: plugin.id,
      origin: plugin.origin,
      packageName: plugin.packageName,
      trustedOfficialInstall: plugin.trustedOfficialInstall,
      channelIds: plugin.channels,
    }));
}
