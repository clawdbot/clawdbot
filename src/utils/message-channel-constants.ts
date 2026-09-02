// Message channel constants define internal channel ids shared across routing.
import { isStringOption } from "./string-readers.js";

export const INTERNAL_MESSAGE_CHANNEL = "webchat" as const;

export function internalSessionConversationId(
  channelId: string,
  sessionKey: string | undefined,
): string | undefined {
  return channelId === INTERNAL_MESSAGE_CHANNEL ? sessionKey : undefined;
}

// Shipped agent-RPC source hints accepted without delivery. New internal wakes
// carry MsgContext.InternalTurnSource; do not add wake labels as channels.
const INTERNAL_NON_DELIVERY_CHANNELS = [
  "heartbeat",
  "cron",
  "webhook",
  "voice",
  "sessions_send",
] as const;

export function isInternalNonDeliveryChannel(
  value: string,
): value is (typeof INTERNAL_NON_DELIVERY_CHANNELS)[number] {
  return isStringOption(value, INTERNAL_NON_DELIVERY_CHANNELS);
}
