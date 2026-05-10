import { getChatChannelMeta } from "../channels/chat-meta.js";
import { getRegisteredChannelPluginMeta, normalizeChatChannelId } from "../channels/registry.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
  normalizeGatewayClientMode,
  normalizeGatewayClientName,
} from "../gateway/protocol/client-info.js";
export {
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  listDeliverableMessageChannels,
  normalizeMessageChannel,
  resolveGatewayMessageChannel,
  resolveMessageChannel,
  type DeliverableMessageChannel,
  type GatewayMessageChannel,
} from "./message-channel-normalize.js";
export {
  INTERNAL_MESSAGE_CHANNEL,
  INTERNAL_NON_DELIVERY_CHANNELS,
  isInternalNonDeliveryChannel,
  type InternalMessageChannel,
} from "./message-channel-constants.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  type InternalMessageChannel,
} from "./message-channel-constants.js";
import { normalizeMessageChannel } from "./message-channel-normalize.js";

export { GATEWAY_CLIENT_NAMES, GATEWAY_CLIENT_MODES };
export type { GatewayClientName, GatewayClientMode };
export { normalizeGatewayClientName, normalizeGatewayClientMode };

type GatewayClientInfoLike = {
  mode?: string | null;
  id?: string | null;
};

export function isGatewayCliClient(client?: GatewayClientInfoLike | null): boolean {
  return normalizeGatewayClientMode(client?.mode) === GATEWAY_CLIENT_MODES.CLI;
}

export function isOperatorUiClient(client?: GatewayClientInfoLike | null): boolean {
  const clientId = normalizeGatewayClientName(client?.id);
  return clientId === GATEWAY_CLIENT_NAMES.CONTROL_UI || clientId === GATEWAY_CLIENT_NAMES.TUI;
}

export function isBrowserOperatorUiClient(client?: GatewayClientInfoLike | null): boolean {
  const clientId = normalizeGatewayClientName(client?.id);
  return clientId === GATEWAY_CLIENT_NAMES.CONTROL_UI;
}

export function isInternalMessageChannel(raw?: string | null): raw is InternalMessageChannel {
  return normalizeMessageChannel(raw) === INTERNAL_MESSAGE_CHANNEL;
}

export function isWebchatClient(client?: GatewayClientInfoLike | null): boolean {
  const mode = normalizeGatewayClientMode(client?.mode);
  if (mode === GATEWAY_CLIENT_MODES.WEBCHAT) {
    return true;
  }
  return normalizeGatewayClientName(client?.id) === GATEWAY_CLIENT_NAMES.WEBCHAT_UI;
}

export function isMarkdownCapableMessageChannel(raw?: string | null): boolean {
  const channel = normalizeMessageChannel(raw);
  if (!channel) {
    return false;
  }
  if (channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return true;
  }
  const builtInChannel = normalizeChatChannelId(channel);
  if (builtInChannel) {
    return getChatChannelMeta(builtInChannel).markdownCapable === true;
  }
  return getRegisteredChannelPluginMeta(channel)?.markdownCapable === true;
}
