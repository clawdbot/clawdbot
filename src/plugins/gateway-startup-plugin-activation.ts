import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
// Applies plugin activation policy to configured startup candidates.
import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasExplicitChannelConfig } from "./channel-presence-policy.js";
import { resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import {
  blocksPluginStartup,
  hasConfiguredActivationPath,
  listManifestChannelIds,
  normalizePluginsConfigForInstalledIndex,
} from "./gateway-startup-plugin-config.js";
import type {
  ConfiguredGenerationProviderIds,
  ConfiguredVoiceProviderIds,
  ManifestRegistryLookup,
  NormalizedPluginsConfig,
} from "./gateway-startup-plugin-contracts.js";
import {
  manifestOwnsConfiguredModelProvider,
  manifestOwnsConfiguredSpeechProvider,
  manifestOwnsConfiguredWebSearchProvider,
} from "./gateway-startup-plugin-providers.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { normalizePluginsConfigWithRegistry } from "./plugin-registry-contributions.js";
import { manifestOwnsWorkerProvider } from "./worker-provider-registry.js";

export function addRequiredAgentHarnessPluginIds(
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

export function canStartConfiguredGenerationProviderPlugin(params: {
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

export function canStartConfiguredVoiceProviderPlugin(params: {
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

export function canStartConfiguredMemoryEmbeddingProviderPlugin(params: {
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

export function canStartConfiguredWorkerProviderPlugin(params: {
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

export function canStartConfiguredModelProviderPlugin(params: {
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

export function canStartRequiredAgentHarnessPlugin(params: {
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

export function canStartConfiguredSpeechProviderPlugin(params: {
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

export function canStartConfiguredWebSearchProviderPlugin(params: {
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

export function canStartConfiguredRootPlugin(params: {
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

export function canStartExplicitHookPlugin(params: {
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

export function canStartTrustedToolPolicyPlugin(params: {
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

export function canStartConfiguredChannelPlugin(params: {
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
