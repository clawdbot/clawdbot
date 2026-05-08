export { imessagePlugin } from "./src/channel.js";
export { imessageSetupPlugin } from "./src/channel.setup.js";
export {
  listEnabledIMessageAccounts,
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  type ResolvedIMessageAccount,
  resolveIMessageAccount,
} from "./src/accounts.js";
export {
  __testing,
  createIMessageConversationBindingManager,
} from "./src/conversation-bindings.js";
export {
  matchIMessageAcpConversation,
  normalizeIMessageAcpConversationId,
  resolveIMessageConversationIdFromTarget,
  resolveIMessageInboundConversationId,
} from "./src/conversation-id.js";
export {
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "./src/group-policy.js";
export { looksLikeIMessageTargetId, normalizeIMessageMessagingTarget } from "./src/normalize.js";
export { IMESSAGE_LEGACY_OUTBOUND_SEND_DEP_KEYS } from "./src/outbound-send-deps.js";
export {
  DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS,
  type IMessageProbe,
  type IMessageProbeOptions,
  probeIMessage,
} from "./src/probe.js";
export {
  type ChatSenderAllowParams,
  type ChatTargetPrefixesParams,
  createAllowedChatSenderMatcher,
  parseChatAllowTargetPrefixes,
  parseChatTargetPrefixesOrThrow,
  type ParsedChatAllowTarget,
  type ParsedChatTarget,
  resolveServicePrefixedAllowTarget,
  resolveServicePrefixedChatTarget,
  resolveServicePrefixedOrChatAllowTarget,
  resolveServicePrefixedTarget,
  type ServicePrefix,
} from "./src/target-parsing-helpers.js";
export {
  formatIMessageChatTarget,
  type IMessageAllowTarget,
  type IMessageService,
  type IMessageTarget,
  inferIMessageTargetChatType,
  isAllowedIMessageSender,
  looksLikeIMessageExplicitTargetId,
  normalizeIMessageHandle,
  parseIMessageAllowTarget,
  parseIMessageTarget,
} from "./src/targets.js";
export { IMESSAGE_ACTION_NAMES, IMESSAGE_ACTIONS } from "./src/actions-contract.js";
