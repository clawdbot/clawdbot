import { getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import {
  createMessageActionDiscoveryContext,
  resolveMessageActionDiscoveryForPlugin,
  resolveMessageActionDiscoveryChannelId,
  resolveCurrentChannelMessageToolDiscoveryAdapter,
  __testing as messageActionTesting,
} from "../channels/plugins/message-action-discovery.js";
import type {
  ChannelAgentTool,
  ChannelMessageActionName,
} from "../channels/plugins/types.public.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

type ChannelAgentToolMeta = {
  channelId: string;
};

const channelAgentToolMeta = new WeakMap<ChannelAgentTool, ChannelAgentToolMeta>();

export function getChannelAgentToolMeta(tool: ChannelAgentTool): ChannelAgentToolMeta | undefined {
  return channelAgentToolMeta.get(tool);
}

export function copyChannelAgentToolMeta(source: ChannelAgentTool, target: ChannelAgentTool): void {
  const meta = channelAgentToolMeta.get(source);
  if (meta) {
    channelAgentToolMeta.set(target, meta);
  }
}

/**
 * Get the list of supported message actions for a specific channel.
 * Returns an empty array if channel is not found or has no actions configured.
 */
export function listChannelSupportedActions(params: {
  cfg?: OpenClawConfig;
  channel?: string;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
}): ChannelMessageActionName[] {
  const channelId = resolveMessageActionDiscoveryChannelId(params.channel);
  if (!channelId) {
    return [];
  }
  const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(channelId);
  if (!pluginActions?.actions) {
    return [];
  }
  return resolveMessageActionDiscoveryForPlugin({
    pluginId: pluginActions.pluginId,
    actions: pluginActions.actions,
    context: createMessageActionDiscoveryContext(params),
    includeActions: true,
  }).actions;
}

/**
 * Get the list of all supported message actions across all configured channels.
 */
export function listAllChannelSupportedActions(params: {
  cfg?: OpenClawConfig;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
  senderIsOwner?: boolean;
}): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>();
  for (const plugin of listChannelPlugins()) {
    const channelActions = resolveMessageActionDiscoveryForPlugin({
      pluginId: plugin.id,
      actions: plugin.actions,
      context: createMessageActionDiscoveryContext({
        ...params,
        currentChannelProvider: plugin.id,
      }),
      includeActions: true,
    }).actions;
    for (const action of channelActions) {
      actions.add(action);
    }
  }
  return Array.from(actions);
}

export function listChannelAgentTools(params: { cfg?: OpenClawConfig }): ChannelAgentTool[] {
  // Channel docking: aggregate channel-owned tools (login, etc.).
  const tools: ChannelAgentTool[] = [];
  for (const plugin of listChannelPlugins()) {
    const entry = plugin.agentTools;
    if (!entry) {
      continue;
    }
    const resolved = typeof entry === "function" ? entry(params) : entry;
    if (Array.isArray(resolved)) {
      for (const tool of resolved) {
        channelAgentToolMeta.set(tool, { channelId: plugin.id });
      }
      tools.push(...resolved);
    }
  }
  return tools;
}

export function resolveChannelMessageToolHints(params: {
  cfg?: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
}): string[] {
  const channelId = normalizeAnyChannelId(params.channel);
  if (!channelId) {
    return [];
  }
  const resolve = getChannelPlugin(channelId)?.agentPrompt?.messageToolHints;
  if (!resolve) {
    return [];
  }
  const cfg = params.cfg ?? ({} as OpenClawConfig);
  return (resolve({ cfg, accountId: params.accountId }) ?? [])
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveChannelMessageToolCapabilities(params: {
  cfg?: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
}): string[] {
  const channelId = normalizeAnyChannelId(params.channel);
  if (!channelId) {
    return [];
  }
  const resolve = getChannelPlugin(channelId)?.agentPrompt?.messageToolCapabilities;
  if (!resolve) {
    return [];
  }
  const cfg = params.cfg ?? ({} as OpenClawConfig);
  return (resolve({ cfg, accountId: params.accountId }) ?? [])
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveChannelReactionGuidance(params: {
  cfg?: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
}): { level: "minimal" | "extensive"; channel: string } | undefined {
  const channelId = normalizeAnyChannelId(params.channel);
  if (!channelId) {
    return undefined;
  }
  const resolve = getChannelPlugin(channelId)?.agentPrompt?.reactionGuidance;
  if (!resolve) {
    return undefined;
  }
  const cfg = params.cfg ?? ({} as OpenClawConfig);
  const resolved = resolve({ cfg, accountId: params.accountId });
  if (!resolved?.level) {
    return undefined;
  }
  return {
    level: resolved.level,
    channel: resolved.channelLabel?.trim() || channelId,
  };
}

export const __testing = {
  resetLoggedListActionErrors() {
    messageActionTesting.resetLoggedMessageActionErrors();
  },
};
