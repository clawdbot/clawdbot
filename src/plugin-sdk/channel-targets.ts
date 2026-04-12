export {
  applyChannelMatchMeta,
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatch,
  resolveChannelEntryMatchWithFallback,
  resolveChannelMatchConfig,
  resolveNestedAllowlistDecision,
  type ChannelEntryMatch,
  type ChannelMatchSource,
} from "../channels/channel-config.js";
export {
  buildMessagingTarget,
  ensureTargetId,
  normalizeTargetId,
  parseAtUserTarget,
  parseMentionPrefixOrAtUserTarget,
  parseTargetMention,
  parseTargetPrefix,
  parseTargetPrefixes,
  requireTargetKind,
  type MessagingTarget,
  type MessagingTargetKind,
  type MessagingTargetParseOptions,
} from "../channels/targets.js";
export {
  createAllowedChatSenderMatcher,
  parseChatAllowTargetPrefixes,
  parseChatTargetPrefixesOrThrow,
  resolveServicePrefixedAllowTarget,
  resolveServicePrefixedChatTarget,
  resolveServicePrefixedOrChatAllowTarget,
  resolveServicePrefixedTarget,
  type ChatSenderAllowParams,
  type ChatTargetPrefixesParams,
  type ParsedChatAllowTarget,
  type ParsedChatTarget,
  type ServicePrefix,
} from "../channels/plugins/chat-target-prefixes.js";
export type { ChannelId } from "../channels/plugins/types.public.js";
export { normalizeChannelId } from "../channels/plugins/registry.js";
export {
  buildUnresolvedTargetResults,
  resolveTargetsWithOptionalToken,
} from "../channels/plugins/target-resolvers.js";
