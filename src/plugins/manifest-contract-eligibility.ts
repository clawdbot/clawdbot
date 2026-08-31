// Determines which manifest contracts are eligible for plugin activation.
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  hasMeaningfulChannelConfigShallow,
  resolveChannelConfigRecord,
} from "../config/channel-configured-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readBundledDiscoveryMode } from "./bundled-discovery-state.js";
import { normalizePluginsConfig } from "./config-state.js";
import { isInstalledPluginEnabled } from "./installed-plugin-index.js";
import { resolveManifestOwnerBasePolicyBlock } from "./manifest-owner-policy.js";
import type { PluginManifestContractListKey, PluginManifestRecord } from "./manifest-registry.js";
import { getPluginCache } from "./plugin-cache.js";
import { resolvePluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type {
  PluginMetadataManifestView,
  PluginMetadataRegistryView,
  PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.types.js";

/** Enforces owner-specific policy while preserving bundled speech/global compatibility. */
export function isManifestPluginOwnerAllowedByControlPlanePolicy(params: {
  plugin: Pick<PluginManifestRecord, "id" | "origin"> & {
    channels?: readonly string[];
  };
  config?: OpenClawConfig;
  allowRestrictiveAllowlistBypass?: boolean;
}): boolean {
  if (!params.config?.plugins) {
    return true;
  }
  const config = params.config;
  const normalized = normalizePluginsConfig(config.plugins);
  // Global disable is owned by each runtime surface; bundled speech remains intentionally usable.
  const normalizedConfig = normalized.enabled ? normalized : { ...normalized, enabled: true };
  const block = resolveManifestOwnerBasePolicyBlock({
    plugin: params.plugin,
    normalizedConfig,
    allowRestrictiveAllowlistBypass:
      params.plugin.origin === "bundled" && params.allowRestrictiveAllowlistBypass === true,
  });
  if (block !== "not-in-allowlist") {
    return block === null;
  }
  if (params.plugin.origin !== "bundled") {
    return false;
  }
  const channelIds = params.plugin.channels ?? [params.plugin.id];
  if (
    channelIds.some((channelId) => {
      const channelConfig = resolveChannelConfigRecord(config, channelId);
      return channelConfig?.enabled !== false && hasMeaningfulChannelConfigShallow(channelConfig);
    })
  ) {
    return true;
  }
  const metadata = getPluginCache().metadata;
  metadata.bundledDiscoveryMode ??= { value: readBundledDiscoveryMode() };
  return metadata.bundledDiscoveryMode.value === "compat";
}

export function isManifestPluginAvailableForControlPlane(params: {
  snapshot: Pick<PluginMetadataSnapshot, "index">;
  plugin: Pick<
    PluginManifestRecord,
    "id" | "origin" | "enabledByDefault" | "enabledByDefaultOnPlatforms"
  > & { channels?: readonly string[] };
  config?: OpenClawConfig;
  allowRestrictiveAllowlistBypass?: boolean;
}): boolean {
  if (!isManifestPluginOwnerAllowedByControlPlanePolicy(params)) {
    return false;
  }
  if (params.plugin.origin === "bundled") {
    return true;
  }
  return isInstalledPluginEnabled(params.snapshot.index, params.plugin.id, params.config);
}

export function hasManifestContractValue(params: {
  plugin: Pick<PluginManifestRecord, "contracts">;
  contract: PluginManifestContractListKey;
  value?: string;
}): boolean {
  const values = params.plugin.contracts?.[params.contract] ?? [];
  return values.length > 0 && (!params.value || values.includes(params.value));
}

export function listAvailableManifestContractPlugins(params: {
  snapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
  contract: PluginManifestContractListKey;
  value?: string;
  config?: OpenClawConfig;
}): PluginManifestRecord[] {
  return params.snapshot.plugins.filter(
    (plugin) =>
      hasManifestContractValue({
        plugin,
        contract: params.contract,
        value: params.value,
      }) &&
      isManifestPluginAvailableForControlPlane({
        snapshot: params.snapshot,
        plugin,
        config: params.config,
      }),
  );
}

export function listAvailableManifestContractValues(params: {
  snapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
  contract: PluginManifestContractListKey;
  config?: OpenClawConfig;
}): string[] {
  const values = new Set<string>();
  for (const plugin of listAvailableManifestContractPlugins(params)) {
    for (const value of plugin.contracts?.[params.contract] ?? []) {
      values.add(value);
    }
  }
  return sortUniqueStrings(values);
}

export function loadManifestContractSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): PluginMetadataManifestView {
  const snapshot = loadManifestMetadataSnapshot(params);
  return {
    index: snapshot.index,
    plugins: snapshot.plugins,
  };
}

export function loadManifestMetadataRegistry(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): PluginMetadataRegistryView {
  const snapshot = loadManifestMetadataSnapshot(params);
  return {
    index: snapshot.index,
    manifestRegistry: snapshot.manifestRegistry,
  };
}

export function loadManifestMetadataSnapshot(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): PluginMetadataSnapshot {
  return resolvePluginMetadataSnapshot({
    config: params.config,
    env: params.env ?? process.env,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    allowWorkspaceScopedCurrent: params.workspaceDir === undefined,
  });
}
