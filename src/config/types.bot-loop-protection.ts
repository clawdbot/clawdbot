// Defines channel bot-loop protection configuration types.
export type ChannelBotLoopProtectionConfig = {
  /** Enable pair loop protection for channels that support it. */
  enabled?: boolean;
  /** Maximum events a sender/receiver pair may exchange within the window. */
  maxEventsPerWindow?: number;
  /** Sliding window length in seconds. */
  windowSeconds?: number;
  /** Cooldown seconds applied to a pair after the limit is hit. */
  cooldownSeconds?: number;
  /** Bot events allowed per conversation in a rolling 10-minute window (3+ active bots) before suppression. */
  maxConversationBotEvents?: number;
};
