export { qqbotPlugin } from "./src/channel.js";
export { qqbotSetupPlugin } from "./src/channel.setup.js";
export { getFrameworkCommands } from "./src/engine/commands/slash-commands-impl.js";
export { registerChannelTool } from "./src/bridge/tools/channel.js";
export { registerRemindTool } from "./src/bridge/tools/remind.js";
export { registerQQBotTools } from "./src/bridge/tools/index.js";
export { registerQQBotFull } from "./src/bridge/channel-entry.js";
export {
  type AudioFormatPolicy,
  type C2CMessageEvent,
  type GroupMessageEvent,
  type GuildMessageEvent,
  type MessageAttachment,
  type QQBotAccountConfig,
  type QQBotConfig,
  type QQBotDmPolicy,
  type QQBotExecApprovalConfig,
  type QQBotGroupPolicy,
  type ResolvedQQBotAccount,
  type WSPayload,
} from "./src/types.js";
export {
  applyQQBotAccountConfig,
  DEFAULT_ACCOUNT_ID,
  listQQBotAccountIds,
  resolveDefaultQQBotAccountId,
  resolveQQBotAccount,
} from "./src/bridge/config.js";
export {
  buildMediaTarget,
  checkMessageReplyLimit,
  DEFAULT_MEDIA_SEND_ERROR,
  getMessageReplyConfig,
  getMessageReplyStats,
  type MediaOutboundContext,
  type MediaTargetContext,
  MESSAGE_REPLY_LIMIT,
  OUTBOUND_ERROR_CODES,
  type OutboundContext,
  type OutboundErrorCode,
  type OutboundResult,
  parseTarget,
  recordMessageReply,
  type ReplyLimitResult,
  resolveOutboundMediaPath,
  resolveUserFacingMediaError,
  sendCronMessage,
  sendDocument,
  sendMedia,
  sendPhoto,
  sendProactiveMessage,
  sendText,
  sendVideoMsg,
  sendVoice,
  setOutboundAudioPort,
} from "./src/engine/messaging/outbound.js";
