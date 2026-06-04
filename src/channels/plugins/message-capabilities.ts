/**
 * Channel message capabilities advertised through plugin discovery hooks.
 */
export const CHANNEL_MESSAGE_CAPABILITIES = ["presentation", "delivery-pin"] as const;

/**
 * Message capability union derived from the canonical capability list.
 */
export type ChannelMessageCapability = (typeof CHANNEL_MESSAGE_CAPABILITIES)[number];
