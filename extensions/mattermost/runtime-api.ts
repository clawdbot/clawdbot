// Private runtime barrel for the bundled Mattermost extension.
// Keep this barrel thin and generic-only.

export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionName,
  ChannelPlugin,
  ChatType,
  HistoryEntry,
  OpenClawConfig,
  OpenClawPluginApi,
  PluginRuntime,
} from "openclaw/plugin-sdk/core";
export type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
export type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
export type { ModelsProviderData } from "openclaw/plugin-sdk/command-auth";
export type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
} from "openclaw/plugin-sdk/config-runtime";
export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  createDedupeCache,
  parseStrictPositiveInteger,
  resolveClientIp,
  isTrustedProxyAddress,
} from "openclaw/plugin-sdk/core";
export { buildComputedAccountStatusSnapshot } from "openclaw/plugin-sdk/channel-status";
export { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
export { buildAgentMediaPayload } from "openclaw/plugin-sdk/agent-media-payload";
export {
  buildModelsProviderData,
  listSkillCommandsForAgents,
  resolveControlCommandGate,
  resolveStoredModelOverride,
} from "openclaw/plugin-sdk/command-auth";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  isDangerousNameMatchingEnabled,
  loadSessionStore,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveStorePath,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/config-runtime";
export { formatInboundFromLabel } from "openclaw/plugin-sdk/channel-inbound";
export { logInboundDrop } from "openclaw/plugin-sdk/channel-inbound";
export { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
export {
  DM_GROUP_ACCESS_REASON,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
} from "openclaw/plugin-sdk/channel-policy";
export { evaluateSenderGroupAccessForPolicy } from "openclaw/plugin-sdk/group-access";
export { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
export { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
export { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
export { rawDataToString } from "openclaw/plugin-sdk/browser-node-runtime";
export { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
export {
  DEFAULT_GROUP_HISTORY_LIMIT,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
export { normalizeAccountId, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
export { resolveAllowlistMatchSimple } from "openclaw/plugin-sdk/allow-from";
export { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-targets";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
} from "openclaw/plugin-sdk/webhook-ingress";
export {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
} from "openclaw/plugin-sdk/setup";
export {
  getAgentScopedMediaLocalRoots,
  resolveChannelMediaMaxBytes,
} from "openclaw/plugin-sdk/media-runtime";
export { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
export { setMattermostRuntime } from "./src/runtime.js";
