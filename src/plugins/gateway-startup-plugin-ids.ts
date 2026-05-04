import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
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
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { hasExplicitChannelConfig } from "./channel-presence-policy.js";
import { collectPluginConfigContractMatches } from "./config-contracts.js";
import { resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import {
  collectConfiguredSpeechProviderIds,
  normalizeConfiguredSpeechProviderIdForStartup,
} from "./gateway-startup-speech-providers.js";
import type { InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import {
  isPluginMetadataSnapshotCompatible,
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import {
  createPluginRegistryIdNormalizer,
  normalizePluginsConfigWithRegistry,
} from "./plugin-registry-contributions.js";
import type { PluginRegistrySnapshot } from "./plugin-registry-snapshot.js";

export type GatewayStartupPluginPlan = {
  channelPluginIds: readonly string[];
  configuredDeferredChannelPluginIds: readonly string[];
  pluginIds: readonly string[];
};

type NormalizedPluginsConfig = ReturnType<typeof normalizePluginsConfigWithRegistry>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
  const paths = params.manifest?.activation?.onConfigPaths;
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
  return params.index.plugins
    .filter(
      (plugin) =>
        hasConfiguredStartupChannel({
          plugin,
          manifestLookup,
          configuredChannelIds,
        }) &&
        plugin.startup.deferConfiguredChannelFullLoadUntilAfterListen &&
        canStartConfiguredChannelPlugin({
          plugin,
          config: params.config,
          pluginsConfig,
          activationSource,
          manifestLookup,
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
  const configuredDeferredChannelPluginIds = resolveConfiguredDeferredChannelPluginIdsFromRegistry({
    config: params.config,
    env: params.env,
    index: params.index,
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
  const requiredAgentHarnessRuntimes = new Set(
    collectConfiguredAgentHarnessRuntimes(activationSourceConfig, params.env),
  );
  const startupDreamingPluginIds = resolveGatewayStartupDreamingPluginIds(params.config);
  const manifestLookup = createManifestRegistryLookup(params.manifestRegistry);
  const configuredSpeechProviderIds = collectConfiguredSpeechProviderIds(activationSourceConfig);
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
  const pluginIds = params.index.plugins
    .filter((plugin) => {
      const manifest = findManifestPlugin(manifestLookup, plugin.pluginId);
      if (
        hasConfiguredStartupChannel({
          plugin,
          manifestLookup,
          configuredChannelIds,
        })
      ) {
        return canStartConfiguredChannelPlugin({
          plugin,
          config: params.config,
          pluginsConfig,
          activationSource,
          manifestLookup,
          platform: params.platform,
        });
      }
      if (
        plugin.startup.agentHarnesses.some((runtime) => requiredAgentHarnessRuntimes.has(runtime))
      ) {
        const activationState = resolveEffectivePluginActivationState({
          id: plugin.pluginId,
          origin: plugin.origin,
          config: pluginsConfig,
          rootConfig: params.config,
          enabledByDefault: isPluginEnabledByDefaultForPlatform(plugin, params.platform),
          activationSource,
        });
        return activationState.enabled;
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
        return true;
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
        return true;
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
        return true;
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
        return false;
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
        return false;
      }
      if (plugin.origin !== "bundled") {
        return activationState.explicitlyEnabled;
      }
      return activationState.source === "explicit" || activationState.source === "default";
    })
    .map((plugin) => plugin.pluginId);
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
  const metadataSnapshot =
    params.metadataSnapshot &&
    isPluginMetadataSnapshotCompatible({
      snapshot: params.metadataSnapshot,
      config: snapshotConfig,
      env: params.env,
      workspaceDir: params.workspaceDir,
      index: params.index,
    })
      ? params.metadataSnapshot
      : loadPluginMetadataSnapshot({
          config: snapshotConfig,
          workspaceDir: params.workspaceDir,
          env: params.env,
          ...(params.index ? { index: params.index } : {}),
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
