import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveVoiceModelRefs } from "../../packages/speech-core/voice-models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getLoadedRuntimePluginRegistry,
  registryContainsRuntimePluginIds,
} from "./active-runtime-registry.js";
import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import {
  withBundledPluginEnablementCompat,
  withBundledPluginVitestCompat,
} from "./bundled-compat.js";
import { resolveRuntimePluginRegistry, type PluginLoadOptions } from "./loader.js";
import {
  hasManifestContractValue,
  isManifestPluginAvailableForControlPlane,
  loadManifestContractSnapshot,
} from "./manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { normalizeCapabilityProviderId } from "./provider-registry-shared.js";
import type { PluginRegistry } from "./registry-types.js";

type CapabilityProviderRegistryKey =
  | "embeddingProviders"
  | "memoryEmbeddingProviders"
  | "speechProviders"
  | "realtimeTranscriptionProviders"
  | "realtimeVoiceProviders"
  | "mediaUnderstandingProviders"
  | "transcriptSourceProviders"
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders";

type CapabilityContractKey =
  | "embeddingProviders"
  | "memoryEmbeddingProviders"
  | "speechProviders"
  | "realtimeTranscriptionProviders"
  | "realtimeVoiceProviders"
  | "mediaUnderstandingProviders"
  | "transcriptSourceProviders"
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders";

type ProviderFor<K extends CapabilityProviderRegistryKey> = PluginRegistry[K][number] extends {
  provider: infer T;
}
  ? T
  : never;
type CapabilityPluginResolution = {
  runtimePluginIds: string[];
  bundledCompatPluginIds: string[];
};

const CAPABILITY_CONTRACT_KEY: Record<CapabilityProviderRegistryKey, CapabilityContractKey> = {
  embeddingProviders: "embeddingProviders",
  memoryEmbeddingProviders: "memoryEmbeddingProviders",
  speechProviders: "speechProviders",
  realtimeTranscriptionProviders: "realtimeTranscriptionProviders",
  realtimeVoiceProviders: "realtimeVoiceProviders",
  mediaUnderstandingProviders: "mediaUnderstandingProviders",
  transcriptSourceProviders: "transcriptSourceProviders",
  imageGenerationProviders: "imageGenerationProviders",
  videoGenerationProviders: "videoGenerationProviders",
  musicGenerationProviders: "musicGenerationProviders",
};

function shouldMergeManifestProvidersWhenActive(key: CapabilityProviderRegistryKey): boolean {
  return (
    key === "imageGenerationProviders" ||
    key === "videoGenerationProviders" ||
    key === "musicGenerationProviders"
  );
}

function shouldSkipCapabilityResolution(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
}): boolean {
  return params.cfg?.plugins?.enabled === false && params.key !== "speechProviders";
}

/** Loads the manifest snapshot used to resolve capability-provider ownership. */
export function loadCapabilityManifestSnapshot(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "plugins">;
}): Pick<PluginMetadataSnapshot, "index" | "plugins"> {
  if (params.pluginMetadataSnapshot) {
    return params.pluginMetadataSnapshot;
  }
  return loadManifestContractSnapshot({
    config: params.cfg,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
  });
}

function resolveCapabilityPluginIds(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  providerId?: string;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "plugins">;
}): CapabilityPluginResolution {
  const contractKey = CAPABILITY_CONTRACT_KEY[params.key];
  const snapshot = loadCapabilityManifestSnapshot(params);
  const contractPlugins = snapshot.plugins.filter((plugin) =>
    hasManifestContractValue({
      plugin,
      contract: contractKey,
      value: params.providerId,
    }),
  );
  return {
    runtimePluginIds: sortUniqueStrings(
      contractPlugins
        .filter((plugin) =>
          isManifestPluginAvailableForControlPlane({
            snapshot,
            plugin,
            config: params.cfg,
          }),
        )
        .map((plugin) => plugin.id),
    ),
    bundledCompatPluginIds: sortUniqueStrings(
      contractPlugins.filter((plugin) => plugin.origin === "bundled").map((plugin) => plugin.id),
    ),
  };
}

function createCapabilityProviderLoadOptions(params: {
  cfg?: OpenClawConfig;
  resolution: CapabilityPluginResolution;
}): PluginLoadOptions {
  const pluginIds = params.resolution.bundledCompatPluginIds;
  const enablementCompat = withBundledPluginEnablementCompat({
    config: params.cfg,
    pluginIds,
  });
  const config = withBundledPluginVitestCompat({
    config: enablementCompat,
    pluginIds,
    env: process.env,
  });
  return {
    ...(config === undefined ? {} : { config }),
    onlyPluginIds: params.resolution.runtimePluginIds,
    activate: false,
  };
}

function findProviderById<K extends CapabilityProviderRegistryKey>(
  entries: PluginRegistry[K],
  providerId: string,
): ProviderFor<K> | undefined {
  const normalizedProviderId = normalizeCapabilityProviderId(providerId);
  if (!normalizedProviderId) {
    return undefined;
  }
  const providerEntries = entries as unknown as Array<{
    provider: ProviderFor<K> & { id?: unknown; aliases?: unknown };
  }>;
  for (const entry of providerEntries) {
    if (
      typeof entry.provider.id === "string" &&
      normalizeCapabilityProviderId(entry.provider.id) === normalizedProviderId
    ) {
      return entry.provider;
    }
  }
  for (const entry of providerEntries) {
    const aliases = Array.isArray(entry.provider.aliases) ? entry.provider.aliases : [];
    if (
      aliases.some(
        (alias) =>
          typeof alias === "string" &&
          normalizeCapabilityProviderId(alias) === normalizedProviderId,
      )
    ) {
      return entry.provider;
    }
  }
  return undefined;
}

function mergeCapabilityProviders<K extends CapabilityProviderRegistryKey>(
  left: PluginRegistry[K],
  right: PluginRegistry[K],
): ProviderFor<K>[] {
  const merged = new Map<string, ProviderFor<K>>();
  const unnamed: ProviderFor<K>[] = [];
  const addEntries = (entries: PluginRegistry[K]) => {
    for (const entry of entries) {
      const provider = entry.provider as ProviderFor<K> & { id?: string };
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

function addModelConfigProviderIds(target: Set<string>, value: unknown): void {
  for (const ref of resolveVoiceModelRefs(value)) {
    addStringValue(target, ref.provider);
  }
}

function collectRequestedSpeechProviderIds(
  cfg: OpenClawConfig | undefined,
  options: { includeVoiceModel: boolean },
): Set<string> {
  const requested = new Set<string>();
  const tts =
    typeof cfg?.tts === "object" && cfg.tts !== null
      ? (cfg.tts as Record<string, unknown>)
      : undefined;
  addStringValue(requested, tts?.provider);
  addObjectKeys(requested, tts?.providers);
  if (options.includeVoiceModel) {
    addModelConfigProviderIds(requested, cfg?.agents?.defaults?.voiceModel);
  }
  addObjectKeys(requested, cfg?.models?.providers);
  return requested;
}

function collectRequestedVoiceModelProviderIds(cfg: OpenClawConfig | undefined): Set<string> {
  const requested = new Set<string>();
  addModelConfigProviderIds(requested, cfg?.agents?.defaults?.voiceModel);
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
  return requested;
}

function collectRequestedCapabilityProviderIds(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
  includeVoiceModel?: boolean;
}): Set<string> | undefined {
  switch (params.key) {
    case "speechProviders":
      return collectRequestedSpeechProviderIds(params.cfg, {
        includeVoiceModel: params.includeVoiceModel ?? false,
      });
    case "realtimeTranscriptionProviders":
    case "realtimeVoiceProviders":
      return params.includeVoiceModel
        ? collectRequestedVoiceModelProviderIds(params.cfg)
        : undefined;
    case "mediaUnderstandingProviders":
      return collectRequestedMediaUnderstandingProviderIds(params.cfg);
    default:
      return undefined;
  }
}

function nonEmptyRequestedProviders(requested: Set<string> | undefined): Set<string> | undefined {
  return requested && requested.size > 0 ? requested : undefined;
}

function shouldScopeCapabilityLoadToRequestedProviders(
  key: CapabilityProviderRegistryKey,
): boolean {
  return (
    key === "speechProviders" ||
    key === "realtimeTranscriptionProviders" ||
    key === "realtimeVoiceProviders"
  );
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
  if (
    params.key !== "speechProviders" &&
    params.key !== "realtimeTranscriptionProviders" &&
    params.key !== "realtimeVoiceProviders" &&
    params.key !== "mediaUnderstandingProviders"
  ) {
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

function resolveRequestedCapabilityPluginIds(params: {
  key: CapabilityProviderRegistryKey;
  cfg?: OpenClawConfig;
  requested?: Set<string>;
}): CapabilityPluginResolution | undefined {
  if (!params.requested || params.requested.size === 0) {
    return undefined;
  }
  const runtimePluginIds = new Set<string>();
  const bundledCompatPluginIds = new Set<string>();
  for (const providerId of params.requested) {
    const resolution = resolveCapabilityPluginIds({
      key: params.key,
      cfg: params.cfg,
      providerId,
    });
    for (const pluginId of resolution.runtimePluginIds) {
      runtimePluginIds.add(pluginId);
    }
    for (const pluginId of resolution.bundledCompatPluginIds) {
      bundledCompatPluginIds.add(pluginId);
    }
  }
  return runtimePluginIds.size > 0
    ? {
        runtimePluginIds: sortUniqueStrings(runtimePluginIds),
        bundledCompatPluginIds: sortUniqueStrings(bundledCompatPluginIds),
      }
    : undefined;
}

function loadCapabilityProviderEntries<K extends CapabilityProviderRegistryKey>(params: {
  key: K;
  bundledCompatPluginIds: string[];
  loadOptions: PluginLoadOptions;
  requested?: Set<string>;
}): PluginRegistry[K] {
  const loadedRegistry = getLoadedRuntimePluginRegistry({
    env: params.loadOptions.env,
    loadOptions: params.loadOptions,
    workspaceDir: params.loadOptions.workspaceDir,
    requiredPluginIds: params.loadOptions.onlyPluginIds,
  });
  const loadedEntries = loadedRegistry?.[params.key] ?? [];
  const coldRegistry = loadedRegistry
    ? undefined
    : resolveRuntimePluginRegistry(params.loadOptions);
  const coldEntries = coldRegistry?.[params.key] ?? [];
  const entries =
    loadedEntries.length > 0 && coldEntries.length > 0
      ? mergeCapabilityProviderEntries(loadedEntries, coldEntries)
      : loadedEntries.length > 0
        ? loadedEntries
        : coldEntries;
  const missingRequested =
    params.requested && params.requested.size > 0 ? new Set(params.requested) : undefined;
  if (missingRequested) {
    removeActiveProviderIds(missingRequested, entries);
  }
  if (entries.length > 0 && (!missingRequested || missingRequested.size === 0)) {
    return entries;
  }
  if (params.bundledCompatPluginIds.length === 0) {
    return entries;
  }
  const captured = loadBundledCapabilityRuntimeRegistry({
    pluginIds: params.bundledCompatPluginIds,
    env: process.env,
    pluginSdkResolution: params.loadOptions.pluginSdkResolution,
  })[params.key] as PluginRegistry[K];
  return entries.length > 0 ? mergeCapabilityProviderEntries(entries, captured) : captured;
}

export function resolvePluginCapabilityProvider<K extends CapabilityProviderRegistryKey>(params: {
  key: K;
  providerId: string;
  cfg?: OpenClawConfig;
}): ProviderFor<K> | undefined {
  if (shouldSkipCapabilityResolution(params)) {
    return undefined;
  }

  const activeRegistry = getLoadedRuntimePluginRegistry();
  const activeProvider = findProviderById(activeRegistry?.[params.key] ?? [], params.providerId);
  if (activeProvider) {
    return activeProvider;
  }

  let pluginIds = resolveCapabilityPluginIds({
    key: params.key,
    cfg: params.cfg,
    providerId: params.providerId,
  });
  if (pluginIds.runtimePluginIds.length === 0) {
    // Manifest contracts index canonical provider ids, while runtime providers
    // may expose aliases. Fall back to the capability owners so a configured
    // alias can still resolve when its provider is absent from the active registry.
    pluginIds = resolveCapabilityPluginIds({ key: params.key, cfg: params.cfg });
    if (pluginIds.runtimePluginIds.length === 0) {
      return undefined;
    }
  }

  const loadOptions = createCapabilityProviderLoadOptions({
    cfg: params.cfg,
    resolution: pluginIds,
  });
  const loadedProviders = loadCapabilityProviderEntries({
    key: params.key,
    bundledCompatPluginIds: pluginIds.bundledCompatPluginIds,
    loadOptions,
    requested: new Set([params.providerId.toLowerCase()]),
  });
  return findProviderById(loadedProviders, params.providerId);
}

export function resolvePluginCapabilityProviders<K extends CapabilityProviderRegistryKey>(params: {
  key: K;
  cfg?: OpenClawConfig;
}): ProviderFor<K>[] {
  if (shouldSkipCapabilityResolution(params)) {
    return [];
  }

  const activeRegistry = getLoadedRuntimePluginRegistry();
  const activeProviders = activeRegistry?.[params.key] ?? [];
  const missingRequestedProviders =
    activeProviders.length > 0
      ? nonEmptyRequestedProviders(
          collectRequestedCapabilityProviderIds({
            key: params.key,
            cfg: params.cfg,
            includeVoiceModel: true,
          }),
        )
      : undefined;
  if (activeProviders.length > 0 && params.key !== "memoryEmbeddingProviders") {
    if (!missingRequestedProviders && !shouldMergeManifestProvidersWhenActive(params.key)) {
      return activeProviders.map((entry) => entry.provider) as ProviderFor<K>[];
    }
    if (missingRequestedProviders) {
      removeActiveProviderIds(missingRequestedProviders, activeProviders);
      if (missingRequestedProviders.size === 0) {
        return activeProviders.map((entry) => entry.provider) as ProviderFor<K>[];
      }
    }
  }
  const requestedProviders =
    missingRequestedProviders ??
    (activeProviders.length === 0
      ? nonEmptyRequestedProviders(
          collectRequestedCapabilityProviderIds({ key: params.key, cfg: params.cfg }),
        )
      : undefined);
  const requestedProviderLoadScope =
    requestedProviders && shouldScopeCapabilityLoadToRequestedProviders(params.key)
      ? requestedProviders
      : undefined;
  const requestedPluginIds = resolveRequestedCapabilityPluginIds({
    key: params.key,
    cfg: params.cfg,
    requested: requestedProviderLoadScope,
  });
  const requestedProviderFilter =
    requestedProviders &&
    (!shouldScopeCapabilityLoadToRequestedProviders(params.key) || requestedPluginIds)
      ? requestedProviders
      : undefined;
  const pluginIds =
    requestedPluginIds ??
    resolveCapabilityPluginIds({
      key: params.key,
      cfg: params.cfg,
    });
  const loadOptions = createCapabilityProviderLoadOptions({
    cfg: params.cfg,
    resolution: pluginIds,
  });
  const loadedProviders = loadCapabilityProviderEntries({
    key: params.key,
    bundledCompatPluginIds: pluginIds.bundledCompatPluginIds,
    loadOptions,
    requested: requestedProviderFilter,
  });
  if (params.key !== "memoryEmbeddingProviders") {
    const requestedLoadedProviders = requestedProviderFilter
      ? filterLoadedProvidersForRequestedConfig({
          key: params.key,
          requested: requestedProviderFilter,
          entries: loadedProviders,
        })
      : loadedProviders;
    const mergeLoadedProviders =
      activeProviders.length > 0 && missingRequestedProviders
        ? filterLoadedProvidersForRequestedConfig({
            key: params.key,
            requested: missingRequestedProviders,
            entries: requestedLoadedProviders,
          })
        : requestedLoadedProviders;
    return mergeCapabilityProviders(activeProviders, mergeLoadedProviders);
  }
  return mergeCapabilityProviders(activeProviders, loadedProviders);
}

export function prepareMediaCapabilityProviders(params: {
  cfg?: OpenClawConfig;
  pluginMetadataSnapshot: Pick<PluginMetadataSnapshot, "index" | "plugins">;
  registry?: PluginRegistry;
}) {
  const providers = <K extends CapabilityProviderRegistryKey>(
    key: K,
  ): readonly ProviderFor<K>[] | undefined => {
    if (shouldSkipCapabilityResolution({ key, cfg: params.cfg })) {
      return [];
    }
    const resolution = resolveCapabilityPluginIds({
      key,
      cfg: params.cfg,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    });
    const requiredPluginIds = sortUniqueStrings([
      ...resolution.runtimePluginIds,
      ...resolution.bundledCompatPluginIds,
    ]);
    if (!params.registry || !registryContainsRuntimePluginIds(params.registry, requiredPluginIds)) {
      return undefined;
    }
    const eligiblePluginIds = new Set(requiredPluginIds);
    if (params.registry[key].some((entry) => !eligiblePluginIds.has(entry.pluginId))) {
      return undefined;
    }
    return Object.freeze(
      params.registry[key].map((entry) => entry.provider),
    ) as readonly ProviderFor<K>[];
  };
  return Object.freeze({
    mediaUnderstandingProviders: providers("mediaUnderstandingProviders"),
    imageGenerationProviders: providers("imageGenerationProviders"),
    videoGenerationProviders: providers("videoGenerationProviders"),
    musicGenerationProviders: providers("musicGenerationProviders"),
  });
}
