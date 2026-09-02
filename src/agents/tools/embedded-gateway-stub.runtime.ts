/**
 * Runtime dependency barrel for the embedded Gateway stub.
 *
 * Tests mock this module to exercise local sessions.list/sessions.resolve/sessions.search/chat.history
 * behavior without importing the full Gateway server graph.
 */
export { resolveSessionAgentId } from "../../agents/agent-scope.js";
export { getRuntimeConfig } from "../../config/config.js";
export { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
export { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
export {
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
} from "../../gateway/session-store-key.js";
export { resolveEffectiveChatHistoryMaxChars } from "../../gateway/chat-display-projection.js";
export { getMaxChatHistoryMessagesBytes } from "../../gateway/server-constants.js";
export {
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  replaceOversizedChatHistoryMessages,
} from "../../gateway/server-methods/chat.js";
export {
  readChatHistoryPage,
  resolveChatHistoryNextOffset,
  shouldReplayOldestChatHistoryRecord,
} from "../../gateway/server-methods/chat-history-pages.js";
export { capArrayByJsonBytes } from "../../gateway/session-transcript-readers.js";
export {
  listSessionsFromStoreAsync,
  loadCombinedSessionStoreForGatewayCore,
  loadGatewaySessionEntryReadOnly as loadSessionEntry,
  resolveSessionModelRef,
} from "../../gateway/session-utils.js";
export { resolveSessionKeyFromResolveParams } from "../../gateway/sessions-resolve.js";
export type { SessionsListResult } from "../../gateway/session-utils.types.js";
