// Plugin contract registry assembles bundled plugin fixtures for shared contract tests.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { loadBundledCapabilityRuntimeRegistry } from "../bundled-capability-runtime.js";
import { discoverOpenClawPlugins } from "../discovery.js";
import { loadPluginManifestRegistryCore } from "../manifest-registry.js";
import { resolveBundledExplicitProviderContractsFromPublicArtifacts } from "../provider-contract-public-artifacts.js";
import type { ProviderPlugin, WebFetchProviderPlugin, WebSearchProviderPlugin } from "../types.js";
import { resolveBundledExplicitWebSearchProvidersFromPublicArtifacts } from "../web-provider-public-artifacts.explicit.js";
import {
  BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS,
  type BundledPluginContractSnapshot,
} from "./inventory/bundled-capability-metadata.js";
import { normalizeContractStringValues } from "./shared.js";

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

type PluginRegistrationContractEntry = BundledPluginContractSnapshot;

function normalizeProviderEnvVars(
  providerEnvVars: Record<string, string[]> | undefined,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(providerEnvVars ?? {}).map(([providerId, envVars]) => [
      providerId,
      normalizeContractStringValues(envVars),
    ]),
  );
}

function resolvePluginProviderEnvVars(plugin: {
  setup?: { providers?: Array<{ id: string; envVars?: string[] }> };
}): Record<string, string[]> {
  const envVars: Record<string, string[]> = {};
  for (const provider of plugin.setup?.providers ?? []) {
    envVars[provider.id] = normalizeContractStringValues(provider.envVars ?? []);
  }
  return normalizeProviderEnvVars(envVars);
}

function resolveBundledManifestContracts(): PluginRegistrationContractEntry[] {
  if (process.env.VITEST) {
    return BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.map((entry) => ({
      pluginId: entry.pluginId,
      cliBackendIds: [...entry.cliBackendIds],
      providerIds: [...entry.providerIds],
      providerEnvVars: normalizeProviderEnvVars(entry.providerEnvVars),
      workerProviderIds: [...entry.workerProviderIds],
      embeddingProviderIds: [...entry.embeddingProviderIds],
      speechProviderIds: [...entry.speechProviderIds],
      realtimeTranscriptionProviderIds: [...entry.realtimeTranscriptionProviderIds],
      realtimeVoiceProviderIds: [...entry.realtimeVoiceProviderIds],
      mediaUnderstandingProviderIds: [...entry.mediaUnderstandingProviderIds],
      transcriptSourceProviderIds: [...entry.transcriptSourceProviderIds],
      documentExtractorIds: [...entry.documentExtractorIds],
      imageGenerationProviderIds: [...entry.imageGenerationProviderIds],
      videoGenerationProviderIds: [...entry.videoGenerationProviderIds],
      musicGenerationProviderIds: [...entry.musicGenerationProviderIds],
      webContentExtractorIds: [...entry.webContentExtractorIds],
      webFetchProviderIds: [...entry.webFetchProviderIds],
      webSearchProviderIds: [...entry.webSearchProviderIds],
      migrationProviderIds: [...entry.migrationProviderIds],
      toolNames: [...entry.toolNames],
    }));
  }
  return loadPluginManifestRegistryCore({})
    .plugins.filter(
      (plugin) =>
        plugin.origin === "bundled" &&
        (plugin.cliBackends.length > 0 ||
          plugin.providers.length > 0 ||
          (plugin.contracts?.workerProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.embeddingProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.speechProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.realtimeTranscriptionProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.realtimeVoiceProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.mediaUnderstandingProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.transcriptSourceProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.documentExtractors?.length ?? 0) > 0 ||
          (plugin.contracts?.imageGenerationProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.videoGenerationProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.musicGenerationProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.webContentExtractors?.length ?? 0) > 0 ||
          (plugin.contracts?.webFetchProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.webSearchProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.migrationProviders?.length ?? 0) > 0 ||
          (plugin.contracts?.tools?.length ?? 0) > 0),
    )
    .map((plugin) => ({
      pluginId: plugin.id,
      cliBackendIds: normalizeContractStringValues(plugin.cliBackends),
      providerIds: normalizeContractStringValues(plugin.providers),
      providerEnvVars: resolvePluginProviderEnvVars(plugin),
      workerProviderIds: normalizeContractStringValues(plugin.contracts?.workerProviders ?? []),
      embeddingProviderIds: normalizeContractStringValues(
        plugin.contracts?.embeddingProviders ?? [],
      ),
      speechProviderIds: normalizeContractStringValues(plugin.contracts?.speechProviders ?? []),
      realtimeTranscriptionProviderIds: normalizeContractStringValues(
        plugin.contracts?.realtimeTranscriptionProviders ?? [],
      ),
      realtimeVoiceProviderIds: normalizeContractStringValues(
        plugin.contracts?.realtimeVoiceProviders ?? [],
      ),
      mediaUnderstandingProviderIds: normalizeContractStringValues(
        plugin.contracts?.mediaUnderstandingProviders ?? [],
      ),
      transcriptSourceProviderIds: normalizeContractStringValues(
        plugin.contracts?.transcriptSourceProviders ?? [],
      ),
      documentExtractorIds: normalizeContractStringValues(
        plugin.contracts?.documentExtractors ?? [],
      ),
      imageGenerationProviderIds: normalizeContractStringValues(
        plugin.contracts?.imageGenerationProviders ?? [],
      ),
      videoGenerationProviderIds: normalizeContractStringValues(
        plugin.contracts?.videoGenerationProviders ?? [],
      ),
      musicGenerationProviderIds: normalizeContractStringValues(
        plugin.contracts?.musicGenerationProviders ?? [],
      ),
      webContentExtractorIds: normalizeContractStringValues(
        plugin.contracts?.webContentExtractors ?? [],
      ),
      webFetchProviderIds: normalizeContractStringValues(plugin.contracts?.webFetchProviders ?? []),
      webSearchProviderIds: normalizeContractStringValues(
        plugin.contracts?.webSearchProviders ?? [],
      ),
      migrationProviderIds: normalizeContractStringValues(
        plugin.contracts?.migrationProviders ?? [],
      ),
      toolNames: normalizeContractStringValues(plugin.contracts?.tools ?? []),
    }));
}

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
  const providerIds = params.registry.providers
    .filter((entry) => entry.pluginId === params.pluginId)
    .map((entry) => entry.provider.id);
  const webFetchProviderIds = params.registry.webFetchProviders
    .filter((entry) => entry.pluginId === params.pluginId)
    .map((entry) => entry.provider.id);
  const webSearchProviderIds = params.registry.webSearchProviders
    .filter((entry) => entry.pluginId === params.pluginId)
    .map((entry) => entry.provider.id);
  const detailParts = plugin
    ? [
        `status=${plugin.status}`,
        ...(plugin.error ? [`error=${plugin.error}`] : []),
        `providerIds=[${providerIds.join(", ")}]`,
        `webFetchProviderIds=[${webFetchProviderIds.join(", ")}]`,
        `webSearchProviderIds=[${webSearchProviderIds.join(", ")}]`,
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
}): T[] {
  const discovery = discoverOpenClawPlugins({});
  let lastFailure: Error | undefined;

  // Manifest IDs exist before registration; only observed runtime entries prove the load worked.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: [params.pluginId],
      pluginSdkResolution: "dist",
      discovery,
    });
    const entries = params.loadEntries(registry);
    if (entries.length > 0) {
      return entries;
    }

    lastFailure = formatBundledCapabilityPluginLoadError({
      pluginId: params.pluginId,
      capabilityLabel: params.capabilityLabel,
      registry,
    });
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
  const publicArtifactEntries = resolveBundledExplicitProviderContractsFromPublicArtifacts({
    onlyPluginIds: [pluginId],
  });
  if (publicArtifactEntries) {
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
    }).map((entry) => ({
      pluginId: entry.pluginId,
      provider: entry.provider,
    }));
    return entries;
  } catch (error) {
    providerContractLoadError = error instanceof Error ? error : new Error(String(error));
    return [];
  }
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

export function resolveWebFetchProviderContractEntriesForPluginId(
  pluginId: string,
): WebFetchProviderContractEntry[] {
  return loadScopedCapabilityRuntimeRegistryEntries({
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
  });
}

export function resolveWebSearchProviderContractEntriesForPluginId(
  pluginId: string,
): WebSearchProviderContractEntry[] {
  const publicArtifactEntries = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
    onlyPluginIds: [pluginId],
  })?.map((provider) => ({
    pluginId: provider.pluginId,
    provider,
    credentialValue: resolveWebSearchCredentialValue(provider),
  }));
  if (publicArtifactEntries) {
    return publicArtifactEntries;
  }

  return loadScopedCapabilityRuntimeRegistryEntries({
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
  });
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
function loadPluginRegistrationContractRegistry(): PluginRegistrationContractEntry[] {
  return resolveBundledManifestContracts();
}

export const pluginRegistrationContractRegistry: PluginRegistrationContractEntry[] =
  createLazyArrayView(loadPluginRegistrationContractRegistry);
