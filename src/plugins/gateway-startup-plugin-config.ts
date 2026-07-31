// Collects configured startup channels, slots, paths, and validation references.
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import {
  listExplicitlyDisabledChannelIdsForConfig,
  listPotentialConfiguredChannelIds,
  type AmbientEnvTriggerPolicy,
} from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_MEMORY_DREAMING_PLUGIN_ID,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingPluginId,
} from "../memory-host-sdk/dreaming.js";
import { readBundledDiscoveryMode } from "./bundled-discovery-state.js";
import { listExplicitConfiguredChannelIdsForConfig } from "./channel-presence-policy.js";
import { collectPluginConfigContractMatches } from "./config-contracts.js";
import { normalizePluginsConfigWithResolver } from "./config-normalization-shared.js";
import { resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import type {
  ManifestRegistryLookup,
  NormalizedPluginsConfig,
} from "./gateway-startup-plugin-contracts.js";
import { sortUniquePluginIds } from "./gateway-startup-plugin-contracts.js";
import {
  collectConfiguredGenerationProviderIds,
  collectConfiguredMemoryEmbeddingProviderIds,
  collectConfiguredVoiceProviderIds,
  collectConfiguredWebSearchProviderIds,
} from "./gateway-startup-plugin-providers.js";
import { collectConfiguredSpeechProviderIds } from "./gateway-startup-speech-providers.js";
import type { InstalledPluginIndexScopeLookup } from "./installed-plugin-index-scope-lookup.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { normalizePluginsConfigWithRegistry } from "./plugin-registry-contributions.js";

export function readStartupBundledDiscoveryMode(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): "compat" | "allowlist" | undefined {
  const stateMode = readBundledDiscoveryMode({ env });
  if (stateMode) {
    return stateMode;
  }
  // Bootstrap Doctor with the raw legacy marker before it has been imported
  // into SQLite; steady-state runtime consumers use machine state only.
  const legacyMode = (config.plugins as { bundledDiscovery?: unknown } | undefined)
    ?.bundledDiscovery;
  if (legacyMode === "compat" || legacyMode === "allowlist") {
    return legacyMode;
  }
  return undefined;
}
export function normalizePluginsConfigForInstalledIndex(
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

export function listPotentialEnabledChannelIds(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  ambientEnvTriggers: AmbientEnvTriggerPolicy = "allow",
): string[] {
  const disabled = new Set(listExplicitlyDisabledChannelIdsForConfig(config));
  return sortUniquePluginIds([
    ...listPotentialConfiguredChannelIds(config, env, {
      includePersistedAuthState: false,
      ambientEnvTriggers,
    }),
    ...listExplicitConfiguredChannelIdsForConfig(config),
  ])
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

export function blocksPluginStartup(params: {
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

export function resolveAuthorizedGatewayStartupDreamingPluginIds(params: {
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

export function resolveMemorySlotStartupPluginId(params: {
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

export function resolveContextEngineSlotStartupPluginId(params: {
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

export function shouldConsiderForGatewayStartup(params: {
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

export function hasConfiguredStartupChannel(params: {
  plugin: InstalledPluginIndexRecord;
  manifestLookup: ManifestRegistryLookup;
  configuredChannelIds: ReadonlySet<string>;
}): boolean {
  return listManifestChannelIds(params.manifestLookup, params.plugin.pluginId).some((channelId) =>
    params.configuredChannelIds.has(channelId),
  );
}

export function createManifestRegistryLookup(
  manifestRegistry: PluginManifestRegistry,
): ManifestRegistryLookup {
  return new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin]));
}

export function listManifestChannelIds(
  manifestLookup: ManifestRegistryLookup,
  pluginId: string,
): readonly string[] {
  return manifestLookup.get(pluginId)?.channels ?? [];
}

export function findManifestPlugin(
  manifestLookup: ManifestRegistryLookup,
  pluginId: string,
): PluginManifestRecord | undefined {
  return manifestLookup.get(pluginId);
}

export function hasConfiguredActivationPath(params: {
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

export function addConfiguredActivationPathPluginIds(
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

export function addPluginConfigEntryIds(
  target: Set<string>,
  plugins: ReturnType<typeof normalizePluginsConfigForInstalledIndex>,
): void {
  for (const [pluginId, entry] of Object.entries(plugins.entries)) {
    if (entry?.enabled !== false) {
      target.add(pluginId);
    }
  }
}

export function addConfiguredSlotPluginIds(
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

export function collectConfiguredStartupChannelIds(params: {
  activationSourceConfig: OpenClawConfig;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): string[] {
  return sortUniquePluginIds([
    ...listPotentialEnabledChannelIds(params.config, params.env, params.ambientEnvTriggers),
    ...listPotentialEnabledChannelIds(
      params.activationSourceConfig,
      params.env,
      params.ambientEnvTriggers,
    ),
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
  for (const agent of listAgentEntries(config)) {
    pushTarget(agent?.heartbeat?.target);
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

export function collectConfigValidationChannelIds(params: {
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

export function collectConfiguredProviderIds(config: OpenClawConfig): string[] {
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

export function collectValidationConfiguredProviderIds(config: OpenClawConfig): string[] {
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

export function collectValidationConfiguredShorthandModelIds(config: OpenClawConfig): string[] {
  return sortUniquePluginIds(
    collectConfiguredModelRefs(config)
      .map((ref) => ref.value)
      .filter((ref) => !ref.includes("/"))
      .map((ref) => splitTrailingAuthProfile(ref).model.trim())
      .filter(Boolean),
  );
}
