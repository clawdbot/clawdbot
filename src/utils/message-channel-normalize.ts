// Message channel normalization helpers canonicalize channel identifiers and aliases.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { CHANNEL_IDS } from "../channels/ids.js";
import { listRegisteredChannelPluginIds } from "../channels/registry.js";
import { INTERNAL_MESSAGE_CHANNEL } from "./message-channel-constants.js";
import { normalizeMessageChannel } from "./message-channel-core.js";
export { normalizeMessageChannel } from "./message-channel-core.js";

/** Lists built-in and registered plugin channel ids that can receive delivery. */
export const listDeliverableMessageChannels = (): string[] =>
  uniqueStrings([...CHANNEL_IDS, ...listRegisteredChannelPluginIds()]);

/** Returns whether a normalized id is valid for Gateway routing. */
export function isGatewayMessageChannel(value: string): boolean {
  return value === INTERNAL_MESSAGE_CHANNEL || isDeliverableMessageChannel(value);
}

/** Returns whether a normalized id is a deliverable non-internal channel. */
export function isDeliverableMessageChannel(value: string): boolean {
  return (
    CHANNEL_IDS.some((channelId) => channelId === value) ||
    listRegisteredChannelPluginIds().includes(value)
  );
}

/** Normalizes and validates a raw channel value for Gateway routing. */
export function resolveGatewayMessageChannel(raw?: string | null): string | undefined {
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
