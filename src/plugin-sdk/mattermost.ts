// Private helper surface for the bundled mattermost plugin.
// Keep this list additive and scoped to the bundled Mattermost surface.

export { formatInboundFromLabel } from "../auto-reply/envelope.js";
export type { HistoryEntry } from "../auto-reply/reply/history.js";
export {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
} from "../auto-reply/reply/history.js";
export { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
export type { ReplyPayload } from "../auto-reply/reply-payload.js";
export type { ChatType } from "../channels/chat-type.js";
export { resolveControlCommandGate } from "../channels/command-gating.js";
export { logInboundDrop, logTypingFailure } from "../channels/logging.js";
export { resolveAllowlistMatchSimple } from "../channels/plugins/allowlist-match.js";
export { normalizeProviderId } from "../agents/model-selection.js";
export {
  buildModelsProviderData,
  type ModelsProviderData,
} from "../auto-reply/reply/commands-models.js";
export { resolveStoredModelOverride } from "../auto-reply/reply/stored-model-override.js";
export {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
export { buildChannelConfigSchema } from "../channels/plugins/config-schema.js";
export { formatPairingApproveHint } from "../channels/plugins/helpers.js";
export { chunkTextForOutbound } from "./text-chunking.js";
export { resolveChannelMediaMaxBytes } from "../channels/plugins/media-limits.js";
export {
  buildSingleChannelSecretPromptState,
  promptSingleChannelSecretInput,
  runSingleChannelSecretStep,
} from "../channels/plugins/setup-wizard-helpers.js";
export {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  createSetupInputPresenceValidator,
  migrateBaseNameToDefaultAccount,
} from "../channels/plugins/setup-helpers.js";
export { createAccountStatusSink } from "./channel-lifecycle.core.js";
export { buildComputedAccountStatusSnapshot } from "./status-helpers.js";
export { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "../channels/plugins/types.public.js";
export type { ChannelDirectoryEntry } from "../channels/plugins/types.core.js";
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
export { createChannelReplyPipeline } from "./channel-reply-pipeline.js";
export type { OpenClawConfig } from "../config/config.js";
export { isDangerousNameMatchingEnabled } from "../config/dangerous-name-matching.js";
export { loadSessionStore, resolveStorePath } from "../config/sessions.js";
export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export type { BlockStreamingCoalesceConfig, DmPolicy, GroupPolicy } from "../config/types.js";
export {
  BlockStreamingCoalesceSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  requireOpenAllowFrom,
} from "../config/zod-schema.core.js";
export { createDedupeCache } from "../infra/dedupe.js";
export { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
export { rawDataToString } from "../infra/ws.js";
export { isLoopbackHost, isTrustedProxyAddress, resolveClientIp } from "../gateway/net.js";
export { registerPluginHttpRoute } from "../plugins/http-registry.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export type { PluginRuntime } from "../plugins/runtime/types.js";
export type { OpenClawPluginApi } from "../plugins/types.js";
export {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  resolveThreadSessionKeys,
} from "../routing/session-key.js";
export type { RuntimeEnv } from "../runtime.js";
export {
  DM_GROUP_ACCESS_REASON,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
} from "../security/dm-policy-shared.js";
export { evaluateSenderGroupAccessForPolicy } from "./group-access.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export { buildAgentMediaPayload } from "./agent-media-payload.js";
export { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
export { loadOutboundMediaFromUrl } from "./outbound-media.js";
export { createChannelPairingController } from "./channel-pairing.js";
export { isRequestBodyLimitError, readRequestBodyWithLimit } from "../infra/http-body.js";
