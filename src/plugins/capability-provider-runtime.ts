import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
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

function mergeCapabilityProviderEntries<K extends CapabilityProviderRegistryKey>(
  left: PluginRegistry[K],
  right: PluginRegistry[K],
): PluginRegistry[K] {
  const merged = new Map<string, PluginRegistry[K][number]>();
  const unnamed: Array<PluginRegistry[K][number]> = [];
  const addEntries = (entries: PluginRegistry[K]) => {
    for (const entry of entries) {
      const provider = entry.provider as { id?: string };
      if (!provider.id) {
        unnamed.push(entry);
        continue;
      }
      if (!merged.has(provider.id)) {
        merged.set(provider.id, entry);
      }
    }
  };

  addEntries(left);
  addEntries(right);
  return [...merged.values(), ...unnamed] as PluginRegistry[K];
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

function addMediaModelProviders(target: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const entry of value) {
    if (typeof entry === "object" && entry !== null) {
      addStringValue(target, (entry as { provider?: unknown }).provider);
    }
  }
}

function collectRequestedMediaUnderstandingProviderIds(
  cfg: OpenClawConfig | undefined,
): Set<string> {
  const requested = new Set<string>();
  const media = cfg?.tools?.media;
  addMediaModelProviders(requested, media?.models);
  addMediaModelProviders(requested, media?.image?.models);
  addMediaModelProviders(requested, media?.audio?.models);
  addMediaModelProviders(requested, media?.video?.models);
  return requested;
}

function collectRequestedCapabilityProviderIds(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
}): Set<string> | undefined {
  switch (params.key) {
    case "speechProviders":
      return collectRequestedSpeechProviderIds(params.cfg);
    case "mediaUnderstandingProviders":
      return collectRequestedMediaUnderstandingProviderIds(params.cfg);
    default:
      return undefined;
  }
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
  if (params.key !== "speechProviders" && params.key !== "mediaUnderstandingProviders") {
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

function resolveRequestedCapabilityCompatPluginIds(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
  requested?: Set<string>;
}): string[] | undefined {
  if (params.key !== "speechProviders" || !params.requested || params.requested.size === 0) {
    return undefined;
  }
  const pluginIds = new Set<string>();
  for (const providerId of params.requested) {
    for (const pluginId of resolveBundledCapabilityCompatPluginIds({
      key: params.key,
      cfg: params.cfg,
      providerId,
    })) {
      pluginIds.add(pluginId);
    }
  }
  return pluginIds.size > 0
    ? [...pluginIds].toSorted((left, right) => left.localeCompare(right))
    : undefined;
}

function loadCapabilityProviderEntries<K extends CapabilityProviderRegistryKey>(params: {
  key: K;
  pluginIds: string[];
  loadOptions: PluginLoadOptions;
  requested?: Set<string>;
}): PluginRegistry[K] {
  const registry = resolveRuntimePluginRegistry(params.loadOptions);
  const entries = registry?.[params.key] ?? [];
  const missingRequested =
    params.key === "speechProviders" && params.requested && params.requested.size > 0
      ? new Set(params.requested)
      : undefined;
  if (missingRequested) {
    removeActiveProviderIds(missingRequested, entries);
  }
  if (entries.length > 0 && (!missingRequested || missingRequested.size === 0)) {
    return entries;
  }
  if (params.pluginIds.length === 0) {
    return entries;
  }
  const captured = loadBundledCapabilityRuntimeRegistry({
    pluginIds: params.pluginIds,
    env: process.env,
    pluginSdkResolution: params.loadOptions.pluginSdkResolution,
  })[params.key] as PluginRegistry[K];
  return entries.length > 0 ? mergeCapabilityProviderEntries(entries, captured) : captured;
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
    loadedProviders = loadCapabilityProviderEntries({
      key: params.key,
      pluginIds,
      loadOptions,
      requested: new Set([params.providerId.toLowerCase()]),
    });
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
  const missingRequestedProviders =
    activeProviders.length > 0
      ? collectRequestedCapabilityProviderIds({ key: params.key, cfg: params.cfg })
      : undefined;
  if (activeProviders.length > 0 && params.key !== "memoryEmbeddingProviders") {
    if (!missingRequestedProviders) {
      return activeProviders.map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
    }
    removeActiveProviderIds(missingRequestedProviders, activeProviders);
    if (missingRequestedProviders.size === 0) {
      return activeProviders.map((entry) => entry.provider) as CapabilityProviderForKey<K>[];
    }
  }
  let requestedSpeechProviders: Set<string> | undefined;
  if (params.key === "speechProviders") {
    requestedSpeechProviders =
      missingRequestedProviders ??
      (activeProviders.length === 0 ? collectRequestedSpeechProviderIds(params.cfg) : undefined);
  }
  const pluginIds =
    resolveRequestedCapabilityCompatPluginIds({
      key: params.key,
      cfg: params.cfg,
      requested: requestedSpeechProviders,
    }) ??
    resolveBundledCapabilityCompatPluginIds({
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
    loadedProviders = loadCapabilityProviderEntries({
      key: params.key,
      pluginIds,
      loadOptions,
      requested: requestedSpeechProviders,
    });
    cache?.set(cacheKey, loadedProviders as CapabilityProviderEntries);
  }
  if (params.key !== "memoryEmbeddingProviders") {
    const mergeLoadedProviders =
      activeProviders.length > 0
        ? filterLoadedProvidersForRequestedConfig({
            key: params.key,
            requested: missingRequestedProviders ?? new Set(),
            entries: loadedProviders,
          })
        : loadedProviders;
    return mergeCapabilityProviders(activeProviders, mergeLoadedProviders);
  }
  return mergeCapabilityProviders(activeProviders, loadedProviders);
}
