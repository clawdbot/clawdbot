import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { isInstalledPluginEnabled } from "./installed-plugin-index.js";
import type { PluginManifestContractListKey, PluginManifestRecord } from "./manifest-registry.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type {
  PluginMetadataManifestView,
  PluginMetadataRegistryView,
  PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.types.js";

export function isManifestPluginAvailableForControlPlane(params: {
  snapshot: Pick<PluginMetadataSnapshot, "index">;
  plugin: Pick<
    PluginManifestRecord,
    "id" | "origin" | "enabledByDefault" | "enabledByDefaultOnPlatforms"
  >;
  config?: OpenClawConfig;
}): boolean {
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
  return [...values].toSorted((left, right) => left.localeCompare(right));
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
  const env = params.env ?? process.env;
  const current = getCurrentPluginMetadataSnapshot({
    config: params.config,
    env,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
  if (current) {
    return current;
  }
  return loadPluginMetadataSnapshot({
    config: params.config ?? {},
    env,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
}
