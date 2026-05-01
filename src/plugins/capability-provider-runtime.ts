import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  withBundledPluginAllowlistCompat,
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import {
  resolvePluginRegistryLoadCacheKey,
  resolveRuntimePluginRegistry,
  type PluginLoadOptions,
} from "./loader.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";
import type { PluginRegistry } from "./registry-types.js";

type CapabilityProviderRegistryKey =
  | "memoryEmbeddingProviders"
  | "speechProviders"
  | "realtimeTranscriptionProviders"
  | "realtimeVoiceProviders"
  | "mediaUnderstandingProviders"
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders";

type CapabilityContractKey =
  | "memoryEmbeddingProviders"
  | "speechProviders"
  | "realtimeTranscriptionProviders"
  | "realtimeVoiceProviders"
  | "mediaUnderstandingProviders"
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders";

type CapabilityProviderForKey<K extends CapabilityProviderRegistryKey> =
  PluginRegistry[K][number] extends { provider: infer T } ? T : never;
type CapabilityProviderEntries = PluginRegistry[CapabilityProviderRegistryKey];

const capabilityProviderSnapshotCache = new WeakMap<
  OpenClawConfig,
  Map<string, CapabilityProviderEntries>
>();

const CAPABILITY_CONTRACT_KEY: Record<CapabilityProviderRegistryKey, CapabilityContractKey> = {
  memoryEmbeddingProviders: "memoryEmbeddingProviders",
  speechProviders: "speechProviders",
  realtimeTranscriptionProviders: "realtimeTranscriptionProviders",
  realtimeVoiceProviders: "realtimeVoiceProviders",
  mediaUnderstandingProviders: "mediaUnderstandingProviders",
  imageGenerationProviders: "imageGenerationProviders",
  videoGenerationProviders: "videoGenerationProviders",
  musicGenerationProviders: "musicGenerationProviders",
};

function shouldResolveWhenPluginsAreGloballyDisabled(key: CapabilityProviderRegistryKey): boolean {
  return key === "speechProviders";
}

function shouldSkipCapabilityResolution(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
}): boolean {
  return (
    params.cfg?.plugins?.enabled === false &&
    !shouldResolveWhenPluginsAreGloballyDisabled(params.key)
  );
}

function resolveBundledCapabilityCompatPluginIds(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
  providerId?: string;
}): string[] {
  const env = process.env;
  const contractKey = CAPABILITY_CONTRACT_KEY[params.key];
  return loadPluginManifestRegistryForPluginRegistry({
    config: params.cfg,
    env,
    includeDisabled: true,
  })
    .plugins.filter(
      (plugin) =>
        plugin.origin === "bundled" &&
        (plugin.contracts?.[contractKey]?.length ?? 0) > 0 &&
        (!params.providerId || (plugin.contracts?.[contractKey] ?? []).includes(params.providerId)),
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function resolveBundledCapabilityProviderIds(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
}): string[] {
  const env = process.env;
  const contractKey = CAPABILITY_CONTRACT_KEY[params.key];
  return [
    ...new Set(
      loadPluginManifestRegistryForPluginRegistry({
        config: params.cfg,
        env,
        includeDisabled: true,
      }).plugins.flatMap((plugin) =>
        plugin.origin === "bundled" ? (plugin.contracts?.[contractKey] ?? []) : [],
      ),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function resolveCapabilityProviderConfig(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
  pluginIds?: string[];
}) {
  const pluginIds = params.pluginIds ?? resolveBundledCapabilityCompatPluginIds(params);
  const allowlistCompat = withBundledPluginAllowlistCompat({
    config: params.cfg,
    pluginIds,
  });
  const enablementCompat = withBundledPluginEnablementCompat({
    config: allowlistCompat,
    pluginIds,
  });
  return withBundledPluginVitestCompat({
    config: enablementCompat,
    pluginIds,
    env: process.env,
  });
}

function createCapabilityProviderFallbackLoadOptions(params: {
  compatConfig?: OpenClawConfig;
  pluginIds: string[];
  installBundledRuntimeDeps?: boolean;
}): PluginLoadOptions {
  const loadOptions: PluginLoadOptions = {
    ...(params.compatConfig === undefined ? {} : { config: params.compatConfig }),
    onlyPluginIds: params.pluginIds,
    activate: false,
  };
  if (params.installBundledRuntimeDeps === false) {
    loadOptions.installBundledRuntimeDeps = false;
  }
  return loadOptions;
}

function resolveCapabilityProviderSnapshotCache(
  cfg: OpenClawConfig | undefined,
): Map<string, CapabilityProviderEntries> | undefined {
  if (!cfg) {
    return undefined;
  }
  let cache = capabilityProviderSnapshotCache.get(cfg);
  if (!cache) {
    cache = new Map();
    capabilityProviderSnapshotCache.set(cfg, cache);
  }
  return cache;
}

function resolveCapabilityProviderSnapshotCacheKey(params: {
  key: CapabilityProviderRegistryKey;
  loadOptions: PluginLoadOptions;
}): string {
  return JSON.stringify({
    key: params.key,
    load: resolvePluginRegistryLoadCacheKey(params.loadOptions),
  });
}

function findProviderById<K extends CapabilityProviderRegistryKey>(
  entries: PluginRegistry[K],
  providerId: string,
): CapabilityProviderForKey<K> | undefined {
  const providerEntries = entries as unknown as Array<{
    provider: CapabilityProviderForKey<K> & { id?: unknown };
  }>;
  for (const entry of providerEntries) {
    if (entry.provider.id === providerId) {
      return entry.provider;
    }
  }
  return undefined;
}

function mergeCapabilityProviders<K extends CapabilityProviderRegistryKey>(
  left: PluginRegistry[K],
  right: PluginRegistry[K],
): CapabilityProviderForKey<K>[] {
  const merged = new Map<string, CapabilityProviderForKey<K>>();
  const unnamed: CapabilityProviderForKey<K>[] = [];
  const addEntries = (entries: PluginRegistry[K]) => {
    for (const entry of entries) {
      const provider = entry.provider as CapabilityProviderForKey<K> & { id?: string };
      if (!provider.id) {
        unnamed.push(provider);
        continue;
      }
      if (!merged.has(provider.id)) {
        merged.set(provider.id, provider);
      }
    }
  };

  addEntries(left);
  addEntries(right);
  return [...merged.values(), ...unnamed];
}

function addObjectKeys(target: Set<string>, value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    const normalized = key.trim().toLowerCase();
    if (normalized) {
      target.add(normalized);
    }
  }
}

function addStringValue(target: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized) {
    target.add(normalized);
  }
}

function collectRequestedSpeechProviderIds(cfg: OpenClawConfig | undefined): Set<string> {
  const requested = new Set<string>();
  const tts =
    typeof cfg?.messages?.tts === "object" && cfg.messages.tts !== null
      ? (cfg.messages.tts as Record<string, unknown>)
      : undefined;
  addStringValue(requested, tts?.provider);
  addObjectKeys(requested, tts?.providers);
  addObjectKeys(requested, cfg?.models?.providers);
  return requested;
}

function removeActiveProviderIds(requested: Set<string>, entries: readonly unknown[]): void {
  for (const entry of entries as Array<{ provider: { id?: unknown; aliases?: unknown } }>) {
    const provider = entry.provider as { id?: unknown; aliases?: unknown };
    if (typeof provider.id === "string") {
      requested.delete(provider.id.toLowerCase());
    }
    if (Array.isArray(provider.aliases)) {
      for (const alias of provider.aliases) {
        if (typeof alias === "string") {
          requested.delete(alias.toLowerCase());
        }
      }
    }
  }
}

function filterLoadedProvidersForRequestedConfig<K extends CapabilityProviderRegistryKey>(params: {
  key: K;
  requested: Set<string>;
  entries: PluginRegistry[K];
}): PluginRegistry[K] {
  if (params.key !== "speechProviders") {
    return [] as unknown as PluginRegistry[K];
  }
  if (params.requested.size === 0) {
    return [] as unknown as PluginRegistry[K];
  }
  return params.entries.filter((entry) => {
    const provider = entry.provider as { id?: unknown; aliases?: unknown };
    if (typeof provider.id === "string" && params.requested.has(provider.id.toLowerCase())) {
      return true;
    }
    if (Array.isArray(provider.aliases)) {
      return provider.aliases.some(
        (alias) => typeof alias === "string" && params.requested.has(alias.toLowerCase()),
      );
    }
    return false;
  }) as PluginRegistry[K];
}

export function resolvePluginCapabilityProvider<K extends CapabilityProviderRegistryKey>(params: {
  key: K;
  providerId: string;
  cfg?: OpenClawConfig;
  installBundledRuntimeDeps?: boolean;
}): CapabilityProviderForKey<K> | undefined {
  if (shouldSkipCapabilityResolution(params)) {
    return undefined;
  }

  const activeRegistry = resolveRuntimePluginRegistry();
  const activeProvider = findProviderById(activeRegistry?.[params.key] ?? [], params.providerId);
  if (activeProvider) {
    return activeProvider;
  }

  const pluginIds = resolveBundledCapabilityCompatPluginIds({
    key: params.key,
    cfg: params.cfg,
    providerId: params.providerId,
  });
  if (pluginIds.length === 0) {
    return undefined;
  }

  const compatConfig = resolveCapabilityProviderConfig({
    key: params.key,
    cfg: params.cfg,
    pluginIds,
  });
  const loadOptions = createCapabilityProviderFallbackLoadOptions({
    compatConfig,
    pluginIds,
    installBundledRuntimeDeps: params.installBundledRuntimeDeps ?? false,
  });
  const cache = resolveCapabilityProviderSnapshotCache(params.cfg);
  const cacheKey = cache
    ? resolveCapabilityProviderSnapshotCacheKey({ key: params.key, loadOptions })
    : "";
  let loadedProviders = cache?.get(cacheKey) as PluginRegistry[K] | undefined;
  if (!loadedProviders) {
    const registry = resolveRuntimePluginRegistry(loadOptions);
    loadedProviders = registry?.[params.key] ?? [];
    cache?.set(cacheKey, loadedProviders as CapabilityProviderEntries);
  }
  return findProviderById(loadedProviders, params.providerId);
}

export function resolvePluginCapabilityProviders<K extends CapabilityProviderRegistryKey>(params: {
  key: K;
  cfg?: OpenClawConfig;
  installBundledRuntimeDeps?: boolean;
}): CapabilityProviderForKey<K>[] {
  if (shouldSkipCapabilityResolution(params)) {
    return [];
  }

  const activeRegistry = resolveRuntimePluginRegistry();
  const activeProviders = activeRegistry?.[params.key] ?? [];
  if (
    activeProviders.length > 0 &&
    params.key !== "memoryEmbeddingProviders" &&
    params.key !== "speechProviders"
  ) {
    return activeProviders.map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
  }
  if (activeProviders.length > 0 && params.key === "speechProviders" && !params.cfg) {
    return activeProviders.map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
  }
  const missingRequestedSpeechProviders =
    activeProviders.length > 0 && params.key === "speechProviders"
      ? collectRequestedSpeechProviderIds(params.cfg)
      : undefined;
  if (missingRequestedSpeechProviders) {
    removeActiveProviderIds(missingRequestedSpeechProviders, activeProviders);
    if (missingRequestedSpeechProviders.size === 0) {
      return activeProviders.map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
    }
  }
  const pluginIds = resolveBundledCapabilityCompatPluginIds({
    key: params.key,
    cfg: params.cfg,
  });
  const compatConfig = resolveCapabilityProviderConfig({
    key: params.key,
    cfg: params.cfg,
    pluginIds,
  });
  const loadOptions = createCapabilityProviderFallbackLoadOptions({
    compatConfig,
    pluginIds,
    installBundledRuntimeDeps: params.installBundledRuntimeDeps ?? false,
  });
  const cache = resolveCapabilityProviderSnapshotCache(params.cfg);
  const cacheKey = cache
    ? resolveCapabilityProviderSnapshotCacheKey({ key: params.key, loadOptions })
    : "";
  let loadedProviders = cache?.get(cacheKey) as PluginRegistry[K] | undefined;
  if (!loadedProviders) {
    const registry = resolveRuntimePluginRegistry(loadOptions);
    loadedProviders = registry?.[params.key] ?? [];
    cache?.set(cacheKey, loadedProviders as CapabilityProviderEntries);
  }
  if (params.key !== "memoryEmbeddingProviders") {
    const mergeLoadedProviders =
      activeProviders.length > 0
        ? filterLoadedProvidersForRequestedConfig({
            key: params.key,
            requested: missingRequestedSpeechProviders ?? new Set(),
            entries: loadedProviders,
          })
        : loadedProviders;
    return mergeCapabilityProviders(activeProviders, mergeLoadedProviders);
  }
  return mergeCapabilityProviders(activeProviders, loadedProviders);
}
