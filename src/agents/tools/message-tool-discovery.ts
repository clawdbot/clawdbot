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
import { readExactSessionDeliveryContext } from "../../config/sessions/delivery-info.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { stripTargetProviderPrefix } from "../../infra/outbound/channel-target-prefix.js";
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
  config?: OpenClawConfig;
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

/**
 * Session keys fold peer ids for channels outside the case-preservation
 * registry, so a delivery target rebuilt from the key reaches the wire
 * lowercased. Channels that compare target ids byte-exactly then reject it. The
 * same session's stored delivery metadata still holds the casing the channel
 * sent inbound, so recover it from there.
 *
 * Three gates keep this a case-only repair of one conversation: the channel
 * must declare case-sensitive target ids, the stored route must name the same
 * channel, and the stored id must match the folded one case-insensitively. The
 * last mirrors the stored-key guard in src/config/sessions/store-entry.ts, and
 * means the substitution can never select a different space or account.
 *
 * The lookup is bounded: readExactSessionDeliveryContext performs a single keyed read of this
 * session's own row and never builds the freshest-row index that walks every stored session.
 */
function recoverSessionCanonicalPeerId(params: {
  cfg?: OpenClawConfig;
  channel: string;
  peerId: string;
  sessionKey?: string;
}): string {
  if (getChannelPlugin(params.channel)?.messaging?.targetIdComparison !== "case-sensitive") {
    return params.peerId;
  }
  const deliveryContext = readExactSessionDeliveryContext({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const storedTo = normalizeOptionalString(deliveryContext?.to);
  if (!storedTo || normalizeMessageChannel(deliveryContext?.channel) !== params.channel) {
    return params.peerId;
  }
  const canonical = normalizeOptionalString(
    stripTargetProviderPrefix(storedTo, params.channel, deliveryContext?.channel ?? ""),
  );
  return canonical && canonical.toLowerCase() === params.peerId.toLowerCase()
    ? canonical
    : params.peerId;
}

function inferDeliveryFromSessionKey(
  sessionKey: string | undefined,
  cfg?: OpenClawConfig,
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
  const peerId = recoverSessionCanonicalPeerId({ cfg, channel, peerId: route.peerId, sessionKey });
  return {
    accountId,
    channel,
    chatType: resolveSessionDeliveryChatType(route.peerKind),
    threadId: route.threadId,
    to: formatSessionDeliveryTarget(channel, route.peerKind, peerId),
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
      ? inferDeliveryFromSessionKey(options?.agentSessionKey, options?.config)
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
