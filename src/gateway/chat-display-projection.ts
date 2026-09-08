// Public chat display projection facade.
export { augmentChatHistoryWithCanvasBlocks } from "./chat-display-projection.canvas.js";
export {
  createCurrentUserProfileMessageProjector,
  isPendingAssistantError,
  projectChatDisplayMessage,
  projectChatDisplayMessages,
  projectChatDisplayMessagesWithState,
} from "./chat-display-projection.core.js";
export {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  resolveEffectiveChatHistoryMaxChars,
} from "./chat-display-projection.helpers.js";
export {
  dropPreSessionStartAnnouncePairs,
  isHeartbeatHistoryTurnBoundaryMessage,
} from "./chat-display-projection.history.js";
export { sanitizeChatHistoryMessages } from "./chat-display-projection.sanitize.js";
