import { normalizeProviderId } from "../../agents/provider-id.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { loadBundledCapabilityRuntimeRegistry } from "../bundled-capability-runtime.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";
import { resolveManifestContractPluginIds } from "../plugin-registry.js";
import { resolveBundledExplicitProviderContractsFromPublicArtifacts } from "../provider-contract-public-artifacts.js";
import type {
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  MusicGenerationProviderPlugin,
  ProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
  VideoGenerationProviderPlugin,
  WebFetchProviderPlugin,
  WebSearchProviderPlugin,
} from "../types.js";
import { resolveBundledExplicitWebSearchProvidersFromPublicArtifacts } from "../web-provider-public-artifacts.explicit.js";
import {
  BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS,
  type BundledPluginContractSnapshot,
} from "./inventory/bundled-capability-metadata.js";
import { uniqueStrings } from "./shared.js";
import {
  loadVitestImageGenerationProviderContractRegistry,
  loadVitestMediaUnderstandingProviderContractRegistry,
  loadVitestMusicGenerationProviderContractRegistry,
  loadVitestRealtimeTranscriptionProviderContractRegistry,
  loadVitestRealtimeVoiceProviderContractRegistry,
  loadVitestSpeechProviderContractRegistry,
  loadVitestVideoGenerationProviderContractRegistry,
} from "./speech-vitest-registry.js";

type BundledCapabilityRuntimeRegistry = ReturnType<typeof loadBundledCapabilityRuntimeRegistry>;
type CapabilityContractEntry<T> = {
  pluginId: string;
  provider: T;
};

type ProviderContractEntry = CapabilityContractEntry<ProviderPlugin>;
type WebSearchProviderContractEntry = CapabilityContractEntry<WebSearchProviderPlugin> & {
  credentialValue: unknown;
};
type WebFetchProviderContractEntry = CapabilityContractEntry<WebFetchProviderPlugin> & {
  credentialValue: unknown;
};
type SpeechProviderContractEntry = CapabilityContractEntry<SpeechProviderPlugin>;
type RealtimeTranscriptionProviderContractEntry =
  CapabilityContractEntry<RealtimeTranscriptionProviderPlugin>;
type RealtimeVoiceProviderContractEntry = CapabilityContractEntry<RealtimeVoiceProviderPlugin>;
type MediaUnderstandingProviderContractEntry =
  CapabilityContractEntry<MediaUnderstandingProviderPlugin>;
type ImageGenerationProviderContractEntry = CapabilityContractEntry<ImageGenerationProviderPlugin>;
type VideoGenerationProviderContractEntry = CapabilityContractEntry<VideoGenerationProviderPlugin>;
type MusicGenerationProviderContractEntry = CapabilityContractEntry<MusicGenerationProviderPlugin>;

type PluginRegistrationContractEntry = BundledPluginContractSnapshot;

type ManifestContractKey =
  | "speechProviders"
  | "realtimeTranscriptionProviders"
  | "realtimeVoiceProviders"
  | "mediaUnderstandingProviders"
  | "documentExtractors"
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders"
  | "webContentExtractors"
  | "webFetchProviders"
  | "webSearchProviders"
  | "tools";

type ManifestRegistryContractKey = "webFetchProviders" | "webSearchProviders";

function normalizeProviderAuthEnvVars(
  providerAuthEnvVars: Record<string, string[]> | undefined,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(providerAuthEnvVars ?? {}).map(([providerId, envVars]) => [
      providerId,
      uniqueStrings(envVars),
    ]),
  );
}

function resolveBundledManifestContracts(): PluginRegistrationContractEntry[] {
  if (process.env.VITEST) {
    return BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.map((entry) => ({
      pluginId: entry.pluginId,
      cliBackendIds: [...entry.cliBackendIds],
      providerIds: [...entry.providerIds],
      providerAuthEnvVars: normalizeProviderAuthEnvVars(entry.providerAuthEnvVars),
      speechProviderIds: [...entry.speechProviderIds],
      realtimeTranscriptionProviderIds: [...entry.realtimeTranscriptionProviderIds],
      realtimeVoiceProviderIds: [...entry.realtimeVoiceProviderIds],
      mediaUnderstandingProviderIds: [...entry.mediaUnderstandingProviderIds],
      documentExtractorIds: [...entry.documentExtractorIds],
      imageGenerationProviderIds: [...entry.imageGenerationProviderIds],
      videoGenerationProviderIds: [...entry.videoGenerationProviderIds],
      musicGenerationProviderIds: [...entry.musicGenerationProviderIds],
      webContentExtractorIds: [...entry.webContentExtractorIds],
      webFetchProviderIds: [...entry.webFetchProviderIds],
      webSearchProviderIds: [...entry.webSearchProviderIds],
      toolNames: [...entry.toolNames],
    }));
  }
  return loadPluginManifestRegistry({})
    .plugins.filter(
      (plugin) =>
        plugin.origin === "bundled" &&
        (plugin.cliBackends.length > 0 ||
          plugin.providers.length > 0 ||
          (plugin.contracts?.speechProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.realtimeTranscriptionProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.realtimeVoiceProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.mediaUnderstandingProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.documentExtractors?.length ?? 0) > 0 ||
          (plugin.contracts?.imageGenerationProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.videoGenerationProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.musicGenerationProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.webContentExtractors?.length ?? 0) > 0 ||
          (plugin.contracts?.webFetchProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.webSearchProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.tools?.length ?? 0) > 0),
    )
    .map((plugin) => ({
      pluginId: plugin.id,
      cliBackendIds: uniqueStrings(plugin.cliBackends),
      providerIds: uniqueStrings(plugin.providers),
      providerAuthEnvVars: normalizeProviderAuthEnvVars(plugin.providerAuthEnvVars),
      speechProviderIds: uniqueStrings(plugin.contracts?.speechProviders ?? []),
      realtimeTranscriptionProviderIds: uniqueStrings(
        plugin.contracts?.realtimeTranscriptionProviders ?? [],
      ),
      realtimeVoiceProviderIds: uniqueStrings(plugin.contracts?.realtimeVoiceProviders ?? []),
      mediaUnderstandingProviderIds: uniqueStrings(
        plugin.contracts?.mediaUnderstandingProviders ?? [],
      ),
      documentExtractorIds: uniqueStrings(plugin.contracts?.documentExtractors ?? []),
      imageGenerationProviderIds: uniqueStrings(plugin.contracts?.imageGenerationProviders ?? []),
      videoGenerationProviderIds: uniqueStrings(plugin.contracts?.videoGenerationProviders ?? []),
      musicGenerationProviderIds: uniqueStrings(plugin.contracts?.musicGenerationProviders ?? []),
      webContentExtractorIds: uniqueStrings(plugin.contracts?.webContentExtractors ?? []),
      webFetchProviderIds: uniqueStrings(plugin.contracts?.webFetchProviders ?? []),
      webSearchProviderIds: uniqueStrings(plugin.contracts?.webSearchProviders ?? []),
      toolNames: uniqueStrings(plugin.contracts?.tools ?? []),
    }));
}

function resolveBundledProviderContractPluginIdsByProviderId(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const entry of resolveBundledManifestContracts()) {
    for (const providerId of entry.providerIds) {
      const existing = result.get(providerId) ?? [];
      if (!existing.includes(entry.pluginId)) {
        existing.push(entry.pluginId);
      }
      result.set(providerId, existing);
    }
  }
  return result;
}

function resolveBundledProviderContractPluginIds(): string[] {
  return uniqueStrings(
    resolveBundledManifestContracts()
      .filter((entry) => entry.providerIds.length > 0)
      .map((entry) => entry.pluginId),
  ).toSorted((left, right) => left.localeCompare(right));
}

function resolveBundledManifestContractPluginIds(contract: ManifestRegistryContractKey): string[] {
  return resolveManifestContractPluginIds({
    contract,
    origin: "bundled",
  });
}

function resolveBundledManifestPluginIdsForContract(contract: ManifestContractKey): string[] {
  return uniqueStrings(
    resolveBundledManifestContracts()
      .filter((entry) => {
        switch (contract) {
          case "speechProviders":
            return entry.speechProviderIds.length > 0;
          case "realtimeTranscriptionProviders":
            return entry.realtimeTranscriptionProviderIds.length > 0;
          case "realtimeVoiceProviders":
            return entry.realtimeVoiceProviderIds.length > 0;
          case "mediaUnderstandingProviders":
            return entry.mediaUnderstandingProviderIds.length > 0;
          case "documentExtractors":
            return entry.documentExtractorIds.length > 0;
          case "imageGenerationProviders":
            return entry.imageGenerationProviderIds.length > 0;
          case "videoGenerationProviders":
            return entry.videoGenerationProviderIds.length > 0;
          case "musicGenerationProviders":
            return entry.musicGenerationProviderIds.length > 0;
          case "webContentExtractors":
            return entry.webContentExtractorIds.length > 0;
          case "webFetchProviders":
            return entry.webFetchProviderIds.length > 0;
          case "webSearchProviders":
            return entry.webSearchProviderIds.length > 0;
          case "tools":
            return entry.toolNames.length > 0;
        }
        throw new Error("Unsupported manifest contract key");
      })
      .map((entry) => entry.pluginId),
  ).toSorted((left, right) => left.localeCompare(right));
}

let providerContractRegistryCache: ProviderContractEntry[] | null = null;
let providerContractRegistryByPluginIdCache: Map<string, ProviderContractEntry[]> | null = null;
let webFetchProviderContractRegistryCache: WebFetchProviderContractEntry[] | null = null;
let webFetchProviderContractRegistryByPluginIdCache: Map<
  string,
  WebFetchProviderContractEntry[]
> | null = null;
let webSearchProviderContractRegistryCache: WebSearchProviderContractEntry[] | null = null;
let webSearchProviderContractRegistryByPluginIdCache: Map<
  string,
  WebSearchProviderContractEntry[]
> | null = null;
let speechProviderContractRegistryCache: SpeechProviderContractEntry[] | null = null;
let realtimeTranscriptionProviderContractRegistryCache:
  | RealtimeTranscriptionProviderContractEntry[]
  | null = null;
let realtimeVoiceProviderContractRegistryCache: RealtimeVoiceProviderContractEntry[] | null = null;
let mediaUnderstandingProviderContractRegistryCache:
  | MediaUnderstandingProviderContractEntry[]
  | null = null;
let imageGenerationProviderContractRegistryCache: ImageGenerationProviderContractEntry[] | null =
  null;
let videoGenerationProviderContractRegistryCache: VideoGenerationProviderContractEntry[] | null =
  null;
let musicGenerationProviderContractRegistryCache: MusicGenerationProviderContractEntry[] | null =
  null;

export let providerContractLoadError: Error | undefined;

function formatBundledCapabilityPluginLoadError(params: {
  pluginId: string;
  capabilityLabel: string;
  registry: BundledCapabilityRuntimeRegistry;
}): Error {
  const plugin = params.registry.plugins.find((entry) => entry.id === params.pluginId);
  const diagnostics = params.registry.diagnostics
    .filter((entry) => entry.pluginId === params.pluginId)
    .map((entry) => entry.message);
  const detailParts = plugin
    ? [
        `status=${plugin.status}`,
        ...(plugin.error ? [`error=${plugin.error}`] : []),
        `providerIds=[${plugin.providerIds.join(", ")}]`,
        `webFetchProviderIds=[${plugin.webFetchProviderIds.join(", ")}]`,
        `webSearchProviderIds=[${plugin.webSearchProviderIds.join(", ")}]`,
      ]
    : ["plugin record missing"];
  if (diagnostics.length > 0) {
    detailParts.push(`diagnostics=${diagnostics.join(" | ")}`);
  }
  return new Error(
    `bundled ${params.capabilityLabel} contract load failed for ${params.pluginId}: ${detailParts.join("; ")}`,
  );
}

function loadScopedCapabilityRuntimeRegistryEntries<T>(params: {
  pluginId: string;
  capabilityLabel: string;
  loadEntries: (registry: BundledCapabilityRuntimeRegistry) => T[];
  loadDeclaredIds: (
    plugin: BundledCapabilityRuntimeRegistry["plugins"][number],
  ) => readonly string[];
}): T[] {
  let lastFailure: Error | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: [params.pluginId],
      pluginSdkResolution: "dist",
    });
    const entries = params.loadEntries(registry);
    if (entries.length > 0) {
      return entries;
    }

    const plugin = registry.plugins.find((entry) => entry.id === params.pluginId);
    lastFailure = formatBundledCapabilityPluginLoadError({
      pluginId: params.pluginId,
      capabilityLabel: params.capabilityLabel,
      registry,
    });
    const shouldRetry =
      attempt === 0 &&
      (!plugin || plugin.status !== "loaded" || params.loadDeclaredIds(plugin).length === 0);
    if (!shouldRetry) {
      break;
    }
  }

  throw (
    lastFailure ??
    new Error(
      `bundled ${params.capabilityLabel} contract load failed for ${params.pluginId}: no entries`,
    )
  );
}

function loadProviderContractEntriesForPluginIds(
  pluginIds: readonly string[],
): ProviderContractEntry[] {
  return pluginIds.flatMap((pluginId) => loadProviderContractEntriesForPluginId(pluginId));
}

function loadProviderContractEntriesForPluginId(pluginId: string): ProviderContractEntry[] {
  if (providerContractRegistryCache) {
    return providerContractRegistryCache.filter((entry) => entry.pluginId === pluginId);
  }

  const cache =
    providerContractRegistryByPluginIdCache ?? new Map<string, ProviderContractEntry[]>();
  providerContractRegistryByPluginIdCache = cache;
  const cached = cache.get(pluginId);
  if (cached) {
    return cached;
  }

  const publicArtifactEntries = resolveBundledExplicitProviderContractsFromPublicArtifacts({
    onlyPluginIds: [pluginId],
  });
  if (publicArtifactEntries) {
    cache.set(pluginId, publicArtifactEntries);
    return publicArtifactEntries;
  }

  try {
    providerContractLoadError = undefined;
    const entries = loadScopedCapabilityRuntimeRegistryEntries({
      pluginId,
      capabilityLabel: "provider",
      loadEntries: (registry) =>
        registry.providers
          .filter((entry) => entry.pluginId === pluginId)
          .map((entry) => ({
            pluginId: entry.pluginId,
            provider: entry.provider,
          })),
      loadDeclaredIds: (plugin) => plugin.providerIds,
    }).map((entry) => ({
      pluginId: entry.pluginId,
      provider: entry.provider,
    }));
    cache.set(pluginId, entries);
    return entries;
  } catch (error) {
    providerContractLoadError = error instanceof Error ? error : new Error(String(error));
    cache.set(pluginId, []);
    return [];
  }
}

function loadProviderContractRegistry(): ProviderContractEntry[] {
  if (!providerContractRegistryCache) {
    try {
      providerContractLoadError = undefined;
      const pluginIds = resolveBundledProviderContractPluginIds();
      const publicArtifactEntries = pluginIds.flatMap(
        (pluginId) =>
          resolveBundledExplicitProviderContractsFromPublicArtifacts({
            onlyPluginIds: [pluginId],
          }) ?? [],
      );
      const coveredPluginIds = new Set(publicArtifactEntries.map((entry) => entry.pluginId));
      const remainingPluginIds = resolveBundledProviderContractPluginIds().filter(
        (pluginId) => !coveredPluginIds.has(pluginId),
      );
      const runtimeEntries =
        remainingPluginIds.length > 0
          ? loadBundledCapabilityRuntimeRegistry({
              pluginIds: remainingPluginIds,
              pluginSdkResolution: "dist",
            }).providers.map((entry) => ({
              pluginId: entry.pluginId,
              provider: entry.provider,
            }))
          : [];
      providerContractRegistryCache = [...publicArtifactEntries, ...runtimeEntries];
    } catch (error) {
      providerContractLoadError = error instanceof Error ? error : new Error(String(error));
      providerContractRegistryCache = [];
    }
  }
  return providerContractRegistryCache;
}

function loadUniqueProviderContractProviders(): ProviderPlugin[] {
  return [
    ...new Map(
      loadProviderContractRegistry().map((entry) => [entry.provider.id, entry.provider]),
    ).values(),
  ];
}

function loadProviderContractPluginIds(): string[] {
  return [...resolveBundledProviderContractPluginIds()];
}

function loadProviderContractCompatPluginIds(): string[] {
  return loadProviderContractPluginIds();
}

function resolveWebSearchCredentialValue(provider: WebSearchProviderPlugin): unknown {
  if (provider.requiresCredential === false) {
    return `${provider.id}-no-key-needed`;
  }
  const envVar = provider.envVars.find((entry) => entry.trim().length > 0);
  if (!envVar) {
    return `${provider.id}-test`;
  }
  if (envVar === "OPENROUTER_API_KEY") {
    return "openrouter-test";
  }
  return normalizeLowercaseStringOrEmpty(envVar).includes("api_key")
    ? `${provider.id}-test`
    : "sk-test";
}

function resolveWebFetchCredentialValue(provider: WebFetchProviderPlugin): unknown {
  if (provider.requiresCredential === false) {
    return `${provider.id}-no-key-needed`;
  }
  const envVar = provider.envVars.find((entry) => entry.trim().length > 0);
  if (!envVar) {
    return `${provider.id}-test`;
  }
  return normalizeLowercaseStringOrEmpty(envVar).includes("api_key")
    ? `${provider.id}-test`
    : "sk-test";
}

function loadWebFetchProviderContractRegistry(): WebFetchProviderContractEntry[] {
  if (!webFetchProviderContractRegistryCache) {
    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: resolveBundledManifestContractPluginIds("webFetchProviders"),
      pluginSdkResolution: "dist",
    });
    webFetchProviderContractRegistryCache = registry.webFetchProviders.map((entry) => ({
      pluginId: entry.pluginId,
      provider: entry.provider,
      credentialValue: resolveWebFetchCredentialValue(entry.provider),
    }));
  }
  return webFetchProviderContractRegistryCache;
}

export function resolveWebFetchProviderContractEntriesForPluginId(
  pluginId: string,
): WebFetchProviderContractEntry[] {
  if (webFetchProviderContractRegistryCache) {
    return webFetchProviderContractRegistryCache.filter((entry) => entry.pluginId === pluginId);
  }

  const cache =
    webFetchProviderContractRegistryByPluginIdCache ??
    new Map<string, WebFetchProviderContractEntry[]>();
  webFetchProviderContractRegistryByPluginIdCache = cache;
  const cached = cache.get(pluginId);
  if (cached) {
    return cached;
  }

  const entries = loadScopedCapabilityRuntimeRegistryEntries({
    pluginId,
    capabilityLabel: "web fetch provider",
    loadEntries: (registry) =>
      registry.webFetchProviders
        .filter((entry) => entry.pluginId === pluginId)
        .map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
          credentialValue: resolveWebFetchCredentialValue(entry.provider),
        })),
    loadDeclaredIds: (plugin) => plugin.webFetchProviderIds,
  });
  cache.set(pluginId, entries);
  return entries;
}

function loadWebSearchProviderContractRegistry(): WebSearchProviderContractEntry[] {
  if (!webSearchProviderContractRegistryCache) {
    const pluginIds = resolveBundledManifestContractPluginIds("webSearchProviders");
    const publicArtifactEntries = pluginIds.flatMap((pluginId) =>
      (
        resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
          onlyPluginIds: [pluginId],
        }) ?? []
      ).map((provider) => ({
        pluginId: provider.pluginId,
        provider,
        credentialValue: resolveWebSearchCredentialValue(provider),
      })),
    );
    const coveredPluginIds = new Set(publicArtifactEntries.map((entry) => entry.pluginId));
    const remainingPluginIds = resolveBundledManifestContractPluginIds("webSearchProviders").filter(
      (pluginId) => !coveredPluginIds.has(pluginId),
    );
    const runtimeEntries =
      remainingPluginIds.length > 0
        ? loadBundledCapabilityRuntimeRegistry({
            pluginIds: remainingPluginIds,
            pluginSdkResolution: "dist",
          }).webSearchProviders.map((entry) => ({
            pluginId: entry.pluginId,
            provider: entry.provider,
            credentialValue: resolveWebSearchCredentialValue(entry.provider),
          }))
        : [];
    webSearchProviderContractRegistryCache = [...publicArtifactEntries, ...runtimeEntries];
  }
  return webSearchProviderContractRegistryCache;
}

export function resolveWebSearchProviderContractEntriesForPluginId(
  pluginId: string,
): WebSearchProviderContractEntry[] {
  if (webSearchProviderContractRegistryCache) {
    return webSearchProviderContractRegistryCache.filter((entry) => entry.pluginId === pluginId);
  }

  const cache =
    webSearchProviderContractRegistryByPluginIdCache ??
    new Map<string, WebSearchProviderContractEntry[]>();
  webSearchProviderContractRegistryByPluginIdCache = cache;
  const cached = cache.get(pluginId);
  if (cached) {
    return cached;
  }

  const publicArtifactEntries = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
    onlyPluginIds: [pluginId],
  })?.map((provider) => ({
    pluginId: provider.pluginId,
    provider,
    credentialValue: resolveWebSearchCredentialValue(provider),
  }));
  if (publicArtifactEntries) {
    cache.set(pluginId, publicArtifactEntries);
    return publicArtifactEntries;
  }

  const entries = loadScopedCapabilityRuntimeRegistryEntries({
    pluginId,
    capabilityLabel: "web search provider",
    loadEntries: (registry) =>
      registry.webSearchProviders
        .filter((entry) => entry.pluginId === pluginId)
        .map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
          credentialValue: resolveWebSearchCredentialValue(entry.provider),
        })),
    loadDeclaredIds: (plugin) => plugin.webSearchProviderIds,
  });
  cache.set(pluginId, entries);
  return entries;
}

function loadSpeechProviderContractRegistry(): SpeechProviderContractEntry[] {
  if (!speechProviderContractRegistryCache) {
    speechProviderContractRegistryCache = process.env.VITEST
      ? loadVitestSpeechProviderContractRegistry()
      : loadBundledCapabilityRuntimeRegistry({
          pluginIds: resolveBundledManifestPluginIdsForContract("speechProviders"),
          pluginSdkResolution: "dist",
        }).speechProviders.map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
        }));
  }
  return speechProviderContractRegistryCache;
}

function loadRealtimeVoiceProviderContractRegistry(): RealtimeVoiceProviderContractEntry[] {
  if (!realtimeVoiceProviderContractRegistryCache) {
    realtimeVoiceProviderContractRegistryCache = process.env.VITEST
      ? loadVitestRealtimeVoiceProviderContractRegistry()
      : loadBundledCapabilityRuntimeRegistry({
          pluginIds: resolveBundledManifestPluginIdsForContract("realtimeVoiceProviders"),
          pluginSdkResolution: "dist",
        }).realtimeVoiceProviders.map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
        }));
  }
  return realtimeVoiceProviderContractRegistryCache;
}

function loadRealtimeTranscriptionProviderContractRegistry(): RealtimeTranscriptionProviderContractEntry[] {
  if (!realtimeTranscriptionProviderContractRegistryCache) {
    realtimeTranscriptionProviderContractRegistryCache = process.env.VITEST
      ? loadVitestRealtimeTranscriptionProviderContractRegistry()
      : loadBundledCapabilityRuntimeRegistry({
          pluginIds: resolveBundledManifestPluginIdsForContract("realtimeTranscriptionProviders"),
          pluginSdkResolution: "dist",
        }).realtimeTranscriptionProviders.map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
        }));
  }
  return realtimeTranscriptionProviderContractRegistryCache;
}

function loadMediaUnderstandingProviderContractRegistry(): MediaUnderstandingProviderContractEntry[] {
  if (!mediaUnderstandingProviderContractRegistryCache) {
    mediaUnderstandingProviderContractRegistryCache = process.env.VITEST
      ? loadVitestMediaUnderstandingProviderContractRegistry()
      : loadBundledCapabilityRuntimeRegistry({
          pluginIds: resolveBundledManifestPluginIdsForContract("mediaUnderstandingProviders"),
          pluginSdkResolution: "dist",
        }).mediaUnderstandingProviders.map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
        }));
  }
  return mediaUnderstandingProviderContractRegistryCache;
}

function loadImageGenerationProviderContractRegistry(): ImageGenerationProviderContractEntry[] {
  if (!imageGenerationProviderContractRegistryCache) {
    imageGenerationProviderContractRegistryCache = process.env.VITEST
      ? loadVitestImageGenerationProviderContractRegistry()
      : loadBundledCapabilityRuntimeRegistry({
          pluginIds: resolveBundledManifestPluginIdsForContract("imageGenerationProviders"),
          pluginSdkResolution: "dist",
        }).imageGenerationProviders.map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
        }));
  }
  return imageGenerationProviderContractRegistryCache;
}

function loadVideoGenerationProviderContractRegistry(): VideoGenerationProviderContractEntry[] {
  if (!videoGenerationProviderContractRegistryCache) {
    videoGenerationProviderContractRegistryCache = process.env.VITEST
      ? loadVitestVideoGenerationProviderContractRegistry()
      : loadBundledCapabilityRuntimeRegistry({
          pluginIds: resolveBundledManifestPluginIdsForContract("videoGenerationProviders"),
          pluginSdkResolution: "dist",
        }).videoGenerationProviders.map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
        }));
  }
  return videoGenerationProviderContractRegistryCache;
}

function loadMusicGenerationProviderContractRegistry(): MusicGenerationProviderContractEntry[] {
  if (!musicGenerationProviderContractRegistryCache) {
    musicGenerationProviderContractRegistryCache = process.env.VITEST
      ? loadVitestMusicGenerationProviderContractRegistry()
      : loadBundledCapabilityRuntimeRegistry({
          pluginIds: resolveBundledManifestPluginIdsForContract("musicGenerationProviders"),
          pluginSdkResolution: "dist",
        }).musicGenerationProviders.map((entry) => ({
          pluginId: entry.pluginId,
          provider: entry.provider,
        }));
  }
  return musicGenerationProviderContractRegistryCache;
}

function createLazyArrayView<T>(load: () => T[]): T[] {
  return new Proxy([] as T[], {
    get(_target, prop) {
      const actual = load();
      const value = Reflect.get(actual, prop, actual);
      return typeof value === "function" ? value.bind(actual) : value;
    },
    has(_target, prop) {
      return Reflect.has(load(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(load());
    },
    getOwnPropertyDescriptor(_target, prop) {
      const actual = load();
      const descriptor = Reflect.getOwnPropertyDescriptor(actual, prop);
      if (descriptor) {
        return descriptor;
      }
      if (Reflect.has(actual, prop)) {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: Reflect.get(actual, prop, actual),
        };
      }
      return undefined;
    },
  });
}

export const providerContractRegistry: ProviderContractEntry[] = createLazyArrayView(
  loadProviderContractRegistry,
);
export const uniqueProviderContractProviders: ProviderPlugin[] = createLazyArrayView(
  loadUniqueProviderContractProviders,
);
export const providerContractPluginIds: string[] = createLazyArrayView(
  loadProviderContractPluginIds,
);
export const providerContractCompatPluginIds: string[] = createLazyArrayView(
  loadProviderContractCompatPluginIds,
);

export function requireProviderContractProvider(providerId: string): ProviderPlugin {
  const pluginIds = resolveBundledProviderContractPluginIdsByProviderId().get(providerId) ?? [];
  const entries = loadProviderContractEntriesForPluginIds(pluginIds);
  const provider = entries.find((entry) => entry.provider.id === providerId)?.provider;
  if (!provider) {
    const pluginScopedProviders = [
      ...new Map(entries.map((entry) => [entry.provider.id, entry.provider])).values(),
    ];
    if (pluginIds.length === 1 && pluginScopedProviders.length === 1) {
      return pluginScopedProviders[0];
    }
    if (providerContractLoadError) {
      throw new Error(
        `provider contract entry missing for ${providerId}; bundled provider registry failed to load: ${providerContractLoadError.message}`,
      );
    }
    throw new Error(`provider contract entry missing for ${providerId}`);
  }
  return provider;
}

export function resolveProviderContractPluginIdsForProvider(
  providerId: string,
): string[] | undefined {
  const pluginIds = resolveBundledProviderContractPluginIdsByProviderId().get(providerId) ?? [];
  return pluginIds.length > 0 ? pluginIds : undefined;
}

export function resolveProviderContractPluginIdsForProviderAlias(
  providerId: string,
): string[] | undefined {
  const normalizedProvider = normalizeProviderId(providerId);
  if (!normalizedProvider) {
    return undefined;
  }
  const pluginIds = uniqueStrings(
    loadProviderContractEntriesForPluginIds(resolveBundledProviderContractPluginIds())
      .filter((entry) => {
        const providerIds = [
          entry.provider.id,
          ...(entry.provider.aliases ?? []),
          ...(entry.provider.hookAliases ?? []),
        ];
        return providerIds.some(
          (candidate) => normalizeProviderId(candidate) === normalizedProvider,
        );
      })
      .map((entry) => entry.pluginId),
  ).toSorted((left, right) => left.localeCompare(right));
  return pluginIds.length > 0 ? pluginIds : undefined;
}

export function resolveProviderContractProvidersForPluginIds(
  pluginIds: readonly string[],
): ProviderPlugin[] {
  const allowed = new Set(pluginIds);
  return [
    ...new Map(
      loadProviderContractEntriesForPluginIds([...allowed])
        .filter((entry) => allowed.has(entry.pluginId))
        .map((entry) => [entry.provider.id, entry.provider]),
    ).values(),
  ];
}

export const webSearchProviderContractRegistry: WebSearchProviderContractEntry[] =
  createLazyArrayView(loadWebSearchProviderContractRegistry);
export const webFetchProviderContractRegistry: WebFetchProviderContractEntry[] =
  createLazyArrayView(loadWebFetchProviderContractRegistry);
export const speechProviderContractRegistry: SpeechProviderContractEntry[] = createLazyArrayView(
  loadSpeechProviderContractRegistry,
);
export const realtimeTranscriptionProviderContractRegistry: RealtimeTranscriptionProviderContractEntry[] =
  createLazyArrayView(loadRealtimeTranscriptionProviderContractRegistry);
export const realtimeVoiceProviderContractRegistry: RealtimeVoiceProviderContractEntry[] =
  createLazyArrayView(loadRealtimeVoiceProviderContractRegistry);
export const mediaUnderstandingProviderContractRegistry: MediaUnderstandingProviderContractEntry[] =
  createLazyArrayView(loadMediaUnderstandingProviderContractRegistry);
export const imageGenerationProviderContractRegistry: ImageGenerationProviderContractEntry[] =
  createLazyArrayView(loadImageGenerationProviderContractRegistry);
export const videoGenerationProviderContractRegistry: VideoGenerationProviderContractEntry[] =
  createLazyArrayView(loadVideoGenerationProviderContractRegistry);
export const musicGenerationProviderContractRegistry: MusicGenerationProviderContractEntry[] =
  createLazyArrayView(loadMusicGenerationProviderContractRegistry);

function loadPluginRegistrationContractRegistry(): PluginRegistrationContractEntry[] {
  return resolveBundledManifestContracts();
}

export const pluginRegistrationContractRegistry: PluginRegistrationContractEntry[] =
  createLazyArrayView(loadPluginRegistrationContractRegistry);
