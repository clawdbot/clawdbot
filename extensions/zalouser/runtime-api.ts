// Private runtime barrel for the bundled Zalo Personal extension.
// Keep this barrel thin and aligned with the local extension surface.

export * from "./api.js";
export { setZalouserRuntime } from "./src/runtime.js";
export type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
export type {
  OpenClawConfig,
  GroupToolPolicyConfig,
  MarkdownTableMode,
} from "openclaw/plugin-sdk/config-runtime";
export type {
  PluginRuntime,
  AnyAgentTool,
  ChannelPlugin,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
export type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  normalizeAccountId,
} from "openclaw/plugin-sdk/core";
export { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
export {
  isDangerousNameMatchingEnabled,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/config-runtime";
export {
  mergeAllowlist,
  summarizeMapping,
  formatAllowFromLowercase,
} from "openclaw/plugin-sdk/allow-from";
export { resolveInboundMentionDecision } from "openclaw/plugin-sdk/channel-inbound";
export { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
export { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
export { buildBaseAccountStatusSnapshot } from "openclaw/plugin-sdk/status-helpers";
export { resolveSenderCommandAuthorization } from "openclaw/plugin-sdk/command-auth";
export {
  evaluateGroupRouteAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "openclaw/plugin-sdk/group-access";
export { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
export {
  deliverTextOrMediaReply,
  isNumericTargetId,
  resolveSendableOutboundReplyParts,
  sendPayloadWithChunkedTextAndMedia,
  type OutboundReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
export { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/browser-security-runtime";
