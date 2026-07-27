// Resolves plugin enablement state from config and channel context.
import { normalizeChatChannelId } from "../channels/ids.js";
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setPluginEnabledInConfig } from "./toggle-config.js";

type PluginEnableOptions = {
  updateChannelConfig?: boolean;
};

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
  options: PluginEnableOptions = {},
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

/**
 * Enables a plugin selected through an explicit user action.
 *
 * ClickClack is bundled without a separate install trust record, so selecting
 * it is the trust gesture that materializes its id in a restrictive allowlist.
 */
export function enableExplicitlySelectedPluginInConfig(
  cfg: OpenClawConfig,
  pluginId: string,
  options: PluginEnableOptions = {},
): PluginEnableResult {
  const result = enablePluginInConfig(cfg, pluginId, options);
  if (result.reason !== "blocked by allowlist" || result.pluginId !== "clickclack") {
    return result;
  }
  return enablePluginInConfig(
    ensurePluginAllowlisted(cfg, result.pluginId),
    result.pluginId,
    options,
  );
}
