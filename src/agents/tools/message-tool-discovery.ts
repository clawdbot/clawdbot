import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings, uniqueValues } from "@openclaw/normalization-core/string-normalization";
import type { ChatType } from "../../channels/chat-type.js";
import {
  getChannelPlugin,
  getLoadedChannelPlugin,
  listChannelPlugins,
} from "../../channels/plugins/index.js";
import {
  channelSupportsMessageCapability,
  channelSupportsMessageCapabilityForChannel,
  type ChannelMessageActionDiscoveryInput,
  listCrossChannelSchemaSupportedMessageActions,
  type PreparedMessageToolCatalog,
  resolveChannelMessageToolSchemaProperties,
} from "../../channels/plugins/message-action-discovery.js";
import type { ChannelMessageCapability } from "../../channels/plugins/message-capabilities.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAllowedMessageActions } from "../../infra/outbound/outbound-policy.js";
import { normalizeAccountId, parseSessionDeliveryRoute } from "../../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { listAllChannelSupportedActions, listChannelSupportedActions } from "../channel-tools.js";
import { appendMessageToolReadHint } from "./message-tool-description.js";
import { buildMessageToolSchemaFromActions } from "./message-tool-schema-scoping.js";
import { MESSAGE_TOOL_SCHEMA_BUILDERS } from "./message-tool-schema.js";
export type MessageToolDiscoveryParams = {
  cfg: OpenClawConfig;
  currentChatType?: ChatType;
  currentChannelProvider?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentAccountId?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
  preparedMessageToolCatalog?: PreparedMessageToolCatalog;
};

type MessageActionDiscoveryInput = Omit<ChannelMessageActionDiscoveryInput, "cfg" | "channel"> & {
  cfg: OpenClawConfig;
  channel?: string;
  preparedMessageToolCatalog?: PreparedMessageToolCatalog;
};

type MessageToolCurrentContextOptions = {
  agentSessionKey?: string;
  currentChannelId?: string;
  currentChannelProvider?: string;
  currentChatType?: ChatType;
  currentMessagingTarget?: string;
};
type InferredSessionDelivery = {
  accountId?: string;
  channel: string;
  chatType?: ChatType;
  threadId?: string;
  to: string;
};

function formatSessionDeliveryTarget(channel: string, peerKind: string, to: string): string {
  return (peerKind === "direct" || peerKind === "dm") &&
    getChannelPlugin(channel)?.messaging?.directTargetStyle === "user-prefixed"
    ? `user:${to}`
    : to;
}

function resolveSessionDeliveryChatType(peerKind: string): ChatType | undefined {
  if (peerKind === "direct" || peerKind === "dm") {
    return "direct";
  }
  if (peerKind === "group" || peerKind === "channel") {
    return peerKind;
  }
  return undefined;
}

function inferDeliveryFromSessionKey(
  sessionKey: string | undefined,
): InferredSessionDelivery | null {
  const route = parseSessionDeliveryRoute(sessionKey);
  if (!route) {
    return null;
  }
  const channel = normalizeMessageChannel(route.channel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL) {
    return null;
  }
  const accountId = route.accountId ? resolveAgentAccountId(route.accountId) : undefined;
  return {
    accountId,
    channel,
    chatType: resolveSessionDeliveryChatType(route.peerKind),
    threadId: route.threadId,
    to: formatSessionDeliveryTarget(channel, route.peerKind, route.peerId),
  };
}

export function resolveEffectiveCurrentChannelContext(options?: MessageToolCurrentContextOptions): {
  accountId?: string;
  currentChannelId?: string;
  currentChatType?: ChatType;
  currentMessagingTarget?: string;
  currentChannelProvider?: string;
  currentThreadTs?: string;
} {
  const currentChannelProvider = options?.currentChannelProvider;
  const currentChannelId = options?.currentChannelId;
  const sessionDelivery =
    normalizeMessageChannel(currentChannelProvider) === INTERNAL_MESSAGE_CHANNEL
      ? inferDeliveryFromSessionKey(options?.agentSessionKey)
      : null;

  if (!sessionDelivery?.to) {
    return {
      currentChannelProvider,
      currentChannelId,
      currentChatType: options?.currentChatType,
      currentMessagingTarget: options?.currentMessagingTarget,
    };
  }
  return {
    accountId: sessionDelivery.accountId,
    currentChannelProvider: sessionDelivery.channel,
    currentChannelId: sessionDelivery.to,
    currentChatType: sessionDelivery.chatType,
    currentMessagingTarget: sessionDelivery.to,
    currentThreadTs: sessionDelivery.threadId,
  };
}

function buildMessageActionDiscoveryInput(
  params: MessageToolDiscoveryParams,
  channel?: string,
): MessageActionDiscoveryInput {
  return {
    cfg: params.cfg,
    ...(channel ? { channel } : {}),
    chatType: params.currentChatType,
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    accountId: params.currentAccountId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    requesterSenderId: params.requesterSenderId,
    senderIsOwner: params.senderIsOwner,
    preparedMessageToolCatalog: params.preparedMessageToolCatalog,
  };
}

function resolveMessageToolSchemaActions(params: MessageToolDiscoveryParams): string[] {
  const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
  if (currentChannel) {
    const scopedActions = listChannelSupportedActions(
      buildMessageActionDiscoveryInput(params, currentChannel),
    );
    const allActions = new Set<string>(["send", ...scopedActions]);
    // Include actions from other configured channels so isolated/cron agents
    // can invoke cross-channel actions without validation errors.
    const channels = params.preparedMessageToolCatalog?.channels ?? listChannelPlugins();
    for (const plugin of channels) {
      if (plugin.id === currentChannel) {
        continue;
      }
      for (const action of listCrossChannelSchemaSupportedMessageActions(
        buildMessageActionDiscoveryInput(params, plugin.id),
      )) {
        allActions.add(action);
      }
    }
    return Array.from(allActions);
  }
  return listAllMessageToolActions(params);
}

export function resolveMessageToolActionSchemaActions(
  params: MessageToolDiscoveryParams,
): string[] {
  const discoveredActions = resolveMessageToolSchemaActions(params);
  const allowedActions = resolveAllowedMessageActions({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!allowedActions) {
    return discoveredActions;
  }
  const allow = new Set(allowedActions);
  const filtered = discoveredActions.filter((action) => allow.has(action));
  return filtered.length > 0 ? filtered : allowedActions;
}

function listAllMessageToolActions(params: MessageToolDiscoveryParams): ChannelMessageActionName[] {
  const pluginActions = listAllChannelSupportedActions(buildMessageActionDiscoveryInput(params));
  return uniqueValues<ChannelMessageActionName>(["send", "broadcast", ...pluginActions]);
}

function resolveIncludeCapability(
  params: MessageToolDiscoveryParams,
  capability: ChannelMessageCapability,
): boolean {
  const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
  if (currentChannel) {
    return channelSupportsMessageCapabilityForChannel(
      buildMessageActionDiscoveryInput(params, currentChannel),
      capability,
    );
  }
  return channelSupportsMessageCapability(
    params.cfg,
    capability,
    params.preparedMessageToolCatalog,
  );
}

function resolveIncludePresentation(params: MessageToolDiscoveryParams): boolean {
  return resolveIncludeCapability(params, "presentation");
}

function resolveIncludeDeliveryPin(params: MessageToolDiscoveryParams): boolean {
  return resolveIncludeCapability(params, "delivery-pin");
}

function resolveIncludeBestEffort(params: MessageToolDiscoveryParams): boolean {
  const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
  if (!currentChannel) {
    return false;
  }
  const prepared = params.preparedMessageToolCatalog?.getChannel(currentChannel);
  if (params.preparedMessageToolCatalog) {
    // The prepared catalog is the exact runtime-registry generation for this
    // turn. A missing channel is an authoritative absence, not permission to
    // rediscover bundled plugins on the request path.
    return prepared?.reconcilesUnknownSend ?? false;
  }
  const adapter =
    getLoadedChannelPlugin(currentChannel as Parameters<typeof getLoadedChannelPlugin>[0])
      ?.message ??
    getChannelPlugin(currentChannel as Parameters<typeof getChannelPlugin>[0])?.message;
  return (
    adapter?.durableFinal?.capabilities?.reconcileUnknownSend === true &&
    typeof adapter.durableFinal.reconcileUnknownSend === "function"
  );
}

export function buildMessageToolSchema(params: MessageToolDiscoveryParams, actions: string[]) {
  const includePresentation = resolveIncludePresentation(params);
  const includeDeliveryPin = resolveIncludeDeliveryPin(params);
  const includeBestEffort = resolveIncludeBestEffort(params);
  const extraProperties = resolveChannelMessageToolSchemaProperties(
    buildMessageActionDiscoveryInput(
      params,
      normalizeMessageChannel(params.currentChannelProvider) ?? undefined,
    ),
  );
  return buildMessageToolSchemaFromActions(
    actions.length > 0 ? actions : ["send"],
    {
      includePresentation,
      includeDeliveryPin,
      includeBestEffort,
      scopeToActions: normalizeMessageChannel(params.currentChannelProvider) !== undefined,
      extraProperties,
    },
    MESSAGE_TOOL_SCHEMA_BUILDERS,
  );
}

export function resolveAgentAccountId(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return normalizeAccountId(trimmed);
}

export function buildMessageToolDescription(actions: string[] | undefined): string {
  const baseDescription = "Send/manage channel messages.";
  if (actions && actions.length > 0) {
    const sortedActions = sortUniqueStrings(actions) as Array<ChannelMessageActionName | "send">;
    return appendMessageToolReadHint(
      `${baseDescription} Supports actions: ${sortedActions.join(", ")}.`,
      sortedActions,
    );
  }
  return `${baseDescription} Action families (availability depends on the channel): sending/editing/unsend, reactions, polls, pins, threads, file upload/download, moderation (timeout/kick/ban), roles, channel + category management, profile/presence.`;
}
