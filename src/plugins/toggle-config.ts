// Toggles plugin enablement config for channels and agents.
import { normalizeChatChannelId } from "../channels/ids.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  mergePluginEntryAliases,
  normalizePluginId,
  normalizePluginTargetConfig,
} from "./config-state.js";

/** Returns config with a plugin enabled/disabled and optional built-in channel state synced. */
export function setPluginEnabledInConfig(
  config: OpenClawConfig,
  pluginId: string,
  enabled: boolean,
  options: { updateChannelConfig?: boolean } = {},
): OpenClawConfig {
  const builtInChannelId = normalizeChatChannelId(pluginId);
  const resolvedId = normalizePluginId(builtInChannelId ?? pluginId);
  const normalizedConfig = normalizePluginTargetConfig(config, resolvedId);
  const existingEntry = mergePluginEntryAliases(config, resolvedId);

  const next: OpenClawConfig = {
    ...normalizedConfig,
    plugins: {
      ...normalizedConfig.plugins,
      entries: {
        ...normalizedConfig.plugins?.entries,
        [resolvedId]: {
          ...existingEntry,
          enabled,
        },
      },
    },
  };

  if (!builtInChannelId || options.updateChannelConfig === false) {
    return next;
  }

  const channels = normalizedConfig.channels as Record<string, unknown> | undefined;
  const existing = channels?.[builtInChannelId];
  const existingRecord =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};

  return {
    ...next,
    channels: {
      ...normalizedConfig.channels,
      [builtInChannelId]: {
        ...existingRecord,
        enabled,
      },
    },
  };
}
