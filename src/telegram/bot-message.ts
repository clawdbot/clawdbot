// @ts-nocheck
import { buildTelegramMessageContext } from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import {
  diagnosticLogger as diag,
  logMessageProcessed,
  logMessageQueued,
  logSessionStateChange,
} from "../logging/diagnostic.js";

export const createTelegramMessageProcessor = (deps) => {
  const {
    bot,
    cfg,
    account,
    telegramCfg,
    historyLimit,
    groupHistories,
    dmPolicy,
    allowFrom,
    groupAllowFrom,
    ackReactionScope,
    logger,
    resolveGroupActivation,
    resolveGroupRequireMention,
    resolveTelegramGroupConfig,
    runtime,
    replyToMode,
    streamMode,
    textLimit,
    opts,
    resolveBotTopicsEnabled,
  } = deps;

  return async (primaryCtx, allMedia, storeAllowFrom, options) => {
    const chatId = primaryCtx?.message?.chat?.id ?? primaryCtx?.chat?.id ?? "unknown";
    const messageId = primaryCtx?.message?.message_id ?? "unknown";
    const startTime = Date.now();

    diag.info(
      `process message start: channel=telegram chatId=${chatId} messageId=${messageId} mediaCount=${
        allMedia?.length ?? 0
      }`,
    );

    let sessionKey: string | undefined;

    try {
      const context = await buildTelegramMessageContext({
        primaryCtx,
        allMedia,
        storeAllowFrom,
        options,
        bot,
        cfg,
        account,
        historyLimit,
        groupHistories,
        dmPolicy,
        allowFrom,
        groupAllowFrom,
        ackReactionScope,
        logger,
        resolveGroupActivation,
        resolveGroupRequireMention,
        resolveTelegramGroupConfig,
      });
      if (!context) {
        const durationMs = Date.now() - startTime;
        diag.debug(
          `process message skipped: channel=telegram chatId=${chatId} messageId=${messageId} reason=no_context`,
        );
        logMessageProcessed({
          channel: "telegram",
          chatId,
          messageId,
          durationMs,
          outcome: "skipped",
          reason: "no_context",
        });
        return;
      }

      sessionKey = context?.route?.sessionKey;
      diag.info(
        `process message dispatching: channel=telegram chatId=${chatId} messageId=${messageId} sessionKey=${
          sessionKey ?? "unknown"
        }`,
      );
      if (sessionKey) {
        logMessageQueued({ sessionKey, channel: "telegram", source: "telegram" });
      }

      await dispatchTelegramMessage({
        context,
        bot,
        cfg,
        runtime,
        replyToMode,
        streamMode,
        textLimit,
        telegramCfg,
        opts,
        resolveBotTopicsEnabled,
      });

      const durationMs = Date.now() - startTime;
      logMessageProcessed({
        channel: "telegram",
        chatId,
        messageId,
        sessionKey,
        durationMs,
        outcome: "completed",
      });
      if (sessionKey) {
        logSessionStateChange({
          sessionKey,
          state: "idle",
          reason: "message_completed",
        });
      }
      diag.info(
        `process message complete: channel=telegram chatId=${chatId} messageId=${messageId} sessionKey=${
          sessionKey ?? "unknown"
        } durationMs=${durationMs}`,
      );
    } catch (err) {
      const durationMs = Date.now() - startTime;
      logMessageProcessed({
        channel: "telegram",
        chatId,
        messageId,
        sessionKey,
        durationMs,
        outcome: "error",
        error: String(err),
      });
      if (sessionKey) {
        logSessionStateChange({
          sessionKey,
          state: "idle",
          reason: "message_error",
        });
      }
      diag.error(
        `process message error: channel=telegram chatId=${chatId} messageId=${messageId} durationMs=${durationMs} error="${String(
          err,
        )}"`,
      );
      throw err;
    }
  };
};
