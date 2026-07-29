// Telegram bot handler composition.
import { createTelegramHandlerAuthorizationRuntime } from "./bot-handlers.authorization.runtime.js";
import { registerTelegramCallbackQueryHandler } from "./bot-handlers.callback.runtime.js";
import { createTelegramHandlerInboundRuntime } from "./bot-handlers.inbound.runtime.js";
import { registerTelegramMessageHandlers } from "./bot-handlers.message-events.runtime.js";
import { createTelegramHandlerMessageRuntime } from "./bot-handlers.message.runtime.js";
import { registerTelegramMigrationHandler } from "./bot-handlers.migration.runtime.js";
import { registerTelegramReactionHandler } from "./bot-handlers.reaction.runtime.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";

export const registerTelegramHandlers = (params: RegisterTelegramHandlerParams) => {
  const messageRuntime = createTelegramHandlerMessageRuntime(params);
  const authorizationRuntime = createTelegramHandlerAuthorizationRuntime(params);
  const inboundRuntime = createTelegramHandlerInboundRuntime(params, messageRuntime);

  registerTelegramReactionHandler(params, authorizationRuntime);
  registerTelegramCallbackQueryHandler(params, messageRuntime, authorizationRuntime);
  registerTelegramMigrationHandler(params);
  registerTelegramMessageHandlers(params, messageRuntime, authorizationRuntime, inboundRuntime);
};
