import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { buildModelCatalogMergeKey } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
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
const CORE_BUILT_IN_MODEL_APIS = new Set([
  "anthropic-messages",
  "azure-openai-responses",
  "google-generative-ai",
  "google-vertex",
  "mistral-conversations",
  "openai-chatgpt-responses",
  "openai-completions",
  "openai-responses",
]);

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

function resolveGatewayStartupDreamingPluginIds(config: OpenClawConfig): Set<string> {
  const dreamingConfig = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(config),
    cfg: config,
  });
  if (!dreamingConfig.enabled) {
    return new Set();
  }
  return new Set([DEFAULT_MEMORY_DREAMING_PLUGIN_ID, resolveMemoryDreamingPluginId(config)]);
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
    .map((ref) => {
      const slashIndex = ref.indexOf("/");
      if (slashIndex <= 0 || slashIndex >= ref.length - 1) {
        return undefined;
      }
      return {
        providerId: normalizeProviderId(ref.slice(0, slashIndex)),
        modelId: ref.slice(slashIndex + 1).trim(),
      };
    })
    .filter((entry): entry is { providerId: string; modelId: string } =>
      Boolean(entry?.providerId && entry.modelId),
    );
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
  addModelMapProviderIds(defaults?.models);

  const agents = Array.isArray(config.agents?.list) ? config.agents.list : [];
  for (const agent of agents) {
    if (!isRecord(agent)) {
      continue;
    }
    addModelProviderRefs(agent.model);
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

  addConfiguredSlotPluginIds(scope, {
    activationSourceConfig,
    activationSourcePlugins,
    lookup,
  });
  for (const pluginId of resolveGatewayStartupDreamingPluginIds(params.config)) {
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
  platform?: NodeJS.Platform;
}): PluginMetadataSnapshotPluginIdScope {
  const configuredChannelIds = collectConfiguredStartupChannelIds({
    config: params.config,
    activationSourceConfig: params.activationSourceConfig ?? params.config,
    env: params.env,
  });
  return {
    key: hashJson({
      kind: "gateway-startup",
      config: params.config,
      activationSourceConfig: params.activationSourceConfig ?? null,
      configuredChannelIds,
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
  return activationState.enabled;
}

function canStartConfiguredRootPlugin(params: {
  plugin: InstalledPluginIndexRecord;
  manifest: PluginManifestRecord | undefined;
  config: OpenClawConfig;
  pluginsConfig: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  activationSourcePlugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
}): boolean {
  if (params.plugin.origin !== "bundled") {
    return false;
  }
  if (!hasConfiguredActivationPath({ manifest: params.manifest, config: params.config })) {
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
  return true;
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
  const configuredDeferredChannelPluginIds: string[] = [];
  const requiredAgentHarnessRuntimes = new Set(
    collectConfiguredAgentHarnessRuntimes(activationSourceConfig),
  );
  const startupDreamingPluginIds = resolveGatewayStartupDreamingPluginIds(params.config);
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
  const normalizePluginId = createPluginRegistryIdNormalizer(params.index, {
    manifestRegistry: params.manifestRegistry,
  });
  const memorySlotStartupPluginId = resolveMemorySlotStartupPluginId({
    activationSourceConfig,
    activationSourcePlugins,
    normalizePluginId,
  });
  const contextEngineSlotStartupPluginId = resolveContextEngineSlotStartupPluginId({
    activationSourceConfig,
    activationSourcePlugins,
    normalizePluginId,
  });
  const pluginIds: string[] = [];
  for (const plugin of params.index.plugins) {
    const manifest = findManifestPlugin(manifestLookup, plugin.pluginId);
    if (
      hasConfiguredStartupChannel({
        plugin,
        manifestLookup,
        configuredChannelIds,
      })
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
        config: activationSourceConfig,
        pluginsConfig,
        activationSourcePlugins,
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
  platform?: NodeJS.Platform;
}): GatewayStartupPluginPlan {
  const snapshotConfig = params.activationSourceConfig ?? params.config;
  const pluginIdScope = createGatewayStartupMetadataPluginIdScope({
    config: params.config,
    ...(params.activationSourceConfig !== undefined
      ? { activationSourceConfig: params.activationSourceConfig }
      : {}),
    env: params.env,
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
    platform: params.platform,
  });
}

export function resolveGatewayStartupPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): string[] {
  return [...loadGatewayStartupPluginPlan(params).pluginIds];
}
