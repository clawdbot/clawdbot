import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
// Plans deterministic Gateway startup plugin activation from prepared registry metadata.
import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import {
  listExplicitlyDisabledChannelIdsForConfig,
  type AmbientEnvTriggerPolicy,
} from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEffectivePluginActivationState } from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import {
  canStartConfiguredChannelPlugin,
  canStartConfiguredGenerationProviderPlugin,
  canStartConfiguredMemoryEmbeddingProviderPlugin,
  canStartConfiguredModelProviderPlugin,
  canStartConfiguredRootPlugin,
  canStartConfiguredSpeechProviderPlugin,
  canStartConfiguredVoiceProviderPlugin,
  canStartConfiguredWebSearchProviderPlugin,
  canStartConfiguredWorkerProviderPlugin,
  canStartExplicitHookPlugin,
  canStartRequiredAgentHarnessPlugin,
  canStartTrustedToolPolicyPlugin,
} from "./gateway-startup-plugin-activation.js";
import {
  hasConfiguredStartupChannel,
  listPotentialEnabledChannelIds,
  resolveAuthorizedGatewayStartupDreamingPluginIds,
  resolveContextEngineSlotStartupPluginId,
  resolveMemorySlotStartupPluginId,
  shouldConsiderForGatewayStartup,
  createManifestRegistryLookup,
  findManifestPlugin,
} from "./gateway-startup-plugin-config.js";
import type {
  GatewayStartupPluginPlan,
  ManifestRegistryLookup,
} from "./gateway-startup-plugin-contracts.js";
import {
  collectConfiguredAgentModelProviderIds,
  collectConfiguredGenerationProviderIds,
  collectConfiguredMemoryEmbeddingProviderIds,
  collectConfiguredVoiceProviderIds,
  collectConfiguredWebSearchProviderIds,
} from "./gateway-startup-plugin-providers.js";
import { collectConfiguredSpeechProviderIds } from "./gateway-startup-speech-providers.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import {
  createPluginRegistryIdNormalizer,
  normalizePluginsConfigWithRegistry,
} from "./plugin-registry-contributions.js";
import type { PluginRegistrySnapshot } from "./plugin-registry-snapshot.js";
import {
  collectConfiguredWorkerProviderIds,
  normalizeWorkerProviderIds,
} from "./worker-provider-registry.js";

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
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): string[] {
  const configuredChannelIds = new Set(
    listPotentialEnabledChannelIds(params.config, params.env, params.ambientEnvTriggers),
  );
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

export function resolveGatewayStartupPluginPlanFromRegistry(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  index: PluginRegistrySnapshot;
  manifestRegistry: PluginManifestRegistry;
  workerProviderIds?: readonly string[];
  platform?: NodeJS.Platform;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): GatewayStartupPluginPlan {
  const channelPluginIds = resolveChannelPluginIdsFromRegistry({
    manifestRegistry: params.manifestRegistry,
  });
  const configuredChannelIds = new Set(
    listPotentialEnabledChannelIds(params.config, params.env, params.ambientEnvTriggers),
  );
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
