// Plugin/channel activation config merge helpers.
// Carries activation enablement into runtime config without copying stale state.
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { isRecord } from "../utils.js";

// Activation config carries only operator-controlled enable/allow surfaces into
// runtime config. Other runtime fields stay canonical to avoid stale activation
// state overriding live config reloads.
function hasOwnValue(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function mergeChannelActivationSections(params: {
  runtimeConfig: OpenClawConfig;
  activationConfig: OpenClawConfig;
}): OpenClawConfig {
  const activationChannels = params.activationConfig.channels;
  if (!isRecord(activationChannels)) {
    return params.runtimeConfig;
  }

  const runtimeChannels = isRecord(params.runtimeConfig.channels)
    ? params.runtimeConfig.channels
    : {};
  let nextChannels: Record<string, unknown> | undefined;

  for (const [channelId, activationChannel] of Object.entries(activationChannels)) {
    if (!isRecord(activationChannel) || !hasOwnValue(activationChannel, "enabled")) {
      continue;
    }
    const runtimeChannel = runtimeChannels[channelId];
    const runtimeChannelRecord = isRecord(runtimeChannel) ? runtimeChannel : {};
    nextChannels ??= { ...runtimeChannels };
    nextChannels[channelId] = {
      ...runtimeChannelRecord,
      enabled: activationChannel.enabled,
    };
  }

  if (nextChannels === undefined) {
    return params.runtimeConfig;
  }
  return {
    ...params.runtimeConfig,
    channels: nextChannels as OpenClawConfig["channels"],
  };
}

function mergePluginActivationSections(params: {
  runtimeConfig: OpenClawConfig;
  activationConfig: OpenClawConfig;
}): OpenClawConfig {
  const activationPlugins = params.activationConfig.plugins;
  if (!isRecord(activationPlugins)) {
    return params.runtimeConfig;
  }

  const runtimePlugins = isRecord(params.runtimeConfig.plugins) ? params.runtimeConfig.plugins : {};
  let nextPlugins: Record<string, unknown> | undefined;

  if (Array.isArray(activationPlugins.allow)) {
    nextPlugins = {
      ...runtimePlugins,
      allow: [...activationPlugins.allow],
    };
  }

  const activationEntries = activationPlugins.entries;
  if (isRecord(activationEntries)) {
    const runtimeEntries = isRecord(runtimePlugins.entries) ? runtimePlugins.entries : {};
    let nextEntries: Record<string, unknown> | undefined;
    for (const [pluginId, activationEntry] of Object.entries(activationEntries)) {
      if (!isRecord(activationEntry) || !hasOwnValue(activationEntry, "enabled")) {
        continue;
      }
      const runtimeEntry = runtimeEntries[pluginId];
      const runtimeEntryRecord = isRecord(runtimeEntry) ? runtimeEntry : {};
      nextEntries ??= { ...runtimeEntries };
      nextEntries[pluginId] = {
        ...runtimeEntryRecord,
        enabled: activationEntry.enabled,
      };
    }
    if (nextEntries !== undefined) {
      nextPlugins = {
        ...runtimePlugins,
        ...nextPlugins,
        entries: nextEntries,
      };
    }
  }

  if (nextPlugins === undefined) {
    return params.runtimeConfig;
  }
  return {
    ...params.runtimeConfig,
    plugins: nextPlugins as OpenClawConfig["plugins"],
  };
}

/** Merges plugin/channel activation enablement into the runtime config shape. */
export function mergeActivationSectionsIntoRuntimeConfig(params: {
  runtimeConfig: OpenClawConfig;
  activationConfig: OpenClawConfig;
}): OpenClawConfig {
  return mergePluginActivationSections({
    ...params,
    runtimeConfig: mergeChannelActivationSections(params),
  });
}

// Resolves the effective plugin config the gateway startup *plan* is built from:
// auto-enable the operator activation source, then merge those activation sections into
// the runtime config (so runtime/defaulted fields survive). This is the exact assembly
// `prepareGatewayPluginBootstrap` uses (non-minimal branch); sharing it keeps any consumer
// that recomputes the startup plan — notably the `/status plugins` should-run drift check —
// from drifting away from real gateway boot. Behavior-preserving extraction only.
export function resolveGatewayStartupPluginActivationConfig(params: {
  runtimeConfig: OpenClawConfig;
  activationSourceConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
  discovery?: PluginDiscoveryResult;
}): OpenClawConfig {
  return mergeActivationSectionsIntoRuntimeConfig({
    runtimeConfig: params.runtimeConfig,
    activationConfig: applyPluginAutoEnable({
      config: params.activationSourceConfig,
      env: params.env,
      ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
      discovery: params.discovery,
    }).config,
  });
}

/** Re-derives source-owned plugin activation and carries it into one reload candidate. */
export function resolveGatewayReloadPluginActivationCandidate(params: {
  runtimeConfig: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
  discovery?: PluginDiscoveryResult;
}): { runtimeConfig: OpenClawConfig; compareConfig: OpenClawConfig } {
  const activationConfig = applyPluginAutoEnable({
    config: params.sourceConfig,
    env: params.env,
    ...(params.manifestRegistry ? { manifestRegistry: params.manifestRegistry } : {}),
    discovery: params.discovery,
  }).config;
  return {
    runtimeConfig: mergeActivationSectionsIntoRuntimeConfig({
      runtimeConfig: params.runtimeConfig,
      activationConfig,
    }),
    compareConfig: activationConfig,
  };
}
