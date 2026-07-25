// Collects configured model, generation, voice, and memory provider ownership.
import {
  buildModelCatalogMergeKey,
  parseModelCatalogRef,
} from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { planManifestModelCatalogRows } from "../model-catalog/manifest-planner.js";
import { resolveConfiguredGenericEmbeddingProviderId } from "./embedding-provider-config.js";
import { listRegisteredEmbeddingProviders } from "./embedding-providers.js";
import type {
  ConfiguredGenerationProviderIds,
  ConfiguredVoiceProviderIds,
} from "./gateway-startup-plugin-contracts.js";
import { normalizeConfiguredSpeechProviderIdForStartup } from "./gateway-startup-speech-providers.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { CORE_BUILT_IN_MODEL_APIS } from "./provider-config-owner.js";
import type { PluginRegistry } from "./registry-types.js";

export function manifestOwnsConfiguredSpeechProvider(params: {
  manifest: PluginManifestRecord | undefined;
  configuredSpeechProviderIds: ReadonlySet<string>;
}): boolean {
  if (params.configuredSpeechProviderIds.size === 0) {
    return false;
  }
  return (params.manifest?.contracts?.speechProviders ?? []).some((providerId) => {
    const normalized = normalizeConfiguredSpeechProviderIdForStartup(providerId);
    return normalized ? params.configuredSpeechProviderIds.has(normalized) : false;
  });
}

export function collectConfiguredWebSearchProviderIds(config: OpenClawConfig): ReadonlySet<string> {
  const search = config.tools?.web?.search;
  if (search?.enabled === false || typeof search?.provider !== "string") {
    return new Set();
  }
  const providerId = normalizeOptionalLowercaseString(search.provider);
  return providerId ? new Set([providerId]) : new Set();
}

export function manifestOwnsConfiguredWebSearchProvider(params: {
  manifest: PluginManifestRecord | undefined;
  configuredWebSearchProviderIds: ReadonlySet<string>;
}): boolean {
  if (params.configuredWebSearchProviderIds.size === 0) {
    return false;
  }
  return (params.manifest?.contracts?.webSearchProviders ?? []).some((providerId) => {
    const normalized = normalizeOptionalLowercaseString(providerId);
    return normalized ? params.configuredWebSearchProviderIds.has(normalized) : false;
  });
}

function listModelProviderRefs(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!isRecord(value)) {
    return [];
  }
  const refs: string[] = [];
  if (typeof value.primary === "string") {
    refs.push(value.primary);
  }
  if (Array.isArray(value.fallbacks)) {
    for (const fallback of value.fallbacks) {
      if (typeof fallback === "string") {
        refs.push(fallback);
      }
    }
  }
  return refs;
}

function listModelProviderRefParts(value: unknown): Array<{ providerId: string; modelId: string }> {
  return listModelProviderRefs(value)
    .map(parseModelCatalogRef)
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .map(({ provider, modelId }) => ({ providerId: provider, modelId }));
}

function collectModelProviderIds(value: unknown): ReadonlySet<string> {
  return new Set(
    listModelProviderRefs(value)
      .map((ref) => {
        const slashIndex = ref.indexOf("/");
        return slashIndex > 0 ? normalizeProviderId(ref.slice(0, slashIndex)) : "";
      })
      .filter((providerId): providerId is string => Boolean(providerId)),
  );
}

type ManifestModelProviderLookup = {
  modelApis: ReadonlyMap<string, string>;
  providerIds: ReadonlySet<string>;
};

function buildManifestModelProviderLookup(
  manifestRegistry: PluginManifestRegistry,
): ManifestModelProviderLookup {
  const modelApis = new Map(
    planManifestModelCatalogRows({ registry: manifestRegistry }).rows.flatMap((row) =>
      row.api ? [[row.mergeKey, row.api] as const] : [],
    ),
  );
  return {
    modelApis,
    providerIds: new Set(
      manifestRegistry.plugins.flatMap((plugin) => plugin.providers.map(normalizeProviderId)),
    ),
  };
}

export function collectConfiguredAgentModelProviderIds(
  config: OpenClawConfig,
  manifestRegistry: PluginManifestRegistry,
): ReadonlySet<string> {
  const modelIdsByProvider = new Map<string, Set<string>>();
  const manifestModelProviders = buildManifestModelProviderLookup(manifestRegistry);
  const addModelProviderRefs = (value: unknown) => {
    for (const { providerId, modelId } of listModelProviderRefParts(value)) {
      const modelIds = modelIdsByProvider.get(providerId) ?? new Set<string>();
      modelIds.add(modelId);
      modelIdsByProvider.set(providerId, modelIds);
    }
  };
  const addModelMapProviderIds = (models: unknown) => {
    if (!isRecord(models)) {
      return;
    }
    for (const modelRef of Object.keys(models)) {
      addModelProviderRefs(modelRef);
    }
  };

  const defaults = config.agents?.defaults;
  addModelProviderRefs(defaults?.model);
  addModelProviderRefs(defaults?.utilityModel);
  addModelMapProviderIds(defaults?.models);

  const agents = Array.isArray(config.agents?.list) ? config.agents.list : [];
  for (const agent of agents) {
    if (!isRecord(agent)) {
      continue;
    }
    addModelProviderRefs(agent.model);
    addModelProviderRefs(agent.utilityModel);
    addModelMapProviderIds(agent.models);
  }

  return new Set(
    [...modelIdsByProvider.entries()]
      .filter(([providerId, modelIds]) => {
        return [...modelIds].some((modelId) =>
          configuredModelProviderNeedsRuntimePlugin({
            config,
            manifestModelProviders,
            providerId,
            modelId,
          }),
        );
      })
      .map(([providerId]) => providerId),
  );
}

function configuredModelProviderNeedsRuntimePlugin(params: {
  config: OpenClawConfig;
  manifestModelProviders: ManifestModelProviderLookup;
  providerId: string;
  modelId: string;
}): boolean {
  const providerConfig = params.config.models?.providers?.[params.providerId];
  const configuredModel = providerConfig?.models?.find((model) => model.id === params.modelId);
  const modelApi =
    configuredModel?.api ??
    providerConfig?.api ??
    params.manifestModelProviders.modelApis.get(
      buildModelCatalogMergeKey(params.providerId, params.modelId),
    );
  if (typeof modelApi === "string") {
    return !CORE_BUILT_IN_MODEL_APIS.has(modelApi);
  }
  return params.manifestModelProviders.providerIds.has(params.providerId);
}

export function manifestOwnsConfiguredModelProvider(params: {
  manifest: PluginManifestRecord | undefined;
  configuredModelProviderIds: ReadonlySet<string>;
}): boolean {
  if (params.configuredModelProviderIds.size === 0) {
    return false;
  }
  return (params.manifest?.providers ?? []).some((providerId) => {
    return params.configuredModelProviderIds.has(normalizeProviderId(providerId));
  });
}

export function collectConfiguredGenerationProviderIds(
  config: OpenClawConfig,
): ConfiguredGenerationProviderIds {
  const defaults = config.agents?.defaults;
  return {
    imageGenerationProviders: collectModelProviderIds(defaults?.mediaModels?.image),
    videoGenerationProviders: collectModelProviderIds(defaults?.mediaModels?.video),
    musicGenerationProviders: collectModelProviderIds(defaults?.mediaModels?.music),
  };
}

export function collectConfiguredVoiceProviderIds(
  config: OpenClawConfig,
): ConfiguredVoiceProviderIds {
  const providerIds = collectModelProviderIds(config.agents?.defaults?.voiceModel);
  return {
    speechProviders: providerIds,
    realtimeTranscriptionProviders: providerIds,
    realtimeVoiceProviders: providerIds,
  };
}

// Explicit memory provider startup pulls plugin-owned providers into Gateway
// boot. Missing/"auto" stays lazy, and "none" disables provider-backed embeddings.
const MEMORY_EMBEDDING_PROVIDER_STARTUP_SKIP_IDS: ReadonlySet<string> = new Set(["auto", "none"]);

function normalizeMemoryEmbeddingProviderIdValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized || undefined;
}

function normalizeExplicitMemoryEmbeddingProviderId(value: unknown): string | undefined {
  const normalized = normalizeMemoryEmbeddingProviderIdValue(value);
  return normalized && !MEMORY_EMBEDDING_PROVIDER_STARTUP_SKIP_IDS.has(normalized)
    ? normalized
    : undefined;
}

function readMemorySearchEnabled(
  memorySearch: Record<string, unknown> | undefined,
): boolean | undefined {
  const enabled = memorySearch?.enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
}

function isMemorySlotExplicitlyDisabled(config: OpenClawConfig): boolean {
  return normalizeOptionalLowercaseString(config.plugins?.slots?.memory) === "none";
}

type MemoryEmbeddingStartupProviderSource = "provider" | "fallback";

type ConfiguredMemoryEmbeddingStartupProviderOwner = {
  /** Raw memory-search provider id as configured (normalized). */
  configuredId: string;
  /**
   * Adapter ids a plugin can own for this provider: the configured id plus its
   * `models.providers.<id>.api` owner when a custom provider maps to one.
   */
  ownerIds: ReadonlySet<string>;
  source: MemoryEmbeddingStartupProviderSource;
};

/**
 * Resolve a configured memory embedding provider id to the adapter id(s) a
 * plugin manifest contract or runtime registry can own. Mirrors runtime
 * `getConfiguredMemoryEmbeddingProvider`: the raw id maps to a direct adapter,
 * and a custom `models.providers.<id>` entry additionally maps to its `api`
 * owner adapter (`provider: "ollama-5080"` with `api: "ollama"` -> "ollama").
 * Both candidates are returned so matching covers the direct adapter and the
 * API owner without the runtime adapter registry.
 */
function resolveMemoryEmbeddingProviderOwnerIds(
  providerId: string,
  config: OpenClawConfig,
): string[] {
  const ownerIds = [providerId];
  const genericOwnerId = normalizeOptionalLowercaseString(
    resolveConfiguredGenericEmbeddingProviderId(providerId, config),
  );
  if (genericOwnerId && genericOwnerId !== providerId) {
    ownerIds.push(genericOwnerId);
  }
  const ownerApi = normalizeOptionalLowercaseString(
    findNormalizedProviderValue(config.models?.providers, providerId)?.api,
  );
  if (ownerApi && ownerApi !== providerId) {
    ownerIds.push(ownerApi);
  }
  return ownerIds;
}

function resolveEffectiveMemoryEmbeddingProviderEntries(
  defaults: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Array<{
  configuredId: string;
  source: MemoryEmbeddingStartupProviderSource;
}> {
  const enabled = readMemorySearchEnabled(override) ?? readMemorySearchEnabled(defaults) ?? true;
  if (!enabled) {
    return [];
  }
  const rawProvider = normalizeMemoryEmbeddingProviderIdValue(
    override?.provider ?? defaults?.provider,
  );
  const effectiveProvider = rawProvider === "auto" || !rawProvider ? "openai" : rawProvider;
  if (effectiveProvider === "none") {
    return [];
  }
  const entries: Array<{
    configuredId: string;
    source: MemoryEmbeddingStartupProviderSource;
  }> = [];
  const provider =
    rawProvider && !MEMORY_EMBEDDING_PROVIDER_STARTUP_SKIP_IDS.has(rawProvider)
      ? rawProvider
      : undefined;
  if (provider) {
    entries.push({ configuredId: provider, source: "provider" });
  }
  const fallback = normalizeExplicitMemoryEmbeddingProviderId(
    override?.fallback ?? defaults?.fallback ?? "none",
  );
  if (fallback && fallback !== effectiveProvider) {
    entries.push({ configuredId: fallback, source: "fallback" });
  }
  return entries;
}

/**
 * Collect explicit memory embedding provider owners required by startup. The
 * resolver mirrors runtime memory-search inheritance for enablement, primary
 * provider, and fallback provider, then maps custom `models.providers` ids to
 * their API-owner adapter ids.
 */
export function collectConfiguredMemoryEmbeddingStartupProviderOwners(
  config: OpenClawConfig,
): ConfiguredMemoryEmbeddingStartupProviderOwner[] {
  if (isMemorySlotExplicitlyDisabled(config)) {
    return [];
  }
  const byConfiguredIdAndSource = new Map<string, ConfiguredMemoryEmbeddingStartupProviderOwner>();
  const defaultsBlock = config.memory?.search;
  const defaults = isRecord(defaultsBlock) ? defaultsBlock : undefined;
  const addEffectiveProviders = (override: Record<string, unknown> | undefined) => {
    for (const { configuredId, source } of resolveEffectiveMemoryEmbeddingProviderEntries(
      defaults,
      override,
    )) {
      const key = `${source}\0${configuredId}`;
      if (byConfiguredIdAndSource.has(key)) {
        continue;
      }
      byConfiguredIdAndSource.set(key, {
        configuredId,
        ownerIds: new Set(resolveMemoryEmbeddingProviderOwnerIds(configuredId, config)),
        source,
      });
    }
  };
  addEffectiveProviders(undefined);
  const agents = config.agents?.list;
  const agentEntries = Array.isArray(agents) ? agents.filter(isRecord) : [];
  if (agentEntries.length === 0) {
    return [...byConfiguredIdAndSource.values()];
  }
  for (const agent of agentEntries) {
    const memory = isRecord(agent.memory) ? agent.memory : undefined;
    addEffectiveProviders(isRecord(memory?.search) ? memory.search : undefined);
  }
  return [...byConfiguredIdAndSource.values()];
}

/**
 * Collect configured memory embedding provider ids that map to a plugin-owned
 * memory embedding provider contract, including the resolved `api` owner for
 * custom `models.providers` ids so the owning plugin loads at startup.
 */
export function collectConfiguredMemoryEmbeddingProviderIds(
  config: OpenClawConfig,
): ReadonlySet<string> {
  const providerIds = new Set<string>();
  for (const provider of collectConfiguredMemoryEmbeddingStartupProviderOwners(config)) {
    for (const ownerId of provider.ownerIds) {
      providerIds.add(ownerId);
    }
  }
  return providerIds;
}

/**
 * Report configured memory embedding providers that no loaded plugin can serve.
 * A provider is unregistered only when none of its resolved adapter ids (the
 * configured id and its `models.providers.<id>.api` owner) was registered, so
 * custom providers warn when their API-owner plugin is missing but stay quiet
 * once that plugin loads.
 */
export function collectUnregisteredConfiguredMemoryEmbeddingProviders(params: {
  config: OpenClawConfig;
  registeredProviderIds: ReadonlySet<string>;
}): Array<{ configuredId: string; source: MemoryEmbeddingStartupProviderSource }> {
  const configured = collectConfiguredMemoryEmbeddingStartupProviderOwners(params.config);
  if (configured.length === 0) {
    return [];
  }
  const registered = new Set(
    [...params.registeredProviderIds]
      .map((id) => normalizeOptionalLowercaseString(id))
      .filter((id): id is string => Boolean(id)),
  );
  return configured
    .filter((provider) => ![...provider.ownerIds].some((ownerId) => registered.has(ownerId)))
    .map((provider) => ({ configuredId: provider.configuredId, source: provider.source }))
    .toSorted(
      (left, right) =>
        left.configuredId.localeCompare(right.configuredId) ||
        left.source.localeCompare(right.source),
    );
}

// Registered embedding provider ids the loaded runtime can actually serve: the live
// registry's memory + general embedding providers plus the global/core embedding
// registry. Shared by gateway boot (the startup "configured but unregistered" warning)
// and the `/status plugins` drift line so both agree on what counts as "registered" and
// never diverge. The `{ provider: entry.adapter }` wrap makes the core registry entries
// match the registration shape so the id projection stays uniform across all three sources.
export function collectRegisteredEmbeddingProviderIds(
  registry: Partial<Pick<PluginRegistry, "embeddingProviders" | "memoryEmbeddingProviders">>,
): Set<string> {
  return new Set(
    [
      ...(registry.memoryEmbeddingProviders ?? []),
      ...(registry.embeddingProviders ?? []),
      ...listRegisteredEmbeddingProviders().map((entry) => ({ provider: entry.adapter })),
    ].map((entry) => entry.provider.id),
  );
}
