import { splitTelegramPlainTextChunks } from "./rich-plain-fallback.js";

export { buildInlineKeyboard } from "./inline-keyboard.js";
export {
  resetTelegramClientOptionsCacheForTests,
  type TelegramApiOverride,
} from "./send-context.js";
export {
  deleteMessageTelegram,
  pinMessageTelegram,
  reactMessageTelegram,
  sendTypingTelegram,
  unpinMessageTelegram,
} from "./send-actions.js";
export {
  editForumTopicTelegram,
  renameForumTopicTelegram,
  createForumTopicTelegram,
} from "./send-forum-topics.js";
export { editMessageReplyMarkupTelegram, editMessageTelegram } from "./send-edit.js";
export { sendLocationTelegram } from "./send-location.js";
export { sendMessageTelegram } from "./send-message.js";
export { sendPollTelegram, sendStickerTelegram } from "./send-special.js";

// Test-only handle: the plain-text splitter is internal, but its surrogate-safe
// chunk boundary needs direct behavior coverage.
export function splitTelegramPlainTextChunksForTests(text: string, limit: number): string[] {
  return splitTelegramPlainTextChunks(text, limit);
}
