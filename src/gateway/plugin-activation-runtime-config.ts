import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";

function hasOwnValue(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
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

export function mergeActivationSectionsIntoRuntimeConfig(params: {
  runtimeConfig: OpenClawConfig;
  activationConfig: OpenClawConfig;
}): OpenClawConfig {
  return mergePluginActivationSections({
    ...params,
    runtimeConfig: mergeChannelActivationSections(params),
  });
}
