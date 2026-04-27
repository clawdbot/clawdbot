import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import { resolveRuntimePluginRegistry } from "./loader.js";
import { resolveManifestContractRuntimePluginResolution } from "./manifest-contract-runtime.js";
import type { MigrationProviderPlugin } from "./types.js";

function resolveMigrationProviderConfig(params: {
  cfg?: OpenClawConfig;
  bundledCompatPluginIds: string[];
}): OpenClawConfig | undefined {
  const allowlistCompat = withBundledPluginAllowlistCompat({
    config: params.cfg,
    pluginIds: params.bundledCompatPluginIds,
  });
  const enablementCompat = withBundledPluginEnablementCompat({
    config: allowlistCompat,
    pluginIds: params.bundledCompatPluginIds,
  });
  return withBundledPluginVitestCompat({
    config: enablementCompat,
    pluginIds: params.bundledCompatPluginIds,
    env: process.env,
  });
}

function findMigrationProviderById(
  entries: ReadonlyArray<{ provider: MigrationProviderPlugin }>,
  providerId: string,
): MigrationProviderPlugin | undefined {
  return entries.find((entry) => entry.provider.id === providerId)?.provider;
}

function resolveMigrationProviderRegistry(params: {
  cfg?: OpenClawConfig;
  pluginIds: string[];
  bundledCompatPluginIds: string[];
}) {
  const compatConfig = resolveMigrationProviderConfig({
    cfg: params.cfg,
    bundledCompatPluginIds: params.bundledCompatPluginIds,
  });
  return resolveRuntimePluginRegistry({
    ...(compatConfig === undefined ? {} : { config: compatConfig }),
    onlyPluginIds: params.pluginIds,
    activate: false,
  });
}

function mergeMigrationProviders(
  left: ReadonlyArray<{ provider: MigrationProviderPlugin }>,
  right: ReadonlyArray<{ provider: MigrationProviderPlugin }>,
): MigrationProviderPlugin[] {
  const merged = new Map<string, MigrationProviderPlugin>();
  for (const entry of [...left, ...right]) {
    if (!merged.has(entry.provider.id)) {
      merged.set(entry.provider.id, entry.provider);
    }
  }
  return [...merged.values()].toSorted((a, b) => a.id.localeCompare(b.id));
}

export function resolvePluginMigrationProvider(params: {
  providerId: string;
  cfg?: OpenClawConfig;
}): MigrationProviderPlugin | undefined {
  const activeRegistry = resolveRuntimePluginRegistry();
  const activeProvider = findMigrationProviderById(
    activeRegistry?.migrationProviders ?? [],
    params.providerId,
  );
  if (activeProvider) {
    return activeProvider;
  }

  const resolution = resolveManifestContractRuntimePluginResolution({
    cfg: params.cfg,
    contract: "migrationProviders",
    value: params.providerId,
  });
  const pluginIds = resolution.pluginIds;
  if (pluginIds.length === 0) {
    return undefined;
  }
  const registry = resolveMigrationProviderRegistry({
    cfg: params.cfg,
    pluginIds,
    bundledCompatPluginIds: resolution.bundledCompatPluginIds,
  });
  return findMigrationProviderById(registry?.migrationProviders ?? [], params.providerId);
}

export function resolvePluginMigrationProviders(
  params: {
    cfg?: OpenClawConfig;
  } = {},
): MigrationProviderPlugin[] {
  const activeRegistry = resolveRuntimePluginRegistry();
  const activeProviders = activeRegistry?.migrationProviders ?? [];
  const resolution = resolveManifestContractRuntimePluginResolution({
    cfg: params.cfg,
    contract: "migrationProviders",
  });
  const pluginIds = resolution.pluginIds;
  if (pluginIds.length === 0) {
    return mergeMigrationProviders(activeProviders, []);
  }
  const registry = resolveMigrationProviderRegistry({
    cfg: params.cfg,
    pluginIds,
    bundledCompatPluginIds: resolution.bundledCompatPluginIds,
  });
  return mergeMigrationProviders(activeProviders, registry?.migrationProviders ?? []);
}
