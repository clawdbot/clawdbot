import { createTelegramCallbackRouter } from "./bot-handlers.callback-router.js";
import { createTelegramEventBindings } from "./bot-handlers.event-bindings.js";
import { createTelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import {
  createTelegramInboundPipeline,
  registerTelegramInboundHandlers,
} from "./bot-handlers.inbound-pipeline.js";
import { createTelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";

export const registerTelegramHandlers = (params: RegisterTelegramHandlerParams) => {
  const message = createTelegramMessagePipeline(params);
  const authorization = createTelegramHandlerAuthorization(params);
  const inboundPipeline = createTelegramInboundPipeline({ params, message, authorization });
  const callbackRouter = createTelegramCallbackRouter({ params, message, authorization });
  const eventBindings = createTelegramEventBindings({
    params,
    message,
    authorization,
    registerMessages: () =>
      registerTelegramInboundHandlers({ bot: params.bot, pipeline: inboundPipeline }),
  });

  eventBindings.registerChatMembership();
  eventBindings.registerReaction();
  eventBindings.registerPolls();
  params.bot.on("callback_query", async (ctx) => {
    await callbackRouter.route(ctx);
  });
  eventBindings.registerMigration();
  eventBindings.registerMessages();
};
