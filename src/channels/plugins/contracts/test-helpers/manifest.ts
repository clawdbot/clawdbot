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

export type ChannelPluginSurface = (typeof channelPluginSurfaceKeys)[number];

export const sessionBindingContractChannelIds = [
  "bluebubbles",
  "discord",
  "feishu",
  "imessage",
  "matrix",
  "telegram",
] as const;

export type SessionBindingContractChannelId = (typeof sessionBindingContractChannelIds)[number];
