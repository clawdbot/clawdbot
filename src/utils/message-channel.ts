// Message channel helpers classify and format channel identifiers.
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
  normalizeGatewayClientMode,
  normalizeGatewayClientName,
} from "../../packages/gateway-protocol/src/client-info.js";
import { listBundledChannelCatalogEntries } from "../channels/bundled-channel-catalog-read.js";
import { findChatChannelMeta } from "../channels/chat-meta.js";
import { getRegisteredChannelPluginMeta, normalizeChatChannelId } from "../channels/registry.js";
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
  isInternalNonDeliveryChannel,
  NATIVE_APPROVAL_CHANNELS,
  isNativeApprovalChannel,
  type InternalMessageChannel,
  type NativeApprovalChannel,
} from "./message-channel-constants.js";
import { INTERNAL_MESSAGE_CHANNEL } from "./message-channel-constants.js";
import { normalizeMessageChannel } from "./message-channel-normalize.js";

/**
 * Message channel and Gateway client classification helpers.
 *
 * This module keeps channel normalization, client identity checks, and markdown
 * capability lookup in one place for send/render decisions.
 */
export { GATEWAY_CLIENT_NAMES, GATEWAY_CLIENT_MODES };
export type { GatewayClientName, GatewayClientMode };

type GatewayClientInfoLike = {
  mode?: string | null;
  id?: string | null;
};

/** Return whether a Gateway client is the CLI transport. */
export function isGatewayCliClient(client?: GatewayClientInfoLike | null): boolean {
  return normalizeGatewayClientMode(client?.mode) === GATEWAY_CLIENT_MODES.CLI;
}

/**
 * Return whether a Gateway client is an ephemeral control-plane connection.
 * Test-mode clients stay excluded from this list: suites use them as stand-ins
 * for real clients and assert presence propagation through the full pipeline.
 */
export function isEphemeralGatewayClient(client?: GatewayClientInfoLike | null): boolean {
  const mode = normalizeGatewayClientMode(client?.mode);
  return (
    mode === GATEWAY_CLIENT_MODES.CLI ||
    mode === GATEWAY_CLIENT_MODES.BACKEND ||
    mode === GATEWAY_CLIENT_MODES.PROBE
  );
}

/** Return whether a client is one of the operator UI clients. */
export function isOperatorUiClient(client?: GatewayClientInfoLike | null): boolean {
  const clientId = normalizeGatewayClientName(client?.id);
  return clientId === GATEWAY_CLIENT_NAMES.CONTROL_UI || clientId === GATEWAY_CLIENT_NAMES.TUI;
}

/** Return whether a client is the browser Control UI. */
export function isBrowserOperatorUiClient(client?: GatewayClientInfoLike | null): boolean {
  const clientId = normalizeGatewayClientName(client?.id);
  return clientId === GATEWAY_CLIENT_NAMES.CONTROL_UI;
}

/** Return whether a raw channel id resolves to OpenClaw's internal channel. */
export function isInternalMessageChannel(
  raw?: string | null,
): raw is typeof INTERNAL_MESSAGE_CHANNEL {
  return normalizeMessageChannel(raw) === INTERNAL_MESSAGE_CHANNEL;
}

/** Return whether a Gateway client is the public webchat surface. */
export function isWebchatClient(client?: GatewayClientInfoLike | null): boolean {
  const mode = normalizeGatewayClientMode(client?.mode);
  if (mode === GATEWAY_CLIENT_MODES.WEBCHAT) {
    return true;
  }
  return normalizeGatewayClientName(client?.id) === GATEWAY_CLIENT_NAMES.WEBCHAT_UI;
}

/** Resolve whether a channel can receive markdown without plain-text downgrade. */
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
    const builtInMeta = findChatChannelMeta(builtInChannel);
    if (builtInMeta) {
      return builtInMeta.markdownCapable === true;
    }
    // Catalog metadata covers bundled channels whose runtime plugin is not loaded yet.
    const catalogMeta = listBundledChannelCatalogEntries().find(
      (entry) => entry.id === builtInChannel,
    );
    if (catalogMeta) {
      return catalogMeta.channel.markdownCapable === true;
    }
  }
  return getRegisteredChannelPluginMeta(channel)?.markdownCapable === true;
}
