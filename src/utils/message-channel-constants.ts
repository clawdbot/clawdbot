export const INTERNAL_MESSAGE_CHANNEL = "webchat" as const;
export type InternalMessageChannel = typeof INTERNAL_MESSAGE_CHANNEL;

// Internal, non-delivery sources that may surface as a `channel` hint when an
// agent run is triggered by something other than a chat message — heartbeat
// ticks, cron jobs, or webhook receivers. They are not deliverable on their
// own, but they should still pass agent-param channel validation so internal
// callers (e.g. sessions_spawn from a heartbeat-driven parent run) are not
// rejected as "unknown channel".
export const INTERNAL_NON_DELIVERY_CHANNELS = ["heartbeat", "cron", "webhook"] as const;
export type InternalNonDeliveryChannel = (typeof INTERNAL_NON_DELIVERY_CHANNELS)[number];

export function isInternalNonDeliveryChannel(value: string): value is InternalNonDeliveryChannel {
  return (INTERNAL_NON_DELIVERY_CHANNELS as readonly string[]).includes(value);
}
