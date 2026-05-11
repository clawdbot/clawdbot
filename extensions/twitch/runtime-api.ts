// Private runtime barrel for the bundled Twitch extension.
// Keep this barrel thin and aligned with the local extension surface.

export type {
  ChannelAccountSnapshot,
  ChannelCapabilities,
  ChannelGatewayContext,
  ChannelLogSink,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMeta,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelStatusAdapter,
} from "openclaw/plugin-sdk/channel-contract";
export type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
export type { OutboundDeliveryResult } from "openclaw/plugin-sdk/channel-send-result";
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
export type { WizardPrompter } from "openclaw/plugin-sdk/setup";
