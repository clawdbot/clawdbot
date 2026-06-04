// Resolves plugin enablement state from config and channel context.
import { normalizeChatChannelId } from "../channels/ids.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setPluginEnabledInConfig } from "./toggle-config.js";

/** Result of enabling a plugin in config. */
export type PluginEnableResult = {
  config: OpenClawConfig;
  enabled: boolean;
  pluginId: string;
  reason?: string;
};

/** Enables a plugin in config unless global, denylist, or allowlist policy blocks it. */
export function enablePluginInConfig(
  cfg: OpenClawConfig,
  pluginId: string,
  options: { updateChannelConfig?: boolean } = {},
): PluginEnableResult {
  const builtInChannelId = normalizeChatChannelId(pluginId);
  const resolvedId = builtInChannelId ?? pluginId;
  if (cfg.plugins?.enabled === false) {
    return { config: cfg, enabled: false, pluginId: resolvedId, reason: "plugins disabled" };
  }
  if (cfg.plugins?.deny?.includes(pluginId) || cfg.plugins?.deny?.includes(resolvedId)) {
    return { config: cfg, enabled: false, pluginId: resolvedId, reason: "blocked by denylist" };
  }
  const allow = cfg.plugins?.allow;
  if (
    Array.isArray(allow) &&
    allow.length > 0 &&
    !allow.includes(pluginId) &&
    !allow.includes(resolvedId)
  ) {
    return { config: cfg, enabled: false, pluginId: resolvedId, reason: "blocked by allowlist" };
  }
  return {
    config: setPluginEnabledInConfig(cfg, resolvedId, true, options),
    enabled: true,
    pluginId: resolvedId,
  };
}
