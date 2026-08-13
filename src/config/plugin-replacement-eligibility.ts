// Decides whether a plugin is eligible to replace another plugin's channel.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeChatChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function isPluginExplicitlyDisabled(cfg: OpenClawConfig, pluginId: string): boolean {
  const builtInChannelId = normalizeChatChannelId(pluginId);
  if (builtInChannelId) {
    const channels = cfg.channels as Record<string, unknown> | undefined;
    if (asOptionalRecord(channels?.[builtInChannelId])?.enabled === false) {
      return true;
    }
  }
  return cfg.plugins?.entries?.[pluginId]?.enabled === false;
}

export function isPluginDenied(cfg: OpenClawConfig, pluginId: string): boolean {
  const deny = cfg.plugins?.deny;
  return Array.isArray(deny) && deny.includes(pluginId);
}

/**
 * Whether a plugin may take a channel from the plugin it declares in `preferOver`. Auto-enable
 * ignores a denied or explicitly disabled replacement and activates the fallback instead, so
 * schema ownership must apply the same filter — otherwise validation checks the fallback's config
 * against the disabled replacement's schema and rejects a valid setup.
 */
export function canPluginReplaceChannelOwner(cfg: OpenClawConfig, pluginId: string): boolean {
  return !isPluginDenied(cfg, pluginId) && !isPluginExplicitlyDisabled(cfg, pluginId);
}
