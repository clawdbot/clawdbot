// Toggles plugin enablement config for channels and agents.
import { normalizeChatChannelId } from "../channels/ids.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginEntryConfig } from "../config/types.plugins.js";
import { mergeDeep } from "../infra/deep-merge.js";
import { normalizePluginId, normalizePluginTargetConfig } from "./config-state.js";

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
  let existingEntry: PluginEntryConfig = {};
  // Fold aliases first and the canonical entry last so duplicate config keeps
  // every nested setting while canonical values win independent of file order.
  const existingEntries = Object.entries(config.plugins?.entries ?? {})
    .filter(([entryId]) => normalizePluginId(entryId) === resolvedId)
    .toSorted(([leftId], [rightId]) => {
      if (leftId === resolvedId) {
        return rightId === resolvedId ? 0 : 1;
      }
      if (rightId === resolvedId) {
        return -1;
      }
      return leftId.localeCompare(rightId, "en");
    });
  for (const [, entry] of existingEntries) {
    existingEntry = mergeDeep(existingEntry, entry) as PluginEntryConfig;
  }

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
