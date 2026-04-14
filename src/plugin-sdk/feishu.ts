// Private helper surface for the bundled feishu plugin.
// Keep this list additive and scoped to the bundled Feishu surface.

export type { HistoryEntry } from "../auto-reply/reply/history.js";
export {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
} from "../auto-reply/reply/history.js";
export type { ReplyPayload } from "../auto-reply/reply-payload.js";
export { logTypingFailure } from "../channels/logging.js";
export type { AllowlistMatch } from "../channels/plugins/allowlist-match.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { createActionGate } from "../agents/tools/common.js";
export { chunkTextForOutbound } from "./text-chunking.js";
export {
  buildSingleChannelSecretPromptState,
  addWildcardAllowFrom,
  mergeAllowFromEntries,
  promptSingleChannelSecretInput,
  setTopLevelChannelAllowFrom,
  setTopLevelChannelDmPolicyWithAllowFrom,
  setTopLevelChannelGroupPolicy,
  splitSetupEntries,
} from "../channels/plugins/setup-wizard-helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export type {
  BaseProbeResult,
  ChannelGroupContext,
  ChannelMessageActionName,
  ChannelMeta,
  ChannelOutboundAdapter,
} from "../channels/plugins/types.public.js";
export type {
  ChannelConfiguredBindingProvider,
  ChannelConfiguredBindingConversationRef,
  ChannelConfiguredBindingMatch,
} from "../channels/plugins/types.adapters.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createReplyPrefixContext } from "../channels/reply-prefix.js";
export { createChannelReplyPipeline } from "./channel-reply-pipeline.js";
export type { OpenClawConfig as ClawdbotConfig, OpenClawConfig } from "../config/config.js";
export { resolveChannelContextVisibilityMode } from "../config/context-visibility.js";
export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export {
  evaluateSupplementalContextVisibility,
  filterSupplementalContextItems,
  shouldIncludeSupplementalContext,
  type ContextVisibilityKind,
} from "../security/context-visibility.js";
export type { DmPolicy, GroupToolPolicyConfig } from "../config/types.js";
export type { SecretInput } from "./secret-input.js";
export {
  buildSecretInputSchema,
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "./secret-input.js";
export { createDedupeCache } from "../infra/dedupe.js";
export { installRequestBodyLimitGuard, readJsonBodyWithLimit } from "../infra/http-body.js";
export { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
export { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
export type { OutboundIdentity } from "../infra/outbound/identity.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { AnyAgentTool, OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID, normalizeAgentId } from "../routing/session-key.js";
export type { RuntimeEnv } from "../runtime.js";
export { formatDocsLink } from "../terminal/links.js";
export { evaluateSenderGroupAccessForPolicy } from "./group-access.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { createClackPrompter } from "../wizard/clack-prompter.js";
export { feishuSetupWizard, feishuSetupAdapter } from "./feishu-setup.js";
export { buildAgentMediaPayload } from "./agent-media-payload.js";
export { readJsonFileWithFallback } from "./json-store.js";
export { createChannelPairingController } from "./channel-pairing.js";
export { createPersistentDedupe } from "./persistent-dedupe.js";
export {
  buildBaseChannelStatusSummary,
  buildProbeChannelStatusSummary,
  buildRuntimeAccountStatusSnapshot,
  createDefaultChannelRuntimeState,
} from "./status-helpers.js";
export { withTempDownloadPath } from "./temp-path.js";
export {
  buildFeishuConversationId,
  createFeishuThreadBindingManager,
  parseFeishuDirectConversationId,
  parseFeishuConversationId,
  parseFeishuTargetId,
} from "./feishu-conversation.js";
export {
  createWebhookAnomalyTracker,
  createFixedWindowRateLimiter,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "./webhook-ingress.js";
export { applyBasicWebhookRequestGuards } from "./webhook-ingress.js";
