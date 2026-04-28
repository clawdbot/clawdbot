// Private runtime barrel for the bundled Microsoft Teams extension.
// Keep this barrel thin and aligned with the local extension surface.

export { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
export type { AllowlistMatch } from "openclaw/plugin-sdk/allow-from";
export {
  mergeAllowlist,
  resolveAllowlistMatchSimple,
  summarizeMapping,
} from "openclaw/plugin-sdk/allow-from";
export type {
  BaseProbeResult,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionName,
  ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-contract";
export type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
export { logTypingFailure } from "openclaw/plugin-sdk/channel-logging";
export { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
export {
  evaluateSenderGroupAccessForPolicy,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
  resolveSenderScopedGroupPolicy,
  resolveToolsBySender,
} from "openclaw/plugin-sdk/channel-policy";
export { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
export {
  PAIRING_APPROVED_MESSAGE,
  buildProbeChannelStatusSummary,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/channel-status";
export {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
} from "openclaw/plugin-sdk/channel-targets";
export type {
  GroupPolicy,
  GroupToolPolicyConfig,
  MSTeamsChannelConfig,
  MSTeamsConfig,
  MSTeamsReplyStyle,
  MSTeamsTeamConfig,
  MarkdownTableMode,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-types";
export { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
export { resolveDefaultGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
export { withFileLock } from "openclaw/plugin-sdk/file-lock";
export { keepHttpServerTaskAlive } from "openclaw/plugin-sdk/channel-lifecycle";
export {
  detectMime,
  extensionForMime,
  extractOriginalFilename,
  getFileExtension,
  resolveChannelMediaMaxBytes,
} from "openclaw/plugin-sdk/media-runtime";
export { dispatchReplyFromConfigWithSettledDispatcher } from "openclaw/plugin-sdk/inbound-reply-dispatch";
export { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
export { buildMediaPayload } from "openclaw/plugin-sdk/reply-payload";
export type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
export type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
export type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
export type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
export { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
export { normalizeStringEntries } from "openclaw/plugin-sdk/string-normalization-runtime";
export { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
export { DEFAULT_WEBHOOK_MAX_BODY_BYTES } from "openclaw/plugin-sdk/webhook-ingress";
export { setMSTeamsRuntime } from "./src/runtime.js";
