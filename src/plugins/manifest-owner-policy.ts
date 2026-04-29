import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

type OwnerPlugin = Pick<PluginManifestRecord, "id" | "origin" | "enabledByDefault">;

type NormalizedPluginsConfig = ReturnType<typeof normalizePluginsConfig>;

export type ManifestOwnerBasePolicyBlockReason =
  | "plugins-disabled"
  | "blocked-by-denylist"
  | "plugin-disabled"
  | "not-in-allowlist";

export function isBundledManifestOwner(plugin: Pick<PluginManifestRecord, "origin">): boolean {
  return plugin.origin === "bundled";
}

export function hasExplicitManifestOwnerTrust(params: {
  plugin: Pick<PluginManifestRecord, "id">;
  normalizedConfig: NormalizedPluginsConfig;
}): boolean {
  return (
    params.normalizedConfig.allow.includes(params.plugin.id) ||
    params.normalizedConfig.entries[params.plugin.id]?.enabled === true
  );
}

export function passesManifestOwnerBasePolicy(params: {
  plugin: Pick<PluginManifestRecord, "id">;
  normalizedConfig: NormalizedPluginsConfig;
  allowExplicitlyDisabled?: boolean;
  allowRestrictiveAllowlistBypass?: boolean;
}): boolean {
  return resolveManifestOwnerBasePolicyBlock(params) === null;
}

export function resolveManifestOwnerBasePolicyBlock(params: {
  plugin: Pick<PluginManifestRecord, "id">;
  normalizedConfig: NormalizedPluginsConfig;
  allowExplicitlyDisabled?: boolean;
  allowRestrictiveAllowlistBypass?: boolean;
}): ManifestOwnerBasePolicyBlockReason | null {
  if (!params.normalizedConfig.enabled) {
    return "plugins-disabled";
  }
  if (params.normalizedConfig.deny.includes(params.plugin.id)) {
    return "blocked-by-denylist";
  }
  if (
    params.normalizedConfig.entries[params.plugin.id]?.enabled === false &&
    params.allowExplicitlyDisabled !== true
  ) {
    return "plugin-disabled";
  }
  if (
    params.allowRestrictiveAllowlistBypass !== true &&
    params.normalizedConfig.allow.length > 0 &&
    !params.normalizedConfig.allow.includes(params.plugin.id)
  ) {
    return "not-in-allowlist";
  }
  return null;
}

export function isActivatedManifestOwner(params: {
  plugin: OwnerPlugin;
  normalizedConfig: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
}): boolean {
  return resolveEffectivePluginActivationState({
    id: params.plugin.id,
    origin: params.plugin.origin,
    config: params.normalizedConfig,
    rootConfig: params.rootConfig,
    enabledByDefault: params.plugin.enabledByDefault,
  }).activated;
}
