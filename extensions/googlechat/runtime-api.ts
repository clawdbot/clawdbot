// Private runtime barrel for the bundled Google Chat extension.
// Keep this barrel thin and avoid broad plugin-sdk surfaces during bootstrap.

export { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
export {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
export { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-primitives";
export type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelStatusIssue,
} from "openclaw/plugin-sdk/channel-contract";
export { missingTargetError } from "openclaw/plugin-sdk/channel-feedback";
export {
  createAccountStatusSink,
  runPassiveAccountLifecycle,
} from "openclaw/plugin-sdk/channel-lifecycle";
export { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
export { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
export {
  evaluateGroupRouteAccessForPolicy,
  resolveDmGroupAccessWithLists,
  resolveSenderScopedGroupPolicy,
} from "openclaw/plugin-sdk/channel-policy";
export { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
export { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
export { GoogleChatConfigSchema } from "openclaw/plugin-sdk/bundled-channel-config-schema";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
export { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
export { fetchRemoteMedia, resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/media-runtime";
export { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
export type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
export { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
export type { GoogleChatAccountConfig, GoogleChatConfig } from "openclaw/plugin-sdk/config-types";
export { extractToolSend } from "openclaw/plugin-sdk/tool-send";
export { resolveInboundMentionDecision } from "openclaw/plugin-sdk/channel-inbound";
export { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
export { resolveWebhookPath } from "openclaw/plugin-sdk/webhook-path";
export {
  registerWebhookTargetWithPluginRoute,
  resolveWebhookTargetWithAuthOrReject,
  withResolvedWebhookRequestPipeline,
} from "openclaw/plugin-sdk/webhook-targets";
export {
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
  type WebhookInFlightLimiter,
} from "openclaw/plugin-sdk/webhook-request-guards";
export { setGoogleChatRuntime } from "./src/runtime.js";
