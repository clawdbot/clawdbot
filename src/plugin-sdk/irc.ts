// Private helper surface for the bundled irc plugin.
// Keep this list additive and scoped to the bundled IRC surface.

export { resolveControlCommandGate } from "../channels/command-gating.js";
export { logInboundDrop } from "../channels/logging.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export {
  formatPairingApproveHint,
  parseOptionalDelimitedEntries,
} from "../channels/plugins/helpers.js";
export {
  addWildcardAllowFrom,
  setTopLevelChannelAllowFrom,
  setTopLevelChannelDmPolicyWithAllowFrom,
} from "../channels/plugins/setup-wizard-helpers.js";
export { PAIRING_APPROVED_MESSAGE } from "../channels/plugins/pairing-message.js";
export { patchScopedAccountConfig } from "../channels/plugins/setup-helpers.js";
export type { BaseProbeResult } from "../channels/plugins/types.public.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { getChatChannelMeta } from "./channel-plugin-common.js";
export { createChannelReplyPipeline } from "./channel-reply-pipeline.js";
export { chunkTextForOutbound } from "./text-chunking.js";
export type { OpenClawConfig } from "../config/config.js";
export { isDangerousNameMatchingEnabled } from "../config/dangerous-name-matching.js";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
  MarkdownConfig,
} from "../config/types.js";
export { normalizeResolvedSecretInputString } from "../config/types.secrets.js";
export { ToolPolicySchema } from "../config/zod-schema.agent-runtime.js";
export {
  BlockStreamingCoalesceSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyRuntimeConfigSchemaShape,
  requireOpenAllowFrom,
} from "../config/zod-schema.core.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
export type { RuntimeEnv } from "../runtime.js";
export { createAccountStatusSink, runPassiveAccountLifecycle } from "./channel-lifecycle.core.js";
export { listIrcAccountIds, resolveDefaultIrcAccountId, resolveIrcAccount } from "./irc-surface.js";
export {
  readStoreAllowFromForDmPolicy,
  resolveEffectiveAllowFromLists,
} from "../security/dm-policy-shared.js";
export { formatDocsLink } from "../terminal/links.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { createChannelPairingController } from "./channel-pairing.js";
export { dispatchInboundReplyWithBase } from "./inbound-reply-dispatch.js";
export { ircSetupAdapter, ircSetupWizard } from "./irc-surface.js";
export type { OutboundReplyPayload } from "./reply-payload.js";
export {
  createNormalizedOutboundDeliverer,
  deliverFormattedTextWithAttachments,
  formatTextWithAttachmentLinks,
  resolveOutboundMediaUrls,
} from "./reply-payload.js";
export { createLoggerBackedRuntime } from "./runtime.js";
export { buildBaseAccountStatusSnapshot, buildBaseChannelStatusSummary } from "./status-helpers.js";
