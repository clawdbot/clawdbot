/**
 * Runtime dependency barrel for the embedded Gateway stub.
 *
 * Tests mock this module to exercise local sessions.list/sessions.resolve/sessions.search/chat.history
 * behavior without importing the full Gateway server graph.
 */
export { resolveDefaultAgentId, resolveSessionAgentId } from "../../agents/agent-scope.js";
export { getRuntimeConfig } from "../../config/config.js";
export { searchSessionTranscripts } from "../../config/sessions/session-transcript-search.js";
export {
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
} from "../../gateway/session-store-key.js";
export {
  dropPreSessionStartAnnouncePairs,
  projectChatDisplayMessages,
  projectRecentChatDisplayMessages,
  resolveEffectiveChatHistoryMaxChars,
} from "../../gateway/chat-display-projection.js";
export { augmentChatHistoryWithCliSessionImports } from "../../gateway/cli-session-history.js";
export { getMaxChatHistoryMessagesBytes } from "../../gateway/server-constants.js";
export {
  augmentChatHistoryWithCanvasBlocks,
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES,
  enforceChatHistoryFinalBudget,
  replaceOversizedChatHistoryMessages,
} from "../../gateway/server-methods/chat.js";
export {
  capArrayByJsonBytes,
  readRecentSessionMessagesWithStatsAsync,
  readSessionMessagesPageWithStatsAsync,
  readSessionMessagesAsync,
} from "../../gateway/session-transcript-readers.js";
export {
  listSessionsFromStoreAsync,
  loadCombinedSessionStoreForGateway,
  loadSessionEntry,
  resolveSessionModelRef,
} from "../../gateway/session-utils.js";
export { resolveSessionKeyFromResolveParams } from "../../gateway/sessions-resolve.js";
export type { SessionsListResult } from "../../gateway/session-utils.types.js";
