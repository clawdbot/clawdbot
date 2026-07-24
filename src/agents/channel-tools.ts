/**
 * Channel-owned agent tool and prompt helpers.
 * Discovers channel tools, message actions, prompt capabilities, reaction
 * guidance, and weakly-attached channel metadata for wrapped tools.
 */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import {
  createMessageActionDiscoveryContext,
  resolveMessageActionDiscoveryForPlugin,
  resolveMessageActionDiscoveryChannelId,
  resolveCurrentChannelMessageToolDiscoveryAdapter,
  type PreparedMessageToolCatalog,
} from "../channels/plugins/message-action-discovery.js";
import {
  channelPluginHasNativeApprovalPromptUi,
  NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY,
} from "../channels/plugins/native-approval-prompt.js";
import type {
  ChannelAgentTool,
  ChannelMessageActionName,
} from "../channels/plugins/types.public.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setChannelAgentToolMeta } from "./channel-tool-metadata.js";

export { copyChannelAgentToolMeta, getChannelAgentToolMeta } from "./channel-tool-metadata.js";

type ChannelMessageActionDiscoveryParams = {
  cfg?: OpenClawConfig;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
  preparedMessageToolCatalog?: PreparedMessageToolCatalog;
};

/**
 * Get the list of supported message actions for a specific channel.
 * Returns an empty array if channel is not found or has no actions configured.
 */
export function listChannelSupportedActions(
  params: ChannelMessageActionDiscoveryParams & {
    channel?: string;
  },
): ChannelMessageActionName[] {
  const channelId = resolveMessageActionDiscoveryChannelId(params.channel);
  if (!channelId) {
    return [];
  }
  const pluginActions = resolveCurrentChannelMessageToolDiscoveryAdapter(
    channelId,
    params.preparedMessageToolCatalog,
  );
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
export function listAllChannelSupportedActions(
  params: ChannelMessageActionDiscoveryParams,
): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>();
  const channels = params.preparedMessageToolCatalog?.channels ?? listChannelPlugins();
  for (const plugin of channels) {
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

/** List agent tools contributed by registered channel plugins. */
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
        setChannelAgentToolMeta(tool, { channelId: plugin.id });
      }
      tools.push(...resolved);
    }
  }
  return tools;
}

/** Resolve channel-specific message tool hints for system prompt assembly. */
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
  return normalizeStringEntries(resolve({ cfg, accountId: params.accountId }));
}

/** Resolve channel prompt capabilities, including native approval UI support. */
export function resolveChannelPromptCapabilities(params: {
  cfg?: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
}): string[] {
  const channelId = normalizeAnyChannelId(params.channel);
  if (!channelId) {
    return [];
  }
  const plugin = getChannelPlugin(channelId);
  const cfg = params.cfg ?? ({} as OpenClawConfig);
  const capabilities = normalizePromptCapabilities(
    plugin?.agentPrompt?.messageToolCapabilities?.({ cfg, accountId: params.accountId }),
  );
  if (channelPluginHasNativeApprovalPromptUi(plugin)) {
    capabilities.push(NATIVE_APPROVAL_PROMPT_RUNTIME_CAPABILITY);
  }
  return capabilities;
}

function normalizePromptCapabilities(capabilities?: readonly string[] | null): string[] {
  return normalizeStringEntries(capabilities ?? []);
}

/** Resolve optional channel reaction guidance for assistant replies. */
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
