// Googlechat plugin module implements channeleps behavior.
export {
  buildChannelConfigSchema,
  chunkTextForOutbound,
  DEFAULT_ACCOUNT_ID,
  GoogleChatConfigSchema,
  missingTargetError,
  PAIRING_APPROVED_MESSAGE,
  type ChannelMessageActionAdapter,
  type ChannelStatusIssue,
  type OpenClawConfig,
} from "../runtime-api.js";
export {
  listGoogleChatAccountIds,
  resolveGoogleChatAccount,
  type ResolvedGoogleChatAccount,
} from "./accounts.js";
export {
  isGoogleChatSpaceTarget,
  isGoogleChatUserTarget,
  normalizeGoogleChatTarget,
  resolveGoogleChatOutboundSessionRoute,
  resolveGoogleChatOutboundSpace,
} from "./targets.js";
