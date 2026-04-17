export { normalizeCompatibilityConfig, legacyConfigRules } from "./src/doctor-contract.js";
export {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "./src/secret-contract.js";
export {
  TELEGRAM_COMMAND_NAME_PATTERN,
  normalizeTelegramCommandDescription,
  normalizeTelegramCommandName,
  resolveTelegramCustomCommands,
} from "./src/command-config.js";
export {
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
} from "./src/directory-config.js";
export { parseTelegramTopicConversation } from "./src/topic-conversation.js";
export { singleAccountKeysToMove } from "./src/setup-contract.js";
export { mergeTelegramAccountConfig } from "./src/accounts.js";
export {
  buildCommandsPaginationKeyboard,
  buildTelegramModelsProviderChannelData,
} from "./src/command-ui.js";
export {
  createTelegramThreadBindingManager,
  resetTelegramThreadBindingsForTests,
} from "./src/thread-bindings.js";
export type {
  TelegramInteractiveHandlerContext,
  TelegramInteractiveHandlerRegistration,
} from "./src/interactive-dispatch.js";
export { collectTelegramSecurityAuditFindings } from "./src/security-audit.js";
