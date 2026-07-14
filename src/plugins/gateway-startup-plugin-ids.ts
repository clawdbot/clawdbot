/** Resolves plugin ids that should load during Gateway startup. */
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
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
import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import {
  listExplicitlyDisabledChannelIdsForConfig,
  listPotentialConfiguredChannelIds,
} from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_MEMORY_DREAMING_PLUGIN_ID,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingPluginId,
} from "../memory-host-sdk/dreaming.js";
import { planManifestModelCatalogRows } from "../model-catalog/manifest-planner.js";
import { hasExplicitChannelConfig } from "./channel-presence-policy.js";
import { collectPluginConfigContractMatches } from "./config-contracts.js";
import { normalizePluginsConfigWithResolver } from "./config-normalization-shared.js";
import { resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import { resolveConfiguredGenericEmbeddingProviderId } from "./embedding-provider-config.js";
import { listRegisteredEmbeddingProviders } from "./embedding-providers.js";
import {
  collectConfiguredSpeechProviderIds,
  normalizeConfiguredSpeechProviderIdForStartup,
} from "./gateway-startup-speech-providers.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import {
  createInstalledPluginIndexScopeLookup,
  type InstalledPluginIndexScopeLookup,
} from "./installed-plugin-index-scope-lookup.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import {
  isPluginMetadataSnapshotCompatible,
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshotPluginIdScope } from "./plugin-metadata-snapshot.types.js";
import {
  createPluginRegistryIdNormalizer,
  normalizePluginsConfigWithRegistry,
} from "./plugin-registry-contributions.js";
import type { PluginRegistrySnapshot } from "./plugin-registry-snapshot.js";
import { normalizePluginIdScope } from "./plugin-scope.js";
import { CORE_BUILT_IN_MODEL_APIS } from "./provider-config-owner.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  collectConfiguredWorkerProviderIds,
  manifestOwnsWorkerProvider,
  normalizeWorkerProviderIds,
} from "./worker-provider-registry.js";

export type GatewayStartupPluginPlan = {
  channelPluginIds: readonly string[];
  configuredDeferredChannelPluginIds: readonly string[];
  pluginIds: readonly string[];
};

type NormalizedPluginsConfig = ReturnType<typeof normalizePluginsConfigWithRegistry>;
type GenerationProviderContractKey =
  | "imageGenerationProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders";
type VoiceProviderContractKey =
  | "speechProviders"
  | "realtimeTranscriptionProviders"
  | "realtimeVoiceProviders";
type ConfiguredGenerationProviderIds = Record<GenerationProviderContractKey, ReadonlySet<string>>;
type ConfiguredVoiceProviderIds = Record<VoiceProviderContractKey, ReadonlySet<string>>;

function sortUniquePluginIds(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].toSorted(
    (left, right) => left.localeCompare(right),
  );
}

function normalizePluginsConfigForInstalledIndex(
  config: OpenClawConfig["plugins"] | undefined,
  lookup: InstalledPluginIndexScopeLookup,
) {
  return normalizePluginsConfigWithResolver(config, lookup.normalizePluginId);
}

function isConfigActivationValueEnabled(value: unknown): boolean {
  if (value === false) {
    return false;
  }
  if (isRecord(value) && value.enabled === false) {
    return false;
  }
  return true;
}

function listPotentialEnabledChannelIds(config: OpenClawConfig, env: NodeJS.ProcessEnv): string[] {
  const disabled = new Set(listExplicitlyDisabledChannelIdsForConfig(config));
  return listPotentialConfiguredChannelIds(config, env, { includePersistedAuthState: false })
    .map((id) => normalizeOptionalLowercaseString(id) ?? "")
    .filter((id) => id && !disabled.has(id));
}

function isGatewayStartupMemoryPlugin(plugin: InstalledPluginIndexRecord): boolean {
  return plugin.startup.memory;
}

function resolveGatewayStartupDreamingEngineId(config: OpenClawConfig): string | undefined {
  const dreamingConfig = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(config),
    cfg: config,
  });
  if (!dreamingConfig.enabled) {
    return undefined;
  }
  if (!resolveGatewayStartupDreamingSelectedPluginId(config)) {
    return undefined;
  }
  return DEFAULT_MEMORY_DREAMING_PLUGIN_ID;
}

function resolveGatewayStartupDreamingSelectedPluginId(config: OpenClawConfig): string | undefined {
  const selectedPluginId = normalizeOptionalLowercaseString(resolveMemoryDreamingPluginId(config));
  return selectedPluginId && selectedPluginId !== DEFAULT_MEMORY_DREAMING_PLUGIN_ID
    ? selectedPluginId
    : undefined;
}

function blocksPluginStartup(params: {
  pluginId: string;
  pluginsConfig: NormalizedPluginsConfig;
  activationSourcePlugins: NormalizedPluginsConfig;
}): boolean {
  return (
    params.pluginsConfig.deny.includes(params.pluginId) ||
    params.activationSourcePlugins.deny.includes(params.pluginId) ||
    params.pluginsConfig.entries[params.pluginId]?.enabled === false ||
    params.activationSourcePlugins.entries[params.pluginId]?.enabled === false
  );
}

function resolveAuthorizedGatewayStartupDreamingPluginIds(params: {
  config: OpenClawConfig;
  pluginsConfig: NormalizedPluginsConfig;
  activationSource: {
    plugins: NormalizedPluginsConfig;
    rootConfig?: OpenClawConfig;
  };
  activationSourcePlugins: NormalizedPluginsConfig;
  selectedMemoryPluginId?: string;
  index: { plugins: readonly InstalledPluginIndexRecord[] };
  platform?: NodeJS.Platform;
}): Set<string> {
  const engineId = resolveGatewayStartupDreamingEngineId(params.config);
  const dreamingSelectedPluginId = resolveGatewayStartupDreamingSelectedPluginId(params.config);
  if (!engineId || !params.pluginsConfig.enabled || !params.activationSourcePlugins.enabled) {
    return new Set();
  }
  if (
    !params.selectedMemoryPluginId ||
    params.selectedMemoryPluginId !== dreamingSelectedPluginId ||
    params.selectedMemoryPluginId === engineId ||
    blocksPluginStartup({
      pluginId: engineId,
      pluginsConfig: params.pluginsConfig,
      activationSourcePlugins: params.activationSourcePlugins,
    })
  ) {
    return new Set();
  }
  const selectedPlugin = params.index.plugins.find(
    (plugin) => plugin.pluginId === params.selectedMemoryPluginId,
  );
  const sidecarPlugin = params.index.plugins.find((plugin) => plugin.pluginId === engineId);
  if (!selectedPlugin?.startup.memory || !sidecarPlugin?.startup.memory) {
    return new Set();
  }
  const activationState = resolveEffectivePluginActivationState({
    id: selectedPlugin.pluginId,
    origin: selectedPlugin.origin,
    config: params.pluginsConfig,
    rootConfig: params.config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(selectedPlugin, params.platform),
    activationSource: params.activationSource,
  });
  return activationState.enabled ? new Set([engineId]) : new Set();
}

function resolveMemorySlotStartupPluginId(params: {
  activationSourceConfig: OpenClawConfig;
  activationSourcePlugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  normalizePluginId: (pluginId: string) => string;
}): string | undefined {
  const { activationSourceConfig, activationSourcePlugins, normalizePluginId } = params;
  const configuredSlot = activationSourceConfig.plugins?.slots?.memory?.trim();
  if (configuredSlot?.toLowerCase() === "none") {
    return undefined;
  }
  if (!configuredSlot) {
    const defaultSlot = activationSourcePlugins.slots.memory;
    if (typeof defaultSlot !== "string") {
      return undefined;
    }
    if (
      activationSourcePlugins.allow.length > 0 &&
      !activationSourcePlugins.allow.includes(defaultSlot)
    ) {
      return undefined;
    }
    return defaultSlot;
  }
  return normalizePluginId(configuredSlot);
}

function resolveContextEngineSlotStartupPluginId(params: {
  activationSourceConfig: OpenClawConfig;
  activationSourcePlugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  normalizePluginId: (pluginId: string) => string;
}): string | undefined {
  const { activationSourceConfig, activationSourcePlugins, normalizePluginId } = params;
  const configuredSlot = activationSourceConfig.plugins?.slots?.contextEngine?.trim();
  if (!configuredSlot) {
    return undefined;
  }
  const normalized = normalizePluginId(configuredSlot);
  // "legacy" is the built-in default engine — no plugin startup needed.
  if (normalized === "legacy") {
    return undefined;
  }
  if (activationSourcePlugins.deny.includes(normalized)) {
    return undefined;
  }
  if (activationSourcePlugins.entries[normalized]?.enabled === false) {
    return undefined;
  }
  return normalized;
}

function shouldConsiderForGatewayStartup(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
  startupDreamingPluginIds: ReadonlySet<string>;
  memorySlotStartupPluginId?: string;
  contextEngineSlotStartupPluginId?: string;
}): boolean {
  if (params.manifest?.activation?.onStartup === true) {
    return true;
  }
  if (params.contextEngineSlotStartupPluginId === params.plugin.pluginId) {
    return true;
  }
  if (!isGatewayStartupMemoryPlugin(params.plugin)) {
    return false;
  }
  if (params.startupDreamingPluginIds.has(params.plugin.pluginId)) {
    return true;
  }
  return params.memorySlotStartupPluginId === params.plugin.pluginId;
}

function hasConfiguredStartupChannel(params: {
  plugin: InstalledPluginIndexRecord;
  manifestLookup: ManifestRegistryLookup;
  configuredChannelIds: ReadonlySet<string>;
}): boolean {
  return listManifestChannelIds(params.manifestLookup, params.plugin.pluginId).some((channelId) =>
    params.configuredChannelIds.has(channelId),
  );
}

type ManifestRegistryLookup = ReadonlyMap<string, PluginManifestRecord>;

function createManifestRegistryLookup(
  manifestRegistry: PluginManifestRegistry,
): ManifestRegistryLookup {
  return new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin]));
}

function listManifestChannelIds(
  manifestLookup: ManifestRegistryLookup,
  pluginId: string,
): readonly string[] {
  return manifestLookup.get(pluginId)?.channels ?? [];
}

function findManifestPlugin(
  manifestLookup: ManifestRegistryLookup,
  pluginId: string,
): PluginManifestRecord | undefined {
  return manifestLookup.get(pluginId);
}

function hasConfiguredActivationPath(params: {
  manifest: PluginManifestRecord | undefined;
  config: OpenClawConfig;
}): boolean {
  return hasConfiguredActivationPathPatterns({
    paths: params.manifest?.activation?.onConfigPaths,
    config: params.config,
  });
}

function hasConfiguredActivationPathPatterns(params: {
  paths: readonly string[] | undefined;
  config: OpenClawConfig;
}): boolean {
  const paths = params.paths;
  if (!paths?.length) {
    return false;
  }
  return paths.some((pathPattern) =>
    collectPluginConfigContractMatches({
      root: params.config,
      pathPattern,
    }).some((match) => isConfigActivationValueEnabled(match.value)),
  );
}

function addConfiguredActivationPathPluginIds(
  target: Set<string>,
  params: {
    activationSourceConfig: OpenClawConfig;
    index: InstalledPluginIndex;
  },
): void {
  for (const plugin of params.index.plugins) {
    if (plugin.origin !== "bundled") {
      continue;
    }
    if (
      hasConfiguredActivationPathPatterns({
        paths: plugin.startup.configPaths,
        config: params.activationSourceConfig,
      })
    ) {
      target.add(plugin.pluginId);
    }
  }
}

function manifestOwnsConfiguredSpeechProvider(params: {
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

function collectConfiguredWebSearchProviderIds(config: OpenClawConfig): ReadonlySet<string> {
  const search = config.tools?.web?.search;
  if (search?.enabled === false || typeof search?.provider !== "string") {
    return new Set();
  }
  const providerId = normalizeOptionalLowercaseString(search.provider);
  return providerId ? new Set([providerId]) : new Set();
}

function manifestOwnsConfiguredWebSearchProvider(params: {
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

function collectConfiguredAgentModelProviderIds(
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

function manifestOwnsConfiguredModelProvider(params: {
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

function collectConfiguredGenerationProviderIds(
  config: OpenClawConfig,
): ConfiguredGenerationProviderIds {
  const defaults = config.agents?.defaults;
  return {
    imageGenerationProviders: collectModelProviderIds(defaults?.imageGenerationModel),
    videoGenerationProviders: collectModelProviderIds(defaults?.videoGenerationModel),
    musicGenerationProviders: collectModelProviderIds(defaults?.musicGenerationModel),
  };
}

function collectConfiguredVoiceProviderIds(config: OpenClawConfig): ConfiguredVoiceProviderIds {
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
  const defaultsBlock = config.agents?.defaults?.memorySearch;
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
    addEffectiveProviders(isRecord(agent.memorySearch) ? agent.memorySearch : undefined);
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

function addPluginConfigEntryIds(
  target: Set<string>,
  plugins: ReturnType<typeof normalizePluginsConfigForInstalledIndex>,
): void {
  for (const [pluginId, entry] of Object.entries(plugins.entries)) {
    if (entry?.enabled !== false) {
      target.add(pluginId);
    }
  }
}

function addConfiguredSlotPluginIds(
  target: Set<string>,
  params: {
    activationSourceConfig: OpenClawConfig;
    activationSourcePlugins: ReturnType<typeof normalizePluginsConfigForInstalledIndex>;
    lookup: InstalledPluginIndexScopeLookup;
  },
): void {
  const memorySlot = resolveMemorySlotStartupPluginId({
    activationSourceConfig: params.activationSourceConfig,
    activationSourcePlugins: params.activationSourcePlugins,
    normalizePluginId: params.lookup.normalizePluginId,
  });
  if (memorySlot) {
    target.add(memorySlot);
  }
  const contextEngineSlot = resolveContextEngineSlotStartupPluginId({
    activationSourceConfig: params.activationSourceConfig,
    activationSourcePlugins: params.activationSourcePlugins,
    normalizePluginId: params.lookup.normalizePluginId,
  });
  if (contextEngineSlot) {
    target.add(contextEngineSlot);
  }
}

function collectConfiguredStartupChannelIds(params: {
  activationSourceConfig: OpenClawConfig;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): string[] {
  return sortUniquePluginIds([
    ...listPotentialEnabledChannelIds(params.config, params.env),
    ...listPotentialEnabledChannelIds(params.activationSourceConfig, params.env),
  ]);
}

function collectValidationHeartbeatTargetChannelIds(config: OpenClawConfig): string[] {
  const channelIds: string[] = [];
  const pushTarget = (target: unknown) => {
    if (typeof target !== "string") {
      return;
    }
    const normalized = normalizeOptionalLowercaseString(target);
    if (!normalized || normalized === "last" || normalized === "none") {
      return;
    }
    channelIds.push(normalized);
  };
  pushTarget(config.agents?.defaults?.heartbeat?.target);
  if (Array.isArray(config.agents?.list)) {
    for (const agent of config.agents.list) {
      pushTarget(agent?.heartbeat?.target);
    }
  }
  return sortUniquePluginIds(channelIds);
}

function collectValidationChannelConfigIds(config: OpenClawConfig): string[] {
  const channels = isRecord(config.channels) ? config.channels : null;
  if (!channels) {
    return [];
  }
  return Object.keys(channels)
    .filter((channelId) => channelId !== "defaults" && channelId !== "modelByChannel")
    .map((channelId) => normalizeOptionalLowercaseString(channelId) ?? "")
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

function collectConfigValidationChannelIds(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): string[] {
  return sortUniquePluginIds([
    ...collectValidationChannelConfigIds(params.config),
    ...collectConfiguredStartupChannelIds({
      config: params.config,
      activationSourceConfig: params.config,
      env: params.env,
    }),
    ...collectValidationHeartbeatTargetChannelIds(params.config),
  ]);
}

function collectConfiguredProviderIds(config: OpenClawConfig): string[] {
  const configuredWebSearchProviderIds = collectConfiguredWebSearchProviderIds(config);
  const configuredGenerationProviderIds = collectConfiguredGenerationProviderIds(config);
  const configuredVoiceProviderIds = collectConfiguredVoiceProviderIds(config);
  return sortUniquePluginIds([
    ...collectConfiguredSpeechProviderIds(config),
    ...configuredWebSearchProviderIds,
    ...configuredGenerationProviderIds.imageGenerationProviders,
    ...configuredGenerationProviderIds.videoGenerationProviders,
    ...configuredGenerationProviderIds.musicGenerationProviders,
    ...configuredVoiceProviderIds.speechProviders,
    ...configuredVoiceProviderIds.realtimeTranscriptionProviders,
    ...configuredVoiceProviderIds.realtimeVoiceProviders,
    ...collectConfiguredMemoryEmbeddingProviderIds(config),
  ]);
}

function collectValidationConfiguredProviderIds(config: OpenClawConfig): string[] {
  const providerIds: string[] = [];
  const pushProviderId = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = normalizeOptionalLowercaseString(value);
    if (normalized) {
      providerIds.push(normalized);
    }
  };
  const profiles = config.auth?.profiles;
  if (profiles && typeof profiles === "object") {
    for (const profile of Object.values(profiles)) {
      if (isRecord(profile)) {
        pushProviderId(profile.provider);
      }
    }
  }
  const providers = config.models?.providers;
  if (providers && typeof providers === "object") {
    for (const providerId of Object.keys(providers)) {
      pushProviderId(providerId);
    }
  }
  for (const ref of collectConfiguredModelRefs(config)) {
    const slashIndex = ref.value.indexOf("/");
    if (slashIndex > 0) {
      pushProviderId(ref.value.slice(0, slashIndex));
    }
  }
  pushProviderId(config.tools?.web?.search?.provider);
  pushProviderId(config.tools?.web?.fetch?.provider);
  return sortUniquePluginIds(providerIds);
}

function collectValidationConfiguredShorthandModelIds(config: OpenClawConfig): string[] {
  return sortUniquePluginIds(
    collectConfiguredModelRefs(config)
      .map((ref) => ref.value)
      .filter((ref) => !ref.includes("/"))
      .map((ref) => splitTrailingAuthProfile(ref).model.trim())
      .filter(Boolean),
  );
}

function addRequiredAgentHarnessPluginIds(
  target: Set<string>,
  params: {
    activationSourceConfig: OpenClawConfig;
    config: OpenClawConfig;
    index: InstalledPluginIndex;
    pluginsConfig: ReturnType<typeof normalizePluginsConfigForInstalledIndex>;
    activationSource: {
      plugins: ReturnType<typeof normalizePluginsConfigForInstalledIndex>;
      rootConfig?: OpenClawConfig;
    };
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  },
): void {
  const requiredAgentHarnessRuntimes = new Set(
    collectConfiguredAgentHarnessRuntimes(params.activationSourceConfig, {
      includeImplicitRuntimePreferences: false,
    }),
  );
  if (requiredAgentHarnessRuntimes.size === 0) {
    return;
  }
  for (const plugin of params.index.plugins) {
    if (
      canStartRequiredAgentHarnessPlugin({
        plugin,
        pluginsConfig: params.pluginsConfig,
        activationSource: params.activationSource,
        config: params.config,
        requiredAgentHarnessRuntimes,
        platform: params.platform,
      })
    ) {
      target.add(plugin.pluginId);
    }
  }
}

export function resolveGatewayStartupMetadataPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  index: InstalledPluginIndex;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
}): string[] | undefined {
  const lookup = createInstalledPluginIndexScopeLookup(params.index);
  const activationSourceConfig = params.activationSourceConfig ?? params.config;
  const pluginsConfig = normalizePluginsConfigForInstalledIndex(params.config.plugins, lookup);
  const activationSourcePlugins = normalizePluginsConfigForInstalledIndex(
    activationSourceConfig.plugins,
    lookup,
  );
  if (!pluginsConfig.enabled || !activationSourcePlugins.enabled) {
    return [];
  }
  if (
    params.config.plugins?.bundledDiscovery === "compat" ||
    activationSourceConfig.plugins?.bundledDiscovery === "compat"
  ) {
    return undefined;
  }
  if (pluginsConfig.allow.length === 0 && activationSourcePlugins.allow.length === 0) {
    return undefined;
  }

  const scope = new Set<string>([...pluginsConfig.allow, ...activationSourcePlugins.allow]);
  addPluginConfigEntryIds(scope, pluginsConfig);
  addPluginConfigEntryIds(scope, activationSourcePlugins);

  const memorySlotStartupPluginId = resolveMemorySlotStartupPluginId({
    activationSourceConfig,
    activationSourcePlugins,
    normalizePluginId: lookup.normalizePluginId,
  });
  addConfiguredSlotPluginIds(scope, {
    activationSourceConfig,
    activationSourcePlugins,
    lookup,
  });
  for (const pluginId of resolveAuthorizedGatewayStartupDreamingPluginIds({
    config: params.config,
    pluginsConfig,
    activationSource: {
      plugins: activationSourcePlugins,
      rootConfig: activationSourceConfig,
    },
    activationSourcePlugins,
    selectedMemoryPluginId: memorySlotStartupPluginId,
    index: params.index,
    platform: params.platform,
  })) {
    scope.add(pluginId);
  }
  if (!lookup.hasCompleteConfigPathActivationMetadata()) {
    return undefined;
  }
  addConfiguredActivationPathPluginIds(scope, {
    activationSourceConfig,
    index: params.index,
  });

  const configuredChannelIds = collectConfiguredStartupChannelIds({
    config: params.config,
    activationSourceConfig,
    env: params.env,
  });
  if (!lookup.hasDirectChannelOwners(configuredChannelIds)) {
    return undefined;
  }
  lookup.addDirectChannelOwners(scope, configuredChannelIds);

  const configuredProviderIds = sortUniquePluginIds([
    ...collectConfiguredProviderIds(params.config),
    ...collectConfiguredProviderIds(activationSourceConfig),
    ...collectValidationConfiguredProviderIds(params.config),
    ...collectValidationConfiguredProviderIds(activationSourceConfig),
  ]);
  if (!lookup.canResolveDirectProviderIds(configuredProviderIds, scope)) {
    return undefined;
  }
  lookup.addDirectProviderOwners(scope, configuredProviderIds);

  const workerProviderIds = normalizeWorkerProviderIds([
    ...collectConfiguredWorkerProviderIds(params.config),
    ...collectConfiguredWorkerProviderIds(activationSourceConfig),
    ...(params.workerProviderIds ?? []),
  ]);
  if (!lookup.hasProviderContributionOwners(workerProviderIds)) {
    return undefined;
  }
  lookup.addProviderContributionOwners(scope, workerProviderIds);

  const configuredShorthandModelIds = sortUniquePluginIds([
    ...collectValidationConfiguredShorthandModelIds(params.config),
    ...collectValidationConfiguredShorthandModelIds(activationSourceConfig),
  ]);
  if (!lookup.hasShorthandModelOwners(configuredShorthandModelIds)) {
    return undefined;
  }
  lookup.addShorthandModelOwners(scope, configuredShorthandModelIds);

  addRequiredAgentHarnessPluginIds(scope, {
    activationSourceConfig,
    config: params.config,
    index: params.index,
    pluginsConfig,
    activationSource: {
      plugins: activationSourcePlugins,
      rootConfig: activationSourceConfig,
    },
    env: params.env,
    platform: params.platform,
  });

  const deniedPluginIds = new Set([...pluginsConfig.deny, ...activationSourcePlugins.deny]);
  for (const pluginId of deniedPluginIds) {
    scope.delete(pluginId);
  }
  for (const [pluginId, entry] of Object.entries(pluginsConfig.entries)) {
    if (entry?.enabled === false) {
      scope.delete(pluginId);
    }
  }
  for (const [pluginId, entry] of Object.entries(activationSourcePlugins.entries)) {
    if (entry?.enabled === false) {
      scope.delete(pluginId);
    }
  }
  if (!lookup.hasInstalledPluginIds(scope)) {
    return undefined;
  }
  return sortUniquePluginIds(scope);
}

export function createGatewayStartupMetadataPluginIdScope(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
}): PluginMetadataSnapshotPluginIdScope {
  const configuredChannelIds = collectConfiguredStartupChannelIds({
    config: params.config,
    activationSourceConfig: params.activationSourceConfig ?? params.config,
    env: params.env,
  });
  const workerProviderIds = normalizeWorkerProviderIds(params.workerProviderIds ?? []);
  return {
    key: hashJson({
      kind: "gateway-startup",
      config: params.config,
      activationSourceConfig: params.activationSourceConfig ?? null,
      configuredChannelIds,
      workerProviderIds,
      platform: params.platform ?? null,
    }),
    resolve: ({ index }) =>
      resolveGatewayStartupMetadataPluginIds({
        config: params.config,
        ...(params.activationSourceConfig !== undefined
          ? { activationSourceConfig: params.activationSourceConfig }
          : {}),
        env: params.env,
        index,
        ...(workerProviderIds.length > 0 ? { workerProviderIds } : {}),
        ...(params.platform !== undefined ? { platform: params.platform } : {}),
      }),
  };
}

function addValidationPluginConfigReferences(
  target: Set<string>,
  params: {
    config: OpenClawConfig;
    pluginsConfig: ReturnType<typeof normalizePluginsConfigForInstalledIndex>;
    normalizePluginId: (pluginId: string) => string;
  },
): void {
  for (const pluginId of params.pluginsConfig.allow) {
    target.add(pluginId);
  }
  for (const pluginId of params.pluginsConfig.deny) {
    target.add(pluginId);
  }
  for (const pluginId of Object.keys(params.pluginsConfig.entries)) {
    target.add(pluginId);
  }
  const rawSlots = isRecord(params.config.plugins?.slots) ? params.config.plugins.slots : {};
  const hasExplicitMemorySlot = Object.hasOwn(rawSlots, "memory");
  const memorySlot = hasExplicitMemorySlot ? params.pluginsConfig.slots.memory : undefined;
  if (typeof memorySlot === "string") {
    target.add(params.normalizePluginId(memorySlot));
  }
  const hasExplicitContextEngineSlot = Object.hasOwn(rawSlots, "contextEngine");
  const contextEngineSlot = hasExplicitContextEngineSlot
    ? params.pluginsConfig.slots.contextEngine
    : undefined;
  if (typeof contextEngineSlot === "string" && contextEngineSlot !== "legacy") {
    target.add(params.normalizePluginId(contextEngineSlot));
  }
}

export function resolveConfigValidationMetadataPluginIds(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  index: InstalledPluginIndex;
  platform?: NodeJS.Platform;
}): string[] | undefined {
  const lookup = createInstalledPluginIndexScopeLookup(params.index);
  const pluginsConfig = normalizePluginsConfigForInstalledIndex(params.config.plugins, lookup);
  if (params.config.plugins?.bundledDiscovery === "compat" || pluginsConfig.loadPaths.length > 0) {
    return undefined;
  }

  const scope = new Set<string>();
  addValidationPluginConfigReferences(scope, {
    config: params.config,
    pluginsConfig,
    normalizePluginId: lookup.normalizePluginId,
  });
  if (!lookup.hasCompleteConfigPathActivationMetadata()) {
    return undefined;
  }
  addConfiguredActivationPathPluginIds(scope, {
    activationSourceConfig: params.config,
    index: params.index,
  });

  const configuredChannelIds = collectConfigValidationChannelIds({
    config: params.config,
    env: params.env,
  });
  if (!lookup.hasChannelContributionOwners(configuredChannelIds)) {
    return undefined;
  }
  lookup.addChannelContributionOwners(scope, configuredChannelIds);

  const configuredProviderIds = collectValidationConfiguredProviderIds(params.config);
  if (!lookup.hasProviderContributionOwners(configuredProviderIds)) {
    return undefined;
  }
  lookup.addProviderContributionOwners(scope, configuredProviderIds);

  const configuredShorthandModelIds = collectValidationConfiguredShorthandModelIds(params.config);
  if (!lookup.hasShorthandModelOwners(configuredShorthandModelIds)) {
    return undefined;
  }
  lookup.addShorthandModelOwners(scope, configuredShorthandModelIds);

  addRequiredAgentHarnessPluginIds(scope, {
    activationSourceConfig: params.config,
    config: params.config,
    index: params.index,
    pluginsConfig,
    activationSource: {
      plugins: pluginsConfig,
      rootConfig: params.config,
    },
    env: params.env,
    platform: params.platform,
  });

  if (!lookup.hasInstalledPluginIds(scope)) {
    return undefined;
  }
  return sortUniquePluginIds(scope);
}

export function createConfigValidationMetadataPluginIdScope(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): PluginMetadataSnapshotPluginIdScope {
  const configuredChannelIds = collectConfigValidationChannelIds({
    config: params.config,
    env: params.env,
  });
  const configuredProviderIds = collectValidationConfiguredProviderIds(params.config);
  const configuredShorthandModelIds = collectValidationConfiguredShorthandModelIds(params.config);
  return {
    key: hashJson({
      kind: "config-validation",
      config: params.config,
      configuredChannelIds,
      configuredProviderIds,
      configuredShorthandModelIds,
      platform: params.platform ?? null,
    }),
    resolve: ({ index }) =>
      resolveConfigValidationMetadataPluginIds({
        config: params.config,
        env: params.env,
        index,
        ...(params.platform !== undefined ? { platform: params.platform } : {}),
      }),
  };
}

export function isMetadataSnapshotScopedForGatewayStartup(params: {
  metadataSnapshot: Pick<PluginMetadataSnapshot, "index" | "pluginIds">;
  pluginIdScope: PluginMetadataSnapshotPluginIdScope;
}): boolean {
  const expectedPluginIds = normalizePluginIdScope(
    params.pluginIdScope.resolve({ index: params.metadataSnapshot.index }),
  );
  const snapshotPluginIds = normalizePluginIdScope(params.metadataSnapshot.pluginIds);
  if (expectedPluginIds === undefined || snapshotPluginIds === undefined) {
    return expectedPluginIds === undefined && snapshotPluginIds === undefined;
  }
  if (expectedPluginIds.length === 0) {
    return snapshotPluginIds.length === 0;
  }
  const snapshotPluginIdSet = new Set(snapshotPluginIds);
  return expectedPluginIds.every((pluginId) => snapshotPluginIdSet.has(pluginId));
}

function manifestOwnsConfiguredGenerationProvider(params: {
  manifest: PluginManifestRecord | undefined;
  configuredGenerationProviderIds: ConfiguredGenerationProviderIds;
}): boolean {
  for (const contractKey of [
    "imageGenerationProviders",
    "videoGenerationProviders",
    "musicGenerationProviders",
  ] as const) {
    const configuredProviderIds = params.configuredGenerationProviderIds[contractKey];
    if (configuredProviderIds.size === 0) {
      continue;
    }
    if (
      (params.manifest?.contracts?.[contractKey] ?? []).some((providerId) => {
        const normalized = normalizeOptionalLowercaseString(providerId);
        return normalized ? configuredProviderIds.has(normalized) : false;
      })
    ) {
      return true;
    }
  }
  return false;
}

function manifestOwnsConfiguredVoiceProvider(params: {
  manifest: PluginManifestRecord | undefined;
  configuredVoiceProviderIds: ConfiguredVoiceProviderIds;
}): boolean {
  for (const contractKey of [
    "speechProviders",
    "realtimeTranscriptionProviders",
    "realtimeVoiceProviders",
  ] as const) {
    const configuredProviderIds = params.configuredVoiceProviderIds[contractKey];
    if (configuredProviderIds.size === 0) {
      continue;
    }
    if (
      (params.manifest?.contracts?.[contractKey] ?? []).some((providerId) => {
        const normalized = normalizeOptionalLowercaseString(providerId);
        return normalized ? configuredProviderIds.has(normalized) : false;
      })
    ) {
      return true;
    }
  }
  return false;
}

function manifestOwnsConfiguredMemoryEmbeddingProvider(params: {
  manifest: PluginManifestRecord | undefined;
  configuredMemoryEmbeddingProviderIds: ReadonlySet<string>;
}): boolean {
  if (params.configuredMemoryEmbeddingProviderIds.size === 0) {
    return false;
  }
  const embeddingProviderIds = [
    ...(params.manifest?.contracts?.memoryEmbeddingProviders ?? []),
    ...(params.manifest?.contracts?.embeddingProviders ?? []),
  ];
  return embeddingProviderIds.some((providerId) => {
    const normalized = normalizeOptionalLowercaseString(providerId);
    return normalized ? params.configuredMemoryEmbeddingProviderIds.has(normalized) : false;
  });
}

type ConfiguredProviderActivation = {
  plugin: InstalledPluginIndexRecord;
  config: OpenClawConfig;
  pluginsConfig: NormalizedPluginsConfig;
  activationSource: { plugins: NormalizedPluginsConfig; rootConfig?: OpenClawConfig };
  platform?: NodeJS.Platform;
  autoEnabledReason?: string;
  allowImplicitExternal?: boolean;
};

function canStartConfiguredProvider(params: ConfiguredProviderActivation): boolean {
  if (
    !params.pluginsConfig.enabled ||
    !params.activationSource.plugins.enabled ||
    blocksPluginStartup({
      pluginId: params.plugin.pluginId,
      pluginsConfig: params.pluginsConfig,
      activationSourcePlugins: params.activationSource.plugins,
    })
  ) {
    return false;
  }
  const activationState = resolveEffectivePluginActivationState({
    id: params.plugin.pluginId,
    origin: params.plugin.origin,
    config: params.pluginsConfig,
    rootConfig: params.config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin, params.platform),
    activationSource: params.activationSource,
    ...(params.autoEnabledReason ? { autoEnabledReason: params.autoEnabledReason } : {}),
  });
  return (
    activationState.enabled &&
    (params.allowImplicitExternal ||
      params.plugin.origin === "bundled" ||
      activationState.explicitlyEnabled)
  );
}

function canStartConfiguredGenerationProviderPlugin(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
  config: OpenClawConfig;
  pluginsConfig: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  activationSource: {
    plugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
    rootConfig?: OpenClawConfig;
  };
  configuredGenerationProviderIds: ConfiguredGenerationProviderIds;
  platform?: NodeJS.Platform;
}): boolean {
  if (
    !manifestOwnsConfiguredGenerationProvider({
      manifest: params.manifest,
      configuredGenerationProviderIds: params.configuredGenerationProviderIds,
    })
  ) {
    return false;
  }
  return canStartConfiguredProvider(params);
}

function canStartConfiguredVoiceProviderPlugin(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
  config: OpenClawConfig;
  pluginsConfig: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  activationSource: {
    plugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
    rootConfig?: OpenClawConfig;
  };
  configuredVoiceProviderIds: ConfiguredVoiceProviderIds;
  platform?: NodeJS.Platform;
}): boolean {
  if (
    !manifestOwnsConfiguredVoiceProvider({
      manifest: params.manifest,
      configuredVoiceProviderIds: params.configuredVoiceProviderIds,
    })
  ) {
    return false;
  }
  return canStartConfiguredProvider(params);
}

function canStartConfiguredMemoryEmbeddingProviderPlugin(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
  config: OpenClawConfig;
  pluginsConfig: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  activationSource: {
    plugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
    rootConfig?: OpenClawConfig;
  };
  configuredMemoryEmbeddingProviderIds: ReadonlySet<string>;
  platform?: NodeJS.Platform;
}): boolean {
  if (
    !manifestOwnsConfiguredMemoryEmbeddingProvider({
      manifest: params.manifest,
      configuredMemoryEmbeddingProviderIds: params.configuredMemoryEmbeddingProviderIds,
    })
  ) {
    return false;
  }
  return canStartConfiguredProvider({ ...params, allowImplicitExternal: true });
}

function canStartConfiguredWorkerProviderPlugin(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
  config: OpenClawConfig;
  pluginsConfig: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  activationSource: {
    plugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
    rootConfig?: OpenClawConfig;
  };
  configuredWorkerProviderIds: ReadonlySet<string>;
  platform?: NodeJS.Platform;
}): boolean {
  if (!manifestOwnsWorkerProvider(params.manifest, params.configuredWorkerProviderIds)) {
    return false;
  }
  return canStartConfiguredProvider({
    ...params,
    autoEnabledReason: "cloud worker provider required",
  });
}

function canStartConfiguredModelProviderPlugin(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
  config: OpenClawConfig;
  pluginsConfig: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  activationSource: {
    plugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
    rootConfig?: OpenClawConfig;
  };
  configuredModelProviderIds: ReadonlySet<string>;
  platform?: NodeJS.Platform;
}): boolean {
  if (
    !manifestOwnsConfiguredModelProvider({
      manifest: params.manifest,
      configuredModelProviderIds: params.configuredModelProviderIds,
    })
  ) {
    return false;
  }
  return canStartConfiguredProvider(params);
}

function canStartRequiredAgentHarnessPlugin(params: {
  plugin: InstalledPluginIndexRecord;
  pluginsConfig: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  activationSource: {
    plugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
    rootConfig?: OpenClawConfig;
  };
  config: OpenClawConfig;
  requiredAgentHarnessRuntimes: ReadonlySet<string>;
  platform?: NodeJS.Platform;
}): boolean {
  if (
    !params.plugin.startup.agentHarnesses.some((runtime) =>
      params.requiredAgentHarnessRuntimes.has(runtime),
    )
  ) {
    return false;
  }
  if (!params.pluginsConfig.enabled || !params.activationSource.plugins.enabled) {
    return false;
  }
  if (
    params.pluginsConfig.deny.includes(params.plugin.pluginId) ||
    params.activationSource.plugins.deny.includes(params.plugin.pluginId)
  ) {
    return false;
  }
  if (
    params.pluginsConfig.entries[params.plugin.pluginId]?.enabled === false ||
    params.activationSource.plugins.entries[params.plugin.pluginId]?.enabled === false
  ) {
    return false;
  }
  if (
    params.pluginsConfig.allow.length > 0 &&
    !params.pluginsConfig.allow.includes(params.plugin.pluginId)
  ) {
    return false;
  }
  if (
    params.activationSource.plugins.allow.length > 0 &&
    !params.activationSource.plugins.allow.includes(params.plugin.pluginId)
  ) {
    return false;
  }
  const activationState = resolveEffectivePluginActivationState({
    id: params.plugin.pluginId,
    origin: params.plugin.origin,
    config: params.pluginsConfig,
    rootConfig: params.config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin, params.platform),
    activationSource: params.activationSource,
  });
  return activationState.enabled || params.plugin.origin === "bundled";
}

function canStartConfiguredSpeechProviderPlugin(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
  config: OpenClawConfig;
  pluginsConfig: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  activationSource: {
    plugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
    rootConfig?: OpenClawConfig;
  };
  configuredSpeechProviderIds: ReadonlySet<string>;
  platform?: NodeJS.Platform;
}): boolean {
  if (
    !manifestOwnsConfiguredSpeechProvider({
      manifest: params.manifest,
      configuredSpeechProviderIds: params.configuredSpeechProviderIds,
    })
  ) {
    return false;
  }
  if (
    params.pluginsConfig.deny.includes(params.plugin.pluginId) ||
    params.activationSource.plugins.deny.includes(params.plugin.pluginId)
  ) {
    return false;
  }
  if (
    params.pluginsConfig.entries[params.plugin.pluginId]?.enabled === false ||
    params.activationSource.plugins.entries[params.plugin.pluginId]?.enabled === false
  ) {
    return false;
  }
  if (params.plugin.origin === "bundled") {
    return true;
  }
  const activationState = resolveEffectivePluginActivationState({
    id: params.plugin.pluginId,
    origin: params.plugin.origin,
    config: params.pluginsConfig,
    rootConfig: params.config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin, params.platform),
    activationSource: params.activationSource,
  });
  return activationState.enabled && activationState.explicitlyEnabled;
}

function canStartConfiguredWebSearchProviderPlugin(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
  config: OpenClawConfig;
  pluginsConfig: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  activationSource: {
    plugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
    rootConfig?: OpenClawConfig;
  };
  configuredWebSearchProviderIds: ReadonlySet<string>;
  platform?: NodeJS.Platform;
}): boolean {
  if (
    !manifestOwnsConfiguredWebSearchProvider({
      manifest: params.manifest,
      configuredWebSearchProviderIds: params.configuredWebSearchProviderIds,
    })
  ) {
    return false;
  }
  return canStartConfiguredProvider({ ...params, allowImplicitExternal: true });
}

function canStartConfiguredRootPlugin(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
  config: OpenClawConfig;
  pluginsConfig: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  activationSource: {
    plugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
    rootConfig?: OpenClawConfig;
  };
  platform?: NodeJS.Platform;
}): boolean {
  if (
    !hasConfiguredActivationPath({
      manifest: params.manifest,
      config: params.activationSource.rootConfig ?? params.config,
    })
  ) {
    return false;
  }
  if (!params.pluginsConfig.enabled || !params.activationSource.plugins.enabled) {
    return false;
  }
  if (
    params.pluginsConfig.deny.includes(params.plugin.pluginId) ||
    params.activationSource.plugins.deny.includes(params.plugin.pluginId)
  ) {
    return false;
  }
  if (
    params.pluginsConfig.entries[params.plugin.pluginId]?.enabled === false ||
    params.activationSource.plugins.entries[params.plugin.pluginId]?.enabled === false
  ) {
    return false;
  }
  if (params.plugin.origin === "bundled") {
    return true;
  }
  if (
    params.activationSource.plugins.allow.length > 0 &&
    !params.activationSource.plugins.allow.includes(params.plugin.pluginId)
  ) {
    return false;
  }
  const activationState = resolveEffectivePluginActivationState({
    id: params.plugin.pluginId,
    origin: params.plugin.origin,
    config: params.pluginsConfig,
    rootConfig: params.config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin, params.platform),
    activationSource: params.activationSource,
  });
  // External manifests may name broad config paths. Requiring authored
  // enablement prevents an installed plugin from activating on ambient config.
  return activationState.enabled && activationState.explicitlyEnabled;
}

function hasExplicitHookPolicyConfig(
  entry: NormalizedPluginsConfig["entries"][string] | undefined,
): boolean {
  return (
    entry?.hooks?.allowConversationAccess === true ||
    entry?.hooks?.allowPromptInjection === true ||
    entry?.hooks?.timeoutMs !== undefined ||
    (entry?.hooks?.timeouts !== undefined && Object.keys(entry.hooks.timeouts).length > 0)
  );
}

function hasHookRuntimeStartupIntent(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
  activationSourcePlugins: NormalizedPluginsConfig;
}): boolean {
  if (params.manifest?.activation?.onCapabilities?.includes("hook")) {
    return true;
  }
  return hasExplicitHookPolicyConfig(
    params.activationSourcePlugins.entries[params.plugin.pluginId],
  );
}

function canStartExplicitHookPlugin(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
  config: OpenClawConfig;
  pluginsConfig: NormalizedPluginsConfig;
  activationSource: {
    plugins: NormalizedPluginsConfig;
    rootConfig?: OpenClawConfig;
  };
  activationSourcePlugins: NormalizedPluginsConfig;
  platform?: NodeJS.Platform;
}): boolean {
  const hasHookPolicyIntent = hasExplicitHookPolicyConfig(
    params.activationSourcePlugins.entries[params.plugin.pluginId],
  );
  if (
    !hasHookRuntimeStartupIntent({
      plugin: params.plugin,
      manifest: params.manifest,
      activationSourcePlugins: params.activationSourcePlugins,
    })
  ) {
    return false;
  }
  if (!params.pluginsConfig.enabled || !params.activationSourcePlugins.enabled) {
    return false;
  }
  if (
    params.pluginsConfig.deny.includes(params.plugin.pluginId) ||
    params.activationSourcePlugins.deny.includes(params.plugin.pluginId)
  ) {
    return false;
  }
  if (
    params.pluginsConfig.entries[params.plugin.pluginId]?.enabled === false ||
    params.activationSourcePlugins.entries[params.plugin.pluginId]?.enabled === false
  ) {
    return false;
  }
  const activationState = resolveEffectivePluginActivationState({
    id: params.plugin.pluginId,
    origin: params.plugin.origin,
    config: params.pluginsConfig,
    rootConfig: params.config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin, params.platform),
    activationSource: params.activationSource,
  });
  return activationState.enabled && (activationState.explicitlyEnabled || hasHookPolicyIntent);
}

function canStartTrustedToolPolicyPlugin(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
  config: OpenClawConfig;
  pluginsConfig: NormalizedPluginsConfig;
  activationSource: {
    plugins: NormalizedPluginsConfig;
    rootConfig?: OpenClawConfig;
  };
  platform?: NodeJS.Platform;
}): boolean {
  if ((params.manifest?.contracts?.trustedToolPolicies?.length ?? 0) === 0) {
    return false;
  }
  if (!params.pluginsConfig.enabled || !params.activationSource.plugins.enabled) {
    return false;
  }
  if (
    params.pluginsConfig.deny.includes(params.plugin.pluginId) ||
    params.activationSource.plugins.deny.includes(params.plugin.pluginId)
  ) {
    return false;
  }
  if (
    params.pluginsConfig.entries[params.plugin.pluginId]?.enabled === false ||
    params.activationSource.plugins.entries[params.plugin.pluginId]?.enabled === false
  ) {
    return false;
  }
  const activationState = resolveEffectivePluginActivationState({
    id: params.plugin.pluginId,
    origin: params.plugin.origin,
    config: params.pluginsConfig,
    rootConfig: params.config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin, params.platform),
    activationSource: params.activationSource,
  });
  return (
    activationState.enabled &&
    (params.plugin.origin === "bundled" || activationState.explicitlyEnabled)
  );
}

function canStartConfiguredChannelPlugin(params: {
  plugin: InstalledPluginIndexRecord;
  config: OpenClawConfig;
  pluginsConfig: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  activationSource: {
    plugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
    rootConfig?: OpenClawConfig;
  };
  manifestLookup: ManifestRegistryLookup;
  platform?: NodeJS.Platform;
}): boolean {
  if (!params.pluginsConfig.enabled) {
    return false;
  }
  if (params.pluginsConfig.deny.includes(params.plugin.pluginId)) {
    return false;
  }
  if (params.pluginsConfig.entries[params.plugin.pluginId]?.enabled === false) {
    return false;
  }
  const explicitBundledChannelConfig =
    params.plugin.origin === "bundled" &&
    listManifestChannelIds(params.manifestLookup, params.plugin.pluginId).some((channelId) =>
      hasExplicitChannelConfig({
        config: params.activationSource.rootConfig ?? params.config,
        channelId,
      }),
    );
  if (
    params.pluginsConfig.allow.length > 0 &&
    !params.pluginsConfig.allow.includes(params.plugin.pluginId) &&
    !explicitBundledChannelConfig
  ) {
    return false;
  }
  if (params.plugin.origin === "bundled") {
    return true;
  }
  const activationState = resolveEffectivePluginActivationState({
    id: params.plugin.pluginId,
    origin: params.plugin.origin,
    config: params.pluginsConfig,
    rootConfig: params.config,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin, params.platform),
    activationSource: params.activationSource,
  });
  return activationState.enabled && activationState.explicitlyEnabled;
}

export function resolveChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  return [...loadGatewayStartupPluginPlan(params).channelPluginIds];
}

export function resolveChannelPluginIdsFromRegistry(params: {
  manifestRegistry: PluginManifestRegistry;
}): string[] {
  const { manifestRegistry } = params;
  return manifestRegistry.plugins
    .filter((plugin) => plugin.channels.length > 0)
    .map((plugin) => plugin.id);
}

export function resolveConfiguredDeferredChannelPluginIdsFromRegistry(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  index: PluginRegistrySnapshot;
  manifestRegistry: PluginManifestRegistry;
}): string[] {
  const configuredChannelIds = new Set(listPotentialEnabledChannelIds(params.config, params.env));
  if (configuredChannelIds.size === 0) {
    return [];
  }
  const pluginsConfig = normalizePluginsConfigWithRegistry(params.config.plugins, params.index, {
    manifestRegistry: params.manifestRegistry,
  });
  const activationSource = {
    plugins: pluginsConfig,
    rootConfig: params.config,
  };
  const manifestLookup = createManifestRegistryLookup(params.manifestRegistry);
  return resolveConfiguredDeferredChannelPluginIdsFromPrepared({
    config: params.config,
    index: params.index,
    configuredChannelIds,
    pluginsConfig,
    activationSource,
    manifestLookup,
  });
}

function resolveConfiguredDeferredChannelPluginIdsFromPrepared(params: {
  config: OpenClawConfig;
  index: PluginRegistrySnapshot;
  configuredChannelIds: ReadonlySet<string>;
  pluginsConfig: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  activationSource: {
    plugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
    rootConfig?: OpenClawConfig;
  };
  manifestLookup: ManifestRegistryLookup;
  platform?: NodeJS.Platform;
}): string[] {
  if (params.configuredChannelIds.size === 0) {
    return [];
  }
  return params.index.plugins
    .filter(
      (plugin) =>
        hasConfiguredStartupChannel({
          plugin,
          manifestLookup: params.manifestLookup,
          configuredChannelIds: params.configuredChannelIds,
        }) &&
        plugin.startup.deferConfiguredChannelFullLoadUntilAfterListen &&
        canStartConfiguredChannelPlugin({
          plugin,
          config: params.config,
          pluginsConfig: params.pluginsConfig,
          activationSource: params.activationSource,
          manifestLookup: params.manifestLookup,
          platform: params.platform,
        }),
    )
    .map((plugin) => plugin.pluginId);
}

export function resolveConfiguredDeferredChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  return [...loadGatewayStartupPluginPlan(params).configuredDeferredChannelPluginIds];
}

export function resolveGatewayStartupPluginPlanFromRegistry(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  index: PluginRegistrySnapshot;
  manifestRegistry: PluginManifestRegistry;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
}): GatewayStartupPluginPlan {
  const channelPluginIds = resolveChannelPluginIdsFromRegistry({
    manifestRegistry: params.manifestRegistry,
  });
  const configuredChannelIds = new Set(listPotentialEnabledChannelIds(params.config, params.env));
  const pluginsConfig = normalizePluginsConfigWithRegistry(params.config.plugins, params.index, {
    manifestRegistry: params.manifestRegistry,
  });
  // Startup must classify allowlist exceptions against the raw config snapshot,
  // not the auto-enabled effective snapshot, or configured-only channels can be
  // misclassified as explicit enablement.
  const activationSourceConfig = params.activationSourceConfig ?? params.config;
  const activationSourcePlugins = normalizePluginsConfigWithRegistry(
    activationSourceConfig.plugins,
    params.index,
    { manifestRegistry: params.manifestRegistry },
  );
  const activationSource = {
    plugins: activationSourcePlugins,
    rootConfig: activationSourceConfig,
  };
  const manifestLookup = createManifestRegistryLookup(params.manifestRegistry);
  const explicitlyDisabledChannelIds = new Set(
    listExplicitlyDisabledChannelIdsForConfig(params.config),
  );
  const configuredDeferredChannelPluginIds: string[] = [];
  const requiredAgentHarnessRuntimes = new Set(
    collectConfiguredAgentHarnessRuntimes(activationSourceConfig),
  );
  const configuredSpeechProviderIds = collectConfiguredSpeechProviderIds(activationSourceConfig);
  const configuredWebSearchProviderIds =
    collectConfiguredWebSearchProviderIds(activationSourceConfig);
  const configuredModelProviderIds = collectConfiguredAgentModelProviderIds(
    activationSourceConfig,
    params.manifestRegistry,
  );
  const configuredGenerationProviderIds =
    collectConfiguredGenerationProviderIds(activationSourceConfig);
  const configuredVoiceProviderIds = collectConfiguredVoiceProviderIds(activationSourceConfig);
  const configuredMemoryEmbeddingProviderIds =
    collectConfiguredMemoryEmbeddingProviderIds(activationSourceConfig);
  const configuredWorkerProviderIds = new Set([
    ...collectConfiguredWorkerProviderIds(activationSourceConfig),
    ...normalizeWorkerProviderIds(params.workerProviderIds ?? []),
  ]);
  const normalizePluginId = createPluginRegistryIdNormalizer(params.index, {
    manifestRegistry: params.manifestRegistry,
  });
  const memorySlotStartupPluginId = resolveMemorySlotStartupPluginId({
    activationSourceConfig,
    activationSourcePlugins,
    normalizePluginId,
  });
  const startupDreamingPluginIds = resolveAuthorizedGatewayStartupDreamingPluginIds({
    config: params.config,
    pluginsConfig,
    activationSource,
    activationSourcePlugins,
    selectedMemoryPluginId: memorySlotStartupPluginId,
    index: params.index,
    platform: params.platform,
  });
  const contextEngineSlotStartupPluginId = resolveContextEngineSlotStartupPluginId({
    activationSourceConfig,
    activationSourcePlugins,
    normalizePluginId,
  });
  const pluginIds: string[] = [];
  for (const plugin of params.index.plugins) {
    const manifest = findManifestPlugin(manifestLookup, plugin.pluginId);
    const hasEnabledManifestChannel =
      manifest?.channels?.some((channelId) => {
        const normalizedChannelId = normalizeOptionalLowercaseString(channelId);
        return normalizedChannelId ? !explicitlyDisabledChannelIds.has(normalizedChannelId) : false;
      }) ?? false;
    // Non-bundled plugin that explicitly declares channels and is enabled
    // in plugins.entries must be treated as a configured startup channel
    // even when the channel itself is not listed in config.channels.
    // Published install flows configure channels via plugins.entries, and
    // the channel config may only have {enabled: true} which does not
    // produce a `configuredChannelIds` entry.
    const hasExplicitlyEnabledNonBundledChannel =
      plugin.origin !== "bundled" &&
      hasEnabledManifestChannel &&
      pluginsConfig.entries[plugin.pluginId]?.enabled === true &&
      !pluginsConfig.deny.includes(plugin.pluginId);
    if (
      hasConfiguredStartupChannel({
        plugin,
        manifestLookup,
        configuredChannelIds,
      }) ||
      hasExplicitlyEnabledNonBundledChannel
    ) {
      const canStartConfiguredChannel = canStartConfiguredChannelPlugin({
        plugin,
        config: params.config,
        pluginsConfig,
        activationSource,
        manifestLookup,
        platform: params.platform,
      });
      if (canStartConfiguredChannel) {
        pluginIds.push(plugin.pluginId);
        if (plugin.startup.deferConfiguredChannelFullLoadUntilAfterListen) {
          configuredDeferredChannelPluginIds.push(plugin.pluginId);
        }
      }
      continue;
    }
    if (
      canStartRequiredAgentHarnessPlugin({
        plugin,
        pluginsConfig,
        activationSource,
        config: params.config,
        requiredAgentHarnessRuntimes,
        platform: params.platform,
      })
    ) {
      pluginIds.push(plugin.pluginId);
      continue;
    }
    if (
      canStartConfiguredRootPlugin({
        plugin,
        manifest,
        config: params.config,
        pluginsConfig,
        activationSource,
        platform: params.platform,
      })
    ) {
      pluginIds.push(plugin.pluginId);
      continue;
    }
    if (
      canStartConfiguredWorkerProviderPlugin({
        plugin,
        manifest,
        config: params.config,
        pluginsConfig,
        activationSource,
        configuredWorkerProviderIds,
        platform: params.platform,
      })
    ) {
      pluginIds.push(plugin.pluginId);
      continue;
    }
    if (
      canStartConfiguredSpeechProviderPlugin({
        plugin,
        manifest,
        config: params.config,
        pluginsConfig,
        activationSource,
        configuredSpeechProviderIds,
        platform: params.platform,
      })
    ) {
      pluginIds.push(plugin.pluginId);
      continue;
    }
    if (
      canStartConfiguredWebSearchProviderPlugin({
        plugin,
        manifest,
        config: params.config,
        pluginsConfig,
        activationSource,
        configuredWebSearchProviderIds,
        platform: params.platform,
      })
    ) {
      pluginIds.push(plugin.pluginId);
      continue;
    }
    if (
      canStartConfiguredModelProviderPlugin({
        plugin,
        manifest,
        config: params.config,
        pluginsConfig,
        activationSource,
        configuredModelProviderIds,
        platform: params.platform,
      })
    ) {
      pluginIds.push(plugin.pluginId);
      continue;
    }
    if (
      canStartConfiguredGenerationProviderPlugin({
        plugin,
        manifest,
        config: params.config,
        pluginsConfig,
        activationSource,
        configuredGenerationProviderIds,
        platform: params.platform,
      })
    ) {
      pluginIds.push(plugin.pluginId);
      continue;
    }
    if (
      canStartConfiguredVoiceProviderPlugin({
        plugin,
        manifest,
        config: params.config,
        pluginsConfig,
        activationSource,
        configuredVoiceProviderIds,
        platform: params.platform,
      })
    ) {
      pluginIds.push(plugin.pluginId);
      continue;
    }
    if (
      canStartConfiguredMemoryEmbeddingProviderPlugin({
        plugin,
        manifest,
        config: params.config,
        pluginsConfig,
        activationSource,
        configuredMemoryEmbeddingProviderIds,
        platform: params.platform,
      })
    ) {
      pluginIds.push(plugin.pluginId);
      continue;
    }
    if (
      canStartExplicitHookPlugin({
        plugin,
        manifest,
        config: params.config,
        pluginsConfig,
        activationSource,
        activationSourcePlugins,
        platform: params.platform,
      })
    ) {
      pluginIds.push(plugin.pluginId);
      continue;
    }
    if (
      canStartTrustedToolPolicyPlugin({
        plugin,
        manifest,
        config: params.config,
        pluginsConfig,
        activationSource,
        platform: params.platform,
      })
    ) {
      pluginIds.push(plugin.pluginId);
      continue;
    }
    if (
      !shouldConsiderForGatewayStartup({
        plugin,
        manifest,
        startupDreamingPluginIds,
        memorySlotStartupPluginId,
        contextEngineSlotStartupPluginId,
      })
    ) {
      continue;
    }
    if (startupDreamingPluginIds.has(plugin.pluginId)) {
      pluginIds.push(plugin.pluginId);
      continue;
    }
    const activationState = resolveEffectivePluginActivationState({
      id: plugin.pluginId,
      origin: plugin.origin,
      config: pluginsConfig,
      rootConfig: params.config,
      enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin, params.platform),
      activationSource,
    });
    if (!activationState.enabled) {
      continue;
    }
    if (
      plugin.origin !== "bundled"
        ? activationState.explicitlyEnabled
        : activationState.source === "explicit" || activationState.source === "default"
    ) {
      pluginIds.push(plugin.pluginId);
    }
  }
  return {
    channelPluginIds,
    configuredDeferredChannelPluginIds,
    pluginIds,
  };
}

export function resolveGatewayStartupPluginIdsFromRegistry(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  index: PluginRegistrySnapshot;
  manifestRegistry: PluginManifestRegistry;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
}): string[] {
  return [...resolveGatewayStartupPluginPlanFromRegistry(params).pluginIds];
}

export function loadGatewayStartupPluginPlan(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  index?: PluginRegistrySnapshot;
  metadataSnapshot?: PluginMetadataSnapshot;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
}): GatewayStartupPluginPlan {
  const snapshotConfig = params.activationSourceConfig ?? params.config;
  const pluginIdScope = createGatewayStartupMetadataPluginIdScope({
    config: params.config,
    ...(params.activationSourceConfig !== undefined
      ? { activationSourceConfig: params.activationSourceConfig }
      : {}),
    env: params.env,
    workerProviderIds: params.workerProviderIds ?? [],
    ...(params.platform !== undefined ? { platform: params.platform } : {}),
  });
  const metadataSnapshot =
    params.metadataSnapshot &&
    isPluginMetadataSnapshotCompatible({
      snapshot: params.metadataSnapshot,
      config: snapshotConfig,
      env: params.env,
      allowScopedSnapshot: true,
      workspaceDir: params.workspaceDir,
      index: params.index,
    }) &&
    isMetadataSnapshotScopedForGatewayStartup({
      metadataSnapshot: params.metadataSnapshot,
      pluginIdScope,
    })
      ? params.metadataSnapshot
      : resolvePluginMetadataSnapshot({
          config: snapshotConfig,
          workspaceDir: params.workspaceDir,
          env: params.env,
          allowWorkspaceScopedCurrent: params.workspaceDir === undefined,
          ...(params.index ? { index: params.index } : {}),
          pluginIdScope,
        });
  return resolveGatewayStartupPluginPlanFromRegistry({
    config: params.config,
    ...(params.activationSourceConfig !== undefined
      ? { activationSourceConfig: params.activationSourceConfig }
      : {}),
    env: params.env,
    index: metadataSnapshot.index,
    manifestRegistry: metadataSnapshot.manifestRegistry,
    workerProviderIds: params.workerProviderIds ?? [],
    platform: params.platform,
  });
}

export function resolveGatewayStartupPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
}): string[] {
  return [...loadGatewayStartupPluginPlan(params).pluginIds];
}
