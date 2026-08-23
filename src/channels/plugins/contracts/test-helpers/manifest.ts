// Shared manifest contract constants for bundled channel plugin surface tests.
// Keep these lists narrow so each suite checks only the surfaces it owns.
export const channelPluginSurfaceKeys = [
  "actions",
  "setup",
  "status",
  "outbound",
  "messaging",
  "threading",
  "directory",
  "gateway",
] as const;

export const sessionBindingContractChannelIds = [
  "discord",
  "feishu",
  "imessage",
  "matrix",
  "telegram",
] as const;

/** Channel id union for bundled session-binding contract fixtures. */
export type SessionBindingContractChannelId = (typeof sessionBindingContractChannelIds)[number];
