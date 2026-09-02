// Runtime bridge for plugin-provided migration hooks.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { withBundledPluginEnablementCompat } from "./bundled-compat.js";
import { listBundledPluginMetadata } from "./bundled-plugin-metadata.js";
import { loadPluginRegistryHandle } from "./loader.js";
import { resolveManifestContractRuntimePluginResolution } from "./manifest-contract-runtime.js";
import {
  resolveBundledMigrationProviderPublicArtifacts,
  type MigrationProviderArtifactPlugin,
} from "./migration-provider-public-artifacts.js";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import type { MigrationProviderPlugin } from "./types.js";

type MigrationProviderPluginResolution = {
  pluginIds: string[];
  bundledCompatPluginIds: string[];
  bundledPlugins: MigrationProviderArtifactPlugin[];
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

function resolveMigrationProviderRegistry(params: {
  cfg?: OpenClawConfig;
  pluginIds: string[];
  providerId?: string;
}) {
  const active = getLoadedRuntimePluginRegistry({ requiredPluginIds: params.pluginIds });
  if (
    active &&
    (!params.providerId ||
      findMigrationProviderById(active.migrationProviders, params.providerId) !== undefined)
  ) {
    return active;
  }
  const standalone = standaloneMigrationRegistrySlot;
  return standalone &&
    !isPluginRegistryRetired(standalone.registry) &&
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
  const bundledPlugins: MigrationProviderPluginResolution["bundledPlugins"] = [];

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
    bundledPlugins.push({
      id: plugin.manifest.id,
      origin: "bundled",
      rootDir: plugin.rootDir,
      contracts: { migrationProviders: providerIds },
    });
  }

  return {
    pluginIds: [...pluginIds].toSorted((left, right) => left.localeCompare(right)),
    bundledCompatPluginIds: [...bundledCompatPluginIds].toSorted((left, right) =>
      left.localeCompare(right),
    ),
    bundledPlugins,
  };
}

function mergeMigrationProviders(
  ...groups: readonly (readonly MigrationProviderPlugin[])[]
): MigrationProviderPlugin[] {
  const merged = new Map<string, MigrationProviderPlugin>();
  for (const providers of groups) {
    for (const provider of providers) {
      if (!merged.has(provider.id)) {
        merged.set(provider.id, provider);
      }
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
  const compatConfig = withBundledPluginEnablementCompat({
    config: params.cfg,
    pluginIds: resolution.bundledCompatPluginIds,
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
  const resolution = resolveMigrationProviderPluginResolution({
    cfg: params.cfg,
    providerId: params.providerId,
  });
  const publicProviders = resolveBundledMigrationProviderPublicArtifacts({
    plugins: resolution.bundledPlugins,
    providerId: params.providerId,
  });
  if (publicProviders[0]) {
    return publicProviders[0].provider;
  }
  const activeRegistry = getLoadedRuntimePluginRegistry();
  const activeProvider = findMigrationProviderById(
    activeRegistry?.migrationProviders ?? [],
    params.providerId,
  );
  if (activeProvider) {
    return activeProvider;
  }
  const pluginIds = resolution.pluginIds;
  if (pluginIds.length === 0) {
    return undefined;
  }
  const registry = resolveMigrationProviderRegistry({
    cfg: params.cfg,
    pluginIds,
    providerId: params.providerId,
  });
  const provider = findMigrationProviderById(registry?.migrationProviders ?? [], params.providerId);
  return provider && registry ? bindMigrationProviderToRegistry(provider, registry) : undefined;
}

export function resolvePluginMigrationProviders(
  params: {
    cfg?: OpenClawConfig;
  } = {},
): MigrationProviderPlugin[] {
  // Plural listing is registry-admission-scoped. Cold pickers read manifest contracts,
  // while admission-independent public artifacts belong only to explicit provider lookup.
  const activeRegistry = getLoadedRuntimePluginRegistry();
  const activeProviders = activeRegistry?.migrationProviders ?? [];
  const resolution = resolveMigrationProviderPluginResolution({ cfg: params.cfg });
  const pluginIds = resolution.pluginIds;
  if (pluginIds.length === 0) {
    return mergeMigrationProviders(activeProviders.map(({ provider }) => provider));
  }
  const registry = resolveMigrationProviderRegistry({
    cfg: params.cfg,
    pluginIds,
  });
  const scopedProviders = registry
    ? registry.migrationProviders.map(({ provider }) =>
        bindMigrationProviderToRegistry(provider, registry),
      )
    : [];
  return mergeMigrationProviders(
    activeProviders.map(({ provider }) => provider),
    scopedProviders,
  );
}
