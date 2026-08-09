// Runtime bridge for plugin-provided migration hooks.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import { listBundledPluginMetadata } from "./bundled-plugin-metadata.js";
import { loadPluginRegistryHandle } from "./loader.js";
import { resolveManifestContractRuntimePluginResolution } from "./manifest-contract-runtime.js";
import type { PluginRegistry } from "./registry-types.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import type { MigrationProviderPlugin } from "./types.js";

type MigrationProviderPluginResolution = {
  pluginIds: string[];
  bundledCompatPluginIds: string[];
};

let standaloneMigrationRegistrySlot:
  | {
      config: OpenClawConfig | undefined;
      pluginIdsKey: string;
      registry: PluginRegistry;
    }
  | undefined;

function migrationPluginIdsKey(pluginIds: readonly string[]): string {
  return JSON.stringify(pluginIds);
}

function findMigrationProviderById(
  entries: ReadonlyArray<{ provider: MigrationProviderPlugin }>,
  providerId: string,
): MigrationProviderPlugin | undefined {
  return entries.find((entry) => entry.provider.id === providerId)?.provider;
}

function bindMigrationProviderToRegistry(
  provider: MigrationProviderPlugin,
  registry: PluginRegistry,
): MigrationProviderPlugin {
  return {
    ...provider,
    ...(provider.detect
      ? {
          detect: (ctx) => withPluginRuntimeRegistryScope(registry, () => provider.detect!(ctx)),
        }
      : {}),
    ...(provider.prepareApply
      ? {
          prepareApply: (ctx) =>
            withPluginRuntimeRegistryScope(registry, () => provider.prepareApply!(ctx)),
        }
      : {}),
    plan: (ctx) => withPluginRuntimeRegistryScope(registry, () => provider.plan(ctx)),
    apply: (ctx, plan) => withPluginRuntimeRegistryScope(registry, () => provider.apply(ctx, plan)),
  };
}

function resolveMigrationProviderConfig(params: {
  cfg?: OpenClawConfig;
  bundledCompatPluginIds: readonly string[];
}): OpenClawConfig | undefined {
  return withBundledPluginEnablementCompat({
    config: params.cfg,
    pluginIds: [...params.bundledCompatPluginIds],
  });
}

function resolveMigrationProviderRegistry(params: { cfg?: OpenClawConfig; pluginIds: string[] }) {
  const active = getLoadedRuntimePluginRegistry({ requiredPluginIds: params.pluginIds });
  if (active) {
    return active;
  }
  const standalone = standaloneMigrationRegistrySlot;
  return standalone &&
    standalone.config === params.cfg &&
    standalone.pluginIdsKey === migrationPluginIdsKey(params.pluginIds)
    ? standalone.registry
    : undefined;
}

function resolveMigrationProviderPluginResolution(params: {
  cfg?: OpenClawConfig;
  providerId?: string;
}): MigrationProviderPluginResolution {
  const resolution = resolveManifestContractRuntimePluginResolution({
    cfg: params.cfg,
    contract: "migrationProviders",
    ...(params.providerId ? { value: params.providerId } : {}),
  });
  const pluginIds = new Set(resolution.pluginIds);
  const bundledCompatPluginIds = new Set(resolution.bundledCompatPluginIds);

  // Install migration can persist a deliberately pruned bundled-plugin index.
  // Migration contracts still need manifest discovery to repair older indexes.
  for (const plugin of listBundledPluginMetadata({ includeChannelConfigs: false })) {
    const providerIds = plugin.manifest.contracts?.migrationProviders ?? [];
    if (
      providerIds.length === 0 ||
      (params.providerId && !providerIds.includes(params.providerId))
    ) {
      continue;
    }
    pluginIds.add(plugin.manifest.id);
    bundledCompatPluginIds.add(plugin.manifest.id);
  }

  return {
    pluginIds: [...pluginIds].toSorted((left, right) => left.localeCompare(right)),
    bundledCompatPluginIds: [...bundledCompatPluginIds].toSorted((left, right) =>
      left.localeCompare(right),
    ),
  };
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

export function ensureStandaloneMigrationProviderRegistryLoaded(
  params: {
    cfg?: OpenClawConfig;
    providerId?: string;
  } = {},
): void {
  const resolution = resolveMigrationProviderPluginResolution(params);
  if (resolution.pluginIds.length === 0) {
    return;
  }
  const compatConfig = resolveMigrationProviderConfig({
    cfg: params.cfg,
    bundledCompatPluginIds: resolution.bundledCompatPluginIds,
  });
  const registry = loadPluginRegistryHandle({
    ...(compatConfig === undefined ? {} : { config: compatConfig }),
    onlyPluginIds: resolution.pluginIds,
    activate: false,
  });
  standaloneMigrationRegistrySlot = registry
    ? {
        config: params.cfg,
        pluginIdsKey: migrationPluginIdsKey(resolution.pluginIds),
        registry,
      }
    : undefined;
}

export function resolvePluginMigrationProvider(params: {
  providerId: string;
  cfg?: OpenClawConfig;
}): MigrationProviderPlugin | undefined {
  const activeRegistry = getLoadedRuntimePluginRegistry();
  const activeProvider = findMigrationProviderById(
    activeRegistry?.migrationProviders ?? [],
    params.providerId,
  );
  if (activeProvider) {
    return activeProvider;
  }

  const resolution = resolveMigrationProviderPluginResolution({
    cfg: params.cfg,
    providerId: params.providerId,
  });
  const pluginIds = resolution.pluginIds;
  if (pluginIds.length === 0) {
    return undefined;
  }
  const registry = resolveMigrationProviderRegistry({
    cfg: params.cfg,
    pluginIds,
  });
  const provider = findMigrationProviderById(registry?.migrationProviders ?? [], params.providerId);
  return provider && registry ? bindMigrationProviderToRegistry(provider, registry) : undefined;
}

export function resolvePluginMigrationProviders(
  params: {
    cfg?: OpenClawConfig;
  } = {},
): MigrationProviderPlugin[] {
  const activeRegistry = getLoadedRuntimePluginRegistry();
  const activeProviders = activeRegistry?.migrationProviders ?? [];
  const resolution = resolveMigrationProviderPluginResolution({ cfg: params.cfg });
  const pluginIds = resolution.pluginIds;
  if (pluginIds.length === 0) {
    return mergeMigrationProviders(activeProviders, []);
  }
  const registry = resolveMigrationProviderRegistry({
    cfg: params.cfg,
    pluginIds,
  });
  const scopedProviders = registry
    ? registry.migrationProviders.map(({ provider }) => ({
        provider: bindMigrationProviderToRegistry(provider, registry),
      }))
    : [];
  return mergeMigrationProviders(activeProviders, scopedProviders);
}
