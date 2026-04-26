import { collectConfiguredAgentHarnessRuntimes } from "../agents/harness-runtimes.js";
import { listPotentialConfiguredChannelIds } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_MEMORY_DREAMING_PLUGIN_ID,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingPluginId,
} from "../memory-host-sdk/dreaming.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { hasExplicitChannelConfig } from "./channel-presence-policy.js";
import { resolveEffectivePluginActivationState } from "./config-state.js";
import type { InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";
import {
  createPluginRegistryIdNormalizer,
  loadPluginRegistrySnapshot,
  normalizePluginsConfigWithRegistry,
} from "./plugin-registry.js";

function listDisabledChannelIds(config: OpenClawConfig): Set<string> {
  const channels = config.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return new Set();
  }
  return new Set(
    Object.entries(channels)
      .filter(([, value]) => {
        return (
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          (value as { enabled?: unknown }).enabled === false
        );
      })
      .map(([channelId]) => normalizeOptionalLowercaseString(channelId))
      .filter((channelId): channelId is string => Boolean(channelId)),
  );
}

function listPotentialEnabledChannelIds(config: OpenClawConfig, env: NodeJS.ProcessEnv): string[] {
  const disabled = listDisabledChannelIds(config);
  return listPotentialConfiguredChannelIds(config, env, { includePersistedAuthState: false })
    .map((id) => normalizeOptionalLowercaseString(id) ?? "")
    .filter((id) => id && !disabled.has(id));
}

function isGatewayStartupMemoryPlugin(plugin: InstalledPluginIndexRecord): boolean {
  return plugin.startup.memory;
}

function isGatewayStartupSidecar(plugin: InstalledPluginIndexRecord): boolean {
  return plugin.startup.sidecar;
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

function resolveExplicitMemorySlotStartupPluginId(
  config: OpenClawConfig,
  normalizePluginId: (pluginId: string) => string,
): string | undefined {
  const configuredSlot = config.plugins?.slots?.memory?.trim();
  if (!configuredSlot || configuredSlot.toLowerCase() === "none") {
    return undefined;
  }
  return normalizePluginId(configuredSlot);
}

function shouldConsiderForGatewayStartup(params: {
  plugin: InstalledPluginIndexRecord;
  startupDreamingPluginIds: ReadonlySet<string>;
  explicitMemorySlotStartupPluginId?: string;
}): boolean {
  if (isGatewayStartupSidecar(params.plugin)) {
    return true;
  }
  if (!isGatewayStartupMemoryPlugin(params.plugin)) {
    return false;
  }
  if (params.startupDreamingPluginIds.has(params.plugin.pluginId)) {
    return true;
  }
  return params.explicitMemorySlotStartupPluginId === params.plugin.pluginId;
}

function hasConfiguredStartupChannel(params: {
  plugin: InstalledPluginIndexRecord;
  manifestRegistry: PluginManifestRegistry;
  configuredChannelIds: ReadonlySet<string>;
}): boolean {
  return listManifestChannelIds(params.manifestRegistry, params.plugin.pluginId).some((channelId) =>
    params.configuredChannelIds.has(channelId),
  );
}

function listManifestChannelIds(
  manifestRegistry: PluginManifestRegistry,
  pluginId: string,
): readonly string[] {
  return manifestRegistry.plugins.find((plugin) => plugin.id === pluginId)?.channels ?? [];
}

function canStartConfiguredChannelPlugin(params: {
  plugin: InstalledPluginIndexRecord;
  config: OpenClawConfig;
  pluginsConfig: ReturnType<typeof normalizePluginsConfigWithRegistry>;
  activationSource: {
    plugins: ReturnType<typeof normalizePluginsConfigWithRegistry>;
    rootConfig?: OpenClawConfig;
  };
  manifestRegistry: PluginManifestRegistry;
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
    listManifestChannelIds(params.manifestRegistry, params.plugin.pluginId).some((channelId) =>
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
    enabledByDefault: params.plugin.enabledByDefault,
    activationSource: params.activationSource,
  });
  return activationState.enabled && activationState.explicitlyEnabled;
}

export function resolveChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const index = loadPluginRegistrySnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
    index,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeDisabled: true,
  });
  return manifestRegistry.plugins
    .filter((plugin) => plugin.channels.length > 0)
    .map((plugin) => plugin.id);
}

export function resolveConfiguredDeferredChannelPluginIds(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const configuredChannelIds = new Set(listPotentialEnabledChannelIds(params.config, params.env));
  if (configuredChannelIds.size === 0) {
    return [];
  }
  const index = loadPluginRegistrySnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const pluginsConfig = normalizePluginsConfigWithRegistry(params.config.plugins, index);
  const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
    index,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeDisabled: true,
  });
  const activationSource = {
    plugins: pluginsConfig,
    rootConfig: params.config,
  };
  return index.plugins
    .filter(
      (plugin) =>
        hasConfiguredStartupChannel({ plugin, manifestRegistry, configuredChannelIds }) &&
        plugin.startup.deferConfiguredChannelFullLoadUntilAfterListen &&
        canStartConfiguredChannelPlugin({
          plugin,
          config: params.config,
          pluginsConfig,
          activationSource,
          manifestRegistry,
        }),
    )
    .map((plugin) => plugin.pluginId);
}

export function resolveGatewayStartupPluginIds(params: {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const configuredChannelIds = new Set(listPotentialEnabledChannelIds(params.config, params.env));
  const index = loadPluginRegistrySnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const pluginsConfig = normalizePluginsConfigWithRegistry(params.config.plugins, index);
  const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
    index,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    includeDisabled: true,
  });
  // Startup must classify allowlist exceptions against the raw config snapshot,
  // not the auto-enabled effective snapshot, or configured-only channels can be
  // misclassified as explicit enablement.
  const activationSourceConfig = params.activationSourceConfig ?? params.config;
  const activationSource = {
    plugins: normalizePluginsConfigWithRegistry(activationSourceConfig.plugins, index),
    rootConfig: activationSourceConfig,
  };
  const requiredAgentHarnessRuntimes = new Set(
    collectConfiguredAgentHarnessRuntimes(activationSourceConfig, params.env),
  );
  const startupDreamingPluginIds = resolveGatewayStartupDreamingPluginIds(params.config);
  const explicitMemorySlotStartupPluginId = resolveExplicitMemorySlotStartupPluginId(
    activationSourceConfig,
    createPluginRegistryIdNormalizer(index),
  );
  return index.plugins
    .filter((plugin) => {
      if (hasConfiguredStartupChannel({ plugin, manifestRegistry, configuredChannelIds })) {
        return canStartConfiguredChannelPlugin({
          plugin,
          config: params.config,
          pluginsConfig,
          activationSource,
          manifestRegistry,
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
          enabledByDefault: plugin.enabledByDefault,
          activationSource,
        });
        return activationState.enabled;
      }
      if (
        !shouldConsiderForGatewayStartup({
          plugin,
          startupDreamingPluginIds,
          explicitMemorySlotStartupPluginId,
        })
      ) {
        return false;
      }
      const activationState = resolveEffectivePluginActivationState({
        id: plugin.pluginId,
        origin: plugin.origin,
        config: pluginsConfig,
        rootConfig: params.config,
        enabledByDefault: plugin.enabledByDefault,
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
}
