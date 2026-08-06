// Message channel normalization helpers canonicalize channel identifiers and aliases.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { CHANNEL_IDS } from "../channels/ids.js";
import { listRegisteredChannelPluginIds } from "../channels/registry.js";
import { INTERNAL_MESSAGE_CHANNEL } from "./message-channel-constants.js";
import { normalizeMessageChannel as normalizeMessageChannelCore } from "./message-channel-core.js";

type ChannelId = string & { readonly __openclawChannelIdBrand?: never };

/** Channel id that can receive outbound messages from the Gateway. */
export type DeliverableMessageChannel = ChannelId;

/** Channel id accepted by Gateway protocol routing, including internal webchat. */
export type GatewayMessageChannel = DeliverableMessageChannel;

/** Normalizes built-in, plugin, and alias channel names to their canonical id. */
export function normalizeMessageChannel(raw?: string | null): string | undefined {
  return normalizeMessageChannelCore(raw);
}

const listPluginChannelIds = (): string[] => {
  return listRegisteredChannelPluginIds();
};

/** Lists built-in and registered plugin channel ids that can receive delivery. */
export const listDeliverableMessageChannels = (): ChannelId[] =>
  uniqueStrings([...CHANNEL_IDS, ...listPluginChannelIds()]) as ChannelId[];

const listGatewayMessageChannels = (): GatewayMessageChannel[] => [
  ...listDeliverableMessageChannels(),
  INTERNAL_MESSAGE_CHANNEL,
];

/** Returns whether a normalized id is valid for Gateway routing. */
export function isGatewayMessageChannel(value: string): value is GatewayMessageChannel {
  return listGatewayMessageChannels().includes(value as GatewayMessageChannel);
}

/** Returns whether a normalized id is a deliverable non-internal channel. */
export function isDeliverableMessageChannel(value: string): value is DeliverableMessageChannel {
  return listDeliverableMessageChannels().includes(value as DeliverableMessageChannel);
}

/** Normalizes and validates a raw channel value for Gateway routing. */
export function resolveGatewayMessageChannel(
  raw?: string | null,
): GatewayMessageChannel | undefined {
  const normalized = normalizeMessageChannel(raw);
  if (!normalized) {
    return undefined;
  }
  return isGatewayMessageChannel(normalized) ? normalized : undefined;
}

/** Normalizes the primary channel or falls back to a secondary channel value. */
export function resolveMessageChannel(
  primary?: string | null,
  fallback?: string | null,
): string | undefined {
  return normalizeMessageChannel(primary) ?? normalizeMessageChannel(fallback);
}
