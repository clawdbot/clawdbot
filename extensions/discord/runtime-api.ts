// Discord API module exposes the plugin public contract.
export { handleDiscordAction } from "./src/actions/runtime.js";
export {
  isDiscordModerationAction,
  readDiscordModerationCommand,
  requiredGuildPermissionForModerationAction,
  type DiscordModerationAction,
  type DiscordModerationCommand,
} from "./src/actions/runtime.moderation-shared.js";
export {
  readDiscordChannelCreateParams,
  readDiscordChannelEditParams,
  readDiscordChannelMoveParams,
  readDiscordParentIdParam,
} from "./src/actions/runtime.shared.js";
export { discordMessageActions } from "./src/channel-actions.js";
export { auditDiscordChannelPermissions, collectDiscordAuditChannelIds } from "./src/audit.js";
export {
  listDiscordDirectoryGroupsLive,
  listDiscordDirectoryPeersLive,
} from "./src/directory-live.js";
export {
  fetchDiscordApplicationId,
  fetchDiscordApplicationSummary,
  parseApplicationIdFromToken,
  probeDiscord,
  resolveDiscordPrivilegedIntentsFromFlags,
  type DiscordApplicationSummary,
  type DiscordPrivilegedIntentsSummary,
  type DiscordPrivilegedIntentStatus,
  type DiscordProbe,
} from "./src/probe.js";
export {
  resolveDiscordChannelAllowlist,
  type DiscordChannelResolution,
} from "./src/resolve-channels.js";
export { resolveDiscordUserAllowlist, type DiscordUserResolution } from "./src/resolve-users.js";
export { setDiscordRuntime } from "./src/runtime.js";
export type {
  DiscordAllowList,
  DiscordChannelConfigResolved,
  DiscordGuildEntryResolved,
} from "./src/monitor/allow-list.js";
export {
  allowListMatches,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordChannelConfig,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordCommandAuthorized,
  resolveDiscordGuildEntry,
  resolveDiscordShouldRequireMention,
  resolveGroupDmAllow,
  shouldEmitDiscordReactionNotification,
} from "./src/monitor/allow-list.js";
export type { DiscordMessageEvent, DiscordMessageHandler } from "./src/monitor/listeners.js";
export { registerDiscordListener } from "./src/monitor/listeners.js";

export { createDiscordMessageHandler } from "./src/monitor/message-handler.js";
export { createDiscordNativeCommand } from "./src/monitor/native-command.js";
export type { MonitorDiscordOpts } from "./src/monitor/provider.js";
export { monitorDiscordProvider } from "./src/monitor/provider.js";

export { resolveDiscordReplyTarget, sanitizeDiscordThreadName } from "./src/monitor/threading.js";
export {
  createDiscordGatewayPlugin,
  resolveDiscordGatewayIntents,
  waitForDiscordGatewayPluginRegistration,
} from "./src/monitor/gateway-plugin.js";
export {
  clearGateways,
  getGateway,
  registerGateway,
  unregisterGateway,
} from "./src/monitor/gateway-registry.js";
export {
  clearPresences,
  getPresence,
  presenceCacheSize,
  setPresence,
} from "./src/monitor/presence-cache.js";
export {
  DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
  DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
  DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS,
  DISCORD_DEFAULT_LISTENER_TIMEOUT_MS,
  isAbortError,
  normalizeDiscordInboundWorkerTimeoutMs,
  normalizeDiscordListenerTimeoutMs,
  runDiscordTaskWithTimeout,
} from "./src/monitor/timeouts.js";
export {
  resolveDiscordOutboundSessionRoute,
  type ResolveDiscordOutboundSessionRouteParams,
} from "./src/outbound-session-route.js";
export {
  addRoleDiscord,
  banMemberDiscord,
  createChannelDiscord,
  createScheduledEventDiscord,
  createThreadDiscord,
  deleteChannelDiscord,
  deleteMessageDiscord,
  DiscordSendError,
  editChannelDiscord,
  editMessageDiscord,
  fetchChannelInfoDiscord,
  fetchChannelPermissionsDiscord,
  fetchMemberGuildPermissionsDiscord,
  fetchMemberInfoDiscord,
  fetchMessageDiscord,
  fetchReactionsDiscord,
  fetchRoleInfoDiscord,
  fetchVoiceStatusDiscord,
  hasAllGuildPermissionsDiscord,
  hasAnyGuildPermissionDiscord,
  kickMemberDiscord,
  listGuildChannelsDiscord,
  listGuildEmojisDiscord,
  listPinsDiscord,
  listScheduledEventsDiscord,
  listThreadsDiscord,
  moveChannelDiscord,
  pinMessageDiscord,
  reactMessageDiscord,
  readMessagesDiscord,
  removeChannelPermissionDiscord,
  removeOwnReactionsDiscord,
  removeReactionDiscord,
  removeRoleDiscord,
  resolveEventCoverImage,
  searchMessagesDiscord,
  sendMessageDiscord,
  sendPollDiscord,
  sendStickerDiscord,
  sendTypingDiscord,
  sendVoiceMessageDiscord,
  sendWebhookMessageDiscord,
  setChannelPermissionDiscord,
  timeoutMemberDiscord,
  unpinMessageDiscord,
  uploadEmojiDiscord,
  uploadStickerDiscord,
  type DiscordChannelCreate,
  type DiscordChannelEdit,
  type DiscordChannelMove,
  type DiscordChannelPermissionSet,
  type DiscordEmojiUpload,
  type DiscordMessageEdit,
  type DiscordMessageQuery,
  type DiscordModerationTarget,
  type DiscordPermissionsSummary,
  type DiscordReactionRuntimeContext,
  type DiscordReactionSummary,
  type DiscordReactionUser,
  type DiscordReactOpts,
  type DiscordRoleChange,
  type DiscordRuntimeAccountContext,
  type DiscordSearchQuery,
  type DiscordSendResult,
  type DiscordStickerUpload,
  type DiscordThreadCreate,
  type DiscordThreadList,
  type DiscordTimeoutTarget,
} from "./src/send.js";
export {
  editDiscordComponentMessage,
  registerBuiltDiscordComponentMessage,
  sendDiscordComponentMessage,
} from "./src/send.components.js";
export {
  autoBindSpawnedDiscordSubagent,
  createNoopThreadBindingManager,
  createThreadBindingManager,
  formatThreadBindingDurationLabel,
  getThreadBindingManager,
  listThreadBindingsBySessionKey,
  listThreadBindingsForAccount,
  reconcileAcpThreadBindingsOnStartup,
  resolveDiscordThreadBindingIdleTimeoutMs,
  resolveDiscordThreadBindingMaxAgeMs,
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingInactivityExpiresAt,
  resolveThreadBindingIntroText,
  resolveThreadBindingMaxAgeExpiresAt,
  resolveThreadBindingMaxAgeMs,
  resolveThreadBindingPersona,
  resolveThreadBindingPersonaFromRecord,
  resolveThreadBindingsEnabled,
  resolveThreadBindingThreadName,
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingMaxAgeBySessionKey,
  unbindThreadBindingsBySessionKey,
  type AcpThreadBindingReconciliationResult,
  type ThreadBindingManager,
  type ThreadBindingRecord,
  type ThreadBindingTargetKind,
} from "./src/monitor/thread-bindings.js";
