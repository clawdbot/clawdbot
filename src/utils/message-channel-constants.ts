// Message channel constants define internal channel ids shared across routing.
import { isStringOption } from "./string-readers.js";

export const INTERNAL_MESSAGE_CHANNEL = "webchat" as const;

export function internalSessionConversationId(
  channelId: string,
  sessionKey: string | undefined,
): string | undefined {
  return channelId === INTERNAL_MESSAGE_CHANNEL ? sessionKey : undefined;
}

// Internal, non-delivery sources that may surface as a `channel` hint when an
// agent run is triggered by something other than a chat message — heartbeat
// ticks, cron jobs, or webhook receivers. They are not deliverable on their
// own, but they should still pass agent-param channel validation so internal
// callers (e.g. sessions_spawn from a heartbeat-driven parent run) are not
// rejected as "unknown channel".
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
