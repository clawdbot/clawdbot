// Private helper surface for the bundled twitch plugin.
// Keep this list additive and scoped to the bundled Twitch surface.

import { createOptionalChannelSetupSurface } from "./channel-setup.js";

export type { ReplyPayload } from "../auto-reply/reply-payload.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export type {
  ChannelGatewayContext,
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelStatusAdapter,
} from "../channels/plugins/types.adapters.js";
export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelCapabilities,
  ChannelLogSink,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMeta,
  ChannelStatusIssue,
} from "../channels/plugins/types.public.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createChannelReplyPipeline } from "./channel-reply-pipeline.js";
export type { OpenClawConfig } from "../config/config.js";
export { MarkdownConfigSchema } from "../config/zod-schema.core.js";
export type { OutboundDeliveryResult } from "../infra/outbound/deliver.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "./account-id.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export type { RuntimeEnv } from "../runtime.js";
export { formatDocsLink } from "../terminal/links.js";
export type { WizardPrompter } from "../wizard/prompts.js";

const twitchSetup = createOptionalChannelSetupSurface({
  channel: "twitch",
  label: "Twitch",
  npmSpec: "@openclaw/twitch",
});

export const twitchSetupAdapter = twitchSetup.setupAdapter;
export const twitchSetupWizard = twitchSetup.setupWizard;
