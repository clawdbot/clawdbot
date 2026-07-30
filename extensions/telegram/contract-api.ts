// Telegram API module exposes the plugin public contract.
export {
  TELEGRAM_COMMAND_NAME_PATTERN,
  normalizeTelegramCommandDescription,
  normalizeTelegramCommandName,
  resolveTelegramCustomCommands,
} from "./src/command-config.js";
export { parseTelegramTopicConversation } from "./src/topic-conversation.js";
export { singleAccountKeysToMove } from "./src/setup-contract.js";
export { mergeTelegramAccountConfig } from "./src/accounts.js";
export {
  buildCommandsPaginationKeyboard,
  buildTelegramModelsProviderChannelData,
} from "./src/command-ui.js";
export type {
  TelegramInteractiveHandlerContext,
  TelegramInteractiveHandlerRegistration,
  TelegramInteractiveHandlerResult,
} from "./src/interactive-dispatch.js";
