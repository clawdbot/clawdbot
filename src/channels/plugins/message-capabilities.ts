export const CHANNEL_MESSAGE_CAPABILITIES = ["presentation", "delivery-pin"] as const;

export type ChannelMessageCapability = (typeof CHANNEL_MESSAGE_CAPABILITIES)[number];
