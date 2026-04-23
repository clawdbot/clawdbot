// Shared config/runtime boundary for plugins that need config loading,
// config writes, or session-store helpers without importing src internals.

import type { OpenClawConfig } from "../config/types.js";

export function requireRuntimeConfig(config: OpenClawConfig, context: string): OpenClawConfig {
  if (config) {
    return config;
  }
  throw new Error(
    `${context} requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.`,
  );
}

export function resolvePluginConfigObject(
  config: OpenClawConfig | undefined,
  pluginId: string,
): Record<string, unknown> | undefined {
  const plugins =
    config?.plugins && typeof config.plugins === "object" && !Array.isArray(config.plugins)
      ? (config.plugins as Record<string, unknown>)
      : undefined;
  const entries =
    plugins?.entries && typeof plugins.entries === "object" && !Array.isArray(plugins.entries)
      ? (plugins.entries as Record<string, unknown>)
      : undefined;
  const entry = entries?.[pluginId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const pluginConfig = (entry as { config?: unknown }).config;
  return pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig)
    ? (pluginConfig as Record<string, unknown>)
    : undefined;
}

export function resolveLivePluginConfigObject(
  runtimeConfigLoader: (() => OpenClawConfig | undefined) | undefined,
  pluginId: string,
  startupPluginConfig?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof runtimeConfigLoader !== "function") {
    return startupPluginConfig;
  }
  return resolvePluginConfigObject(runtimeConfigLoader(), pluginId);
}

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
