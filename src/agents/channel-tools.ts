import { getChannelDock } from "../channels/dock.js";
import { getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
import type { ChannelAgentTool, ChannelMessageActionName } from "../channels/plugins/types.js";
import type { MoltbotConfig } from "../config/config.js";

/**
 * Get the list of supported message actions for a specific channel.
 * Returns an empty array if channel is not found or has no actions configured.
 */
export function listChannelSupportedActions(params: {
  cfg?: MoltbotConfig;
  channel?: string;
}): ChannelMessageActionName[] {
  if (!params.channel) return [];
  const plugin = getChannelPlugin(params.channel as Parameters<typeof getChannelPlugin>[0]);
  if (!plugin?.actions?.listActions) return [];
  const cfg = params.cfg ?? ({} as MoltbotConfig);
  return plugin.actions.listActions({ cfg });
}

/**
 * Get the list of all supported message actions across all configured channels.
 */
export function listAllChannelSupportedActions(params: {
  cfg?: MoltbotConfig;
}): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>();
  for (const plugin of listChannelPlugins()) {
    if (!plugin.actions?.listActions) continue;
    const cfg = params.cfg ?? ({} as MoltbotConfig);
    const channelActions = plugin.actions.listActions({ cfg });
    for (const action of channelActions) {
      actions.add(action);
    }
  }
  return Array.from(actions);
}

export function listChannelAgentTools(params: { cfg?: MoltbotConfig }): ChannelAgentTool[] {
  // Channel docking: aggregate channel-owned tools (login, etc.).
  const tools: ChannelAgentTool[] = [];
  for (const plugin of listChannelPlugins()) {
    const entry = plugin.agentTools;
    if (!entry) continue;
    const resolved = typeof entry === "function" ? entry(params) : entry;
    if (Array.isArray(resolved)) tools.push(...resolved);
  }
  return tools;
}

export function resolveChannelMessageToolHints(params: {
  cfg?: MoltbotConfig;
  channel?: string | null;
  accountId?: string | null;
}): string[] {
  const channelId = normalizeAnyChannelId(params.channel);
  if (!channelId) return [];
  const dock = getChannelDock(channelId);
  const resolve = dock?.agentPrompt?.messageToolHints;
  if (!resolve) return [];
  const cfg = params.cfg ?? ({} as MoltbotConfig);
  return (resolve({ cfg, accountId: params.accountId }) ?? [])
    .map((entry) => entry.trim())
    .filter(Boolean);
}
