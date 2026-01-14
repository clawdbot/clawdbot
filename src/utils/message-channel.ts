import {
  CHANNEL_IDS,
  listChatChannelAliases,
  normalizeChatChannelId,
} from "../channels/registry.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayClientMode,
  type GatewayClientName,
  normalizeGatewayClientMode,
  normalizeGatewayClientName,
} from "../gateway/protocol/client-info.js";

export const INTERNAL_MESSAGE_CHANNEL = "webchat" as const;
export type InternalMessageChannel = typeof INTERNAL_MESSAGE_CHANNEL;

export { GATEWAY_CLIENT_NAMES, GATEWAY_CLIENT_MODES };
export type { GatewayClientName, GatewayClientMode };
export { normalizeGatewayClientName, normalizeGatewayClientMode };

type GatewayClientInfoLike = {
  mode?: string | null;
  id?: string | null;
};

export function isGatewayCliClient(
  client?: GatewayClientInfoLike | null,
): boolean {
  return normalizeGatewayClientMode(client?.mode) === GATEWAY_CLIENT_MODES.CLI;
}

export function isInternalMessageChannel(
  raw?: string | null,
): raw is InternalMessageChannel {
  return normalizeMessageChannel(raw) === INTERNAL_MESSAGE_CHANNEL;
}

export function isWebchatClient(
  client?: GatewayClientInfoLike | null,
): boolean {
  const mode = normalizeGatewayClientMode(client?.mode);
  if (mode === GATEWAY_CLIENT_MODES.WEBCHAT) return true;
  return (
    normalizeGatewayClientName(client?.id) === GATEWAY_CLIENT_NAMES.WEBCHAT_UI
  );
}

export function normalizeMessageChannel(
  raw?: string | null,
): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === INTERNAL_MESSAGE_CHANNEL) return INTERNAL_MESSAGE_CHANNEL;
  return normalizeChatChannelId(normalized) ?? normalized;
}

export const DELIVERABLE_MESSAGE_CHANNELS = CHANNEL_IDS;

export type DeliverableMessageChannel =
  (typeof DELIVERABLE_MESSAGE_CHANNELS)[number];

export type GatewayMessageChannel =
  | DeliverableMessageChannel
  | InternalMessageChannel;

export const GATEWAY_MESSAGE_CHANNELS = [
  ...DELIVERABLE_MESSAGE_CHANNELS,
  INTERNAL_MESSAGE_CHANNEL,
] as const;

export const GATEWAY_AGENT_CHANNEL_ALIASES = listChatChannelAliases();

export type GatewayAgentChannelHint = GatewayMessageChannel | "last";

export const GATEWAY_AGENT_CHANNEL_VALUES = Array.from(
  new Set([
    ...GATEWAY_MESSAGE_CHANNELS,
    "last",
    ...GATEWAY_AGENT_CHANNEL_ALIASES,
  ]),
);

export function isGatewayMessageChannel(
  value: string,
): value is GatewayMessageChannel {
  return (GATEWAY_MESSAGE_CHANNELS as readonly string[]).includes(value);
}

export function isDeliverableMessageChannel(
  value: string,
): value is DeliverableMessageChannel {
  return (DELIVERABLE_MESSAGE_CHANNELS as readonly string[]).includes(value);
}

export function resolveGatewayMessageChannel(
  raw?: string | null,
): GatewayMessageChannel | undefined {
  const normalized = normalizeMessageChannel(raw);
  if (!normalized) return undefined;
  return isGatewayMessageChannel(normalized) ? normalized : undefined;
}

export function resolveMessageChannel(
  primary?: string | null,
  fallback?: string | null,
): string | undefined {
  return normalizeMessageChannel(primary) ?? normalizeMessageChannel(fallback);
}
