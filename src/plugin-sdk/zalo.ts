// Private helper surface for the bundled zalo plugin.
// Keep this list additive and scoped to the bundled Zalo surface.

export { jsonResult, readStringParam } from "../agents/tools/common.js";
export type { ReplyPayload } from "./reply-payload.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { listDirectoryUserEntriesFromAllowFrom } from "../channels/plugins/directory-config-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export {
  buildSingleChannelSecretPromptState,
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  promptSingleChannelSecretInput,
  runSingleChannelSecretStep,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "../channels/plugins/setup-wizard-helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
} from "../channels/plugins/setup-helpers.js";
export { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
export type {
  BaseProbeResult,
  BaseTokenResolution,
  ChannelAccountSnapshot,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelStatusIssue,
} from "../channels/plugins/types.public.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { logTypingFailure } from "../channels/logging.js";
export { createChannelReplyPipeline } from "./channel-reply-pipeline.js";
export type { OpenClawConfig } from "../config/config.js";
export {
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export type { GroupPolicy, MarkdownTableMode } from "../config/types.js";
export type { SecretInput } from "./secret-input.js";
export {
  buildSecretInputSchema,
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "./secret-input.js";
export { MarkdownConfigSchema } from "../config/zod-schema.core.js";
export { waitForAbortSignal } from "../infra/abort-signal.js";
export { createDedupeCache } from "../infra/dedupe.js";
export { resolveClientIp } from "../gateway/net.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
export type { RuntimeEnv } from "../runtime.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { formatAllowFromLowercase, isNormalizedSenderAllowed } from "./allow-from.js";
export { zaloSetupAdapter } from "./zalo-setup.js";
export { zaloSetupWizard } from "./zalo-setup.js";
export { evaluateZaloGroupAccess, resolveZaloRuntimeGroupPolicy } from "./zalo-setup.js";
export {
  resolveDirectDmAuthorizationOutcome,
  resolveSenderCommandAuthorizationWithRuntime,
} from "./command-auth.js";
export { resolveChannelAccountConfigBasePath } from "./config-paths.js";
export { evaluateSenderGroupAccess } from "./group-access.js";
export type { SenderGroupAccessDecision } from "./group-access.js";
export { resolveInboundRouteEnvelopeBuilderWithRuntime } from "./inbound-envelope.js";
export { createChannelPairingController } from "./channel-pairing.js";
export { buildChannelSendResult } from "./channel-send-result.js";
export type { OutboundReplyPayload } from "./reply-payload.js";
export {
  deliverTextOrMediaReply,
  isNumericTargetId,
  resolveOutboundMediaUrls,
  sendMediaWithLeadingCaption,
  sendPayloadWithChunkedTextAndMedia,
} from "./reply-payload.js";
export {
  buildBaseAccountStatusSnapshot,
  buildTokenChannelStatusSummary,
} from "./status-helpers.js";
export { chunkTextForOutbound } from "./text-chunking.js";
export { extractToolSend } from "./tool-send.js";
export {
  applyBasicWebhookRequestGuards,
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  readJsonWebhookBodyOrReject,
  registerWebhookTarget,
  registerWebhookTargetWithPluginRoute,
  resolveSingleWebhookTarget,
  resolveWebhookPath,
  resolveWebhookTargetWithAuthOrRejectSync,
  resolveWebhookTargets,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  withResolvedWebhookRequestPipeline,
} from "./webhook-ingress.js";
export type {
  RegisterWebhookPluginRouteOptions,
  RegisterWebhookTargetOptions,
} from "./webhook-ingress.js";
