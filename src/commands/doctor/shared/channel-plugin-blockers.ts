import { listPotentialConfiguredChannelIds } from "../../../channels/config-presence.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "../../../plugins/config-state.js";
import { loadPluginManifestRegistry } from "../../../plugins/manifest-registry.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";

export type ChannelPluginBlockerHit = {
  channelId: string;
  pluginId: string;
  reason: "disabled in config" | "plugins disabled";
};

export function scanConfiguredChannelPluginBlockers(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): ChannelPluginBlockerHit[] {
  const configuredChannelIds = new Set(
    listPotentialConfiguredChannelIds(cfg, env).map((id) => id.trim()),
  );
  if (configuredChannelIds.size === 0) {
    return [];
  }

  const pluginsConfig = normalizePluginsConfig(cfg.plugins);
  const registry = loadPluginManifestRegistry({
    config: cfg,
    env,
  });
  const hits: ChannelPluginBlockerHit[] = [];

  for (const plugin of registry.plugins) {
    if (plugin.channels.length === 0) {
      continue;
    }

    const activationState = resolveEffectivePluginActivationState({
      id: plugin.id,
      origin: plugin.origin,
      config: pluginsConfig,
      rootConfig: cfg,
      enabledByDefault: plugin.enabledByDefault,
    });
    if (
      activationState.activated ||
      !activationState.reason ||
      (activationState.reason !== "disabled in config" &&
        activationState.reason !== "plugins disabled")
    ) {
      continue;
    }

    for (const channelId of plugin.channels) {
      if (!configuredChannelIds.has(channelId)) {
        continue;
      }
      hits.push({
        channelId,
        pluginId: plugin.id,
        reason: activationState.reason,
      });
    }
  }

  return hits;
}

function formatReason(hit: ChannelPluginBlockerHit): string {
  if (hit.reason === "disabled in config") {
    return `plugin "${sanitizeForLog(hit.pluginId)}" is disabled by plugins.entries.${sanitizeForLog(hit.pluginId)}.enabled=false.`;
  }
  if (hit.reason === "plugins disabled") {
    return `plugins.enabled=false blocks channel plugins globally.`;
  }
  return `plugin "${sanitizeForLog(hit.pluginId)}" is not loadable (${sanitizeForLog(hit.reason)}).`;
}

export function collectConfiguredChannelPluginBlockerWarnings(
  hits: ChannelPluginBlockerHit[],
): string[] {
  return hits.map(
    (hit) =>
      `- channels.${sanitizeForLog(hit.channelId)}: channel is configured, but ${formatReason(hit)} Fix plugin enablement before relying on setup guidance for this channel.`,
  );
}

export function isWarningBlockedByChannelPlugin(
  warning: string,
  hits: ChannelPluginBlockerHit[],
): boolean {
  return hits.some((hit) => {
    const prefix = `channels.${sanitizeForLog(hit.channelId)}`;
    return warning.includes(`${prefix}:`) || warning.includes(`${prefix}.`);
  });
}
