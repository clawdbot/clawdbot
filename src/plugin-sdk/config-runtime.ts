// Shared config/runtime boundary for plugins that need config loading,
// config writes, or session-store helpers without importing src internals.

export { resolveDefaultAgentId } from "../agents/agent-scope.js";
export {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  getRuntimeConfigSnapshot,
  loadConfig,
  readConfigFileSnapshotForWrite,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "../config/io.js";
export { logConfigUpdated } from "../config/logging.js";
export { updateConfig } from "../commands/models/shared.js";
export { resolveChannelModelOverride } from "../channels/model-overrides.js";
export {
  evaluateSupplementalContextVisibility,
  filterSupplementalContextItems,
} from "../security/context-visibility.js";
export {
  resolveChannelContextVisibilityMode,
  resolveDefaultContextVisibility,
} from "../config/context-visibility.js";
export { resolveMarkdownTableMode } from "../config/markdown-tables.js";
export {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
  type ChannelGroupPolicy,
} from "../config/group-policy.js";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "../config/runtime-group-policy.js";
export {
  isNativeCommandsExplicitlyDisabled,
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "../config/commands.js";
export {
  TELEGRAM_COMMAND_NAME_PATTERN,
  normalizeTelegramCommandName,
  resolveTelegramCustomCommands,
} from "./telegram-command-config.js";
export { resolveActiveTalkProviderConfig } from "../config/talk.js";
export { resolveAgentMaxConcurrent } from "../config/agent-limits.js";
export { loadCronStore, resolveCronStorePath, saveCronStore } from "../cron/store.js";
export { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
export { coerceSecretRef } from "../config/types.secrets.js";
export {
  resolveConfiguredSecretInputString,
  resolveConfiguredSecretInputWithFallback,
  resolveRequiredConfiguredSecretRefInputString,
} from "../gateway/resolve-configured-secret-input-string.js";
export type {
  BlockStreamingCoalesceConfig,
  DiscordAccountConfig,
  DiscordActionConfig,
  DiscordAutoPresenceConfig,
  DiscordConfig,
  DiscordExecApprovalConfig,
  DiscordGuildChannelConfig,
  DiscordGuildEntry,
  DiscordIntentsConfig,
  DiscordSlashCommandConfig,
  DmConfig,
  DmPolicy,
  ContextVisibilityMode,
  GroupPolicy,
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
  MarkdownConfig,
  MarkdownTableMode,
  OpenClawConfig,
  ReplyToMode,
  SignalReactionNotificationMode,
  SlackAccountConfig,
  SlackChannelConfig,
  SlackReactionNotificationMode,
  SlackSlashCommandConfig,
  TelegramAccountConfig,
  TelegramActionConfig,
  TelegramDirectConfig,
  TelegramExecApprovalConfig,
  TelegramGroupConfig,
  TelegramInlineButtonsScope,
  TelegramNetworkConfig,
  TelegramTopicConfig,
  TtsAutoMode,
  TtsConfig,
  TtsMode,
  TtsModelOverrideConfig,
  TtsProvider,
} from "../config/types.js";
export {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  saveSessionStore,
  updateLastRoute,
  updateSessionStore,
  resolveSessionStoreEntry,
} from "../config/sessions/store.js";
export { resolveSessionKey } from "../config/sessions/session-key.js";
export { resolveStorePath } from "../config/sessions/paths.js";
export type { SessionResetMode } from "../config/sessions/reset.js";
export type { SessionScope } from "../config/sessions/types.js";
export { resolveGroupSessionKey } from "../config/sessions/group.js";
export { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
export {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  resolveThreadFlag,
} from "../config/sessions/reset.js";
export {
  isDangerousNameMatchingEnabled,
  resolveDangerousNameMatchingEnabled,
} from "../config/dangerous-name-matching.js";
