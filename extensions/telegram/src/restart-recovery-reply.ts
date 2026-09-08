import type { Message } from "grammy/types";
import type { ChannelRecoveryReplyContext } from "openclaw/plugin-sdk/channel-contract";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramReplyContext } from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
import { buildTypingThreadParams, resolveTelegramStreamMode } from "./bot/helpers.js";
import { withTelegramApiContext } from "./send-context.js";
import { parseTelegramTarget } from "./targets.js";

/** Reuse normal presentation without fabricating a new user, command, or reply ancestry. */
export async function dispatchTelegramRecoveryReply(
  params: ChannelRecoveryReplyContext,
): Promise<void> {
  await withTelegramApiContext(
    { cfg: params.cfg, accountId: params.accountId, signal: params.abortSignal },
    async ({ api, account }) => {
      const target = parseTelegramTarget(params.to);
      const chatId = Number(target.chatId);
      if (!Number.isSafeInteger(chatId) || chatId === 0) {
        throw new Error("Telegram recovery requires the observed numeric conversation target");
      }
      const threadId = params.threadId != null ? Number(params.threadId) : target.messageThreadId;
      if (threadId !== undefined && (!Number.isSafeInteger(threadId) || threadId <= 0)) {
        throw new Error("Telegram recovery thread is invalid");
      }
      const isGroup = target.chatType === "group" && target.directMessagesTopicId === undefined;
      const threadSpec: TelegramReplyContext["threadSpec"] =
        target.directMessagesTopicId !== undefined
          ? { scope: "direct-messages", id: target.directMessagesTopicId }
          : { scope: isGroup ? "forum" : "dm", id: threadId };
      const msg: Message = {
        message_id: 0,
        date: Math.floor(Date.now() / 1000),
        chat: isGroup
          ? { id: chatId, type: "supergroup", title: "" }
          : { id: chatId, type: "private", first_name: "" },
      };
      const context: TelegramReplyContext = {
        cfg: params.cfg,
        ctxPayload: finalizeInboundContext({
          Provider: "telegram",
          Surface: "telegram",
          AccountId: account.accountId,
          SessionKey: params.sessionKey,
          From: params.to,
          To: params.to,
          OriginatingChannel: "telegram",
          OriginatingTo: params.to,
          ChatType: isGroup ? "group" : "direct",
          MessageThreadId: threadSpec.id,
          TransportThreadId: threadSpec.id,
          InternalTurnSource: "restart-recovery" as const,
          InboundEventKind: "user_request" as const,
          BodyForAgent: "Continue the interrupted response.",
          BodyForCommands: "",
          RawBody: "",
          CommandBody: "",
          CommandAuthorized: false,
          InputProvenance: {
            kind: "internal_system" as const,
            sourceSessionKey: params.sessionKey,
            sourceTool: "main-session-restart-recovery",
          },
          Body: "Continue the interrupted response.",
        }),
        primaryCtx: {},
        msg,
        chatId,
        isGroup,
        isForum: isGroup && threadId !== undefined,
        route: {
          agentId: params.agentId,
          accountId: account.accountId,
          sessionKey: params.sessionKey,
        },
        turn: { record: { onRecordError: (error) => defaultRuntime.error?.(String(error)) } },
        resolvedThreadId: threadSpec.id,
        replyThreadId: threadSpec.id,
        threadSpec,
        historyLimit: 0,
        groupHistories: new Map(),
        skillFilter: undefined,
        sendTyping: async () => {
          await api.sendChatAction(chatId, "typing", buildTypingThreadParams(threadSpec.id));
        },
        sendRecordVoice: async () => {
          await api.sendChatAction(chatId, "record_voice", buildTypingThreadParams(threadSpec.id));
        },
        sendChatActionHandler: {
          sendChatAction: async (...args) => {
            await api.sendChatAction(...args);
          },
        },
        ackReactionPromise: null,
        reactionApi: null,
        statusReactionController: null,
        accountId: account.accountId,
      };
      await dispatchTelegramMessage({
        context,
        bot: { api },
        cfg: params.cfg,
        runtime: defaultRuntime,
        replyToMode: "off",
        streamMode: resolveTelegramStreamMode(account.config),
        textLimit: account.config.textChunkLimit ?? 4000,
        telegramCfg: account.config,
        opts: { token: account.token, dispatchReplyFromConfig: params.dispatchReplyFromConfig },
        turnAdoptionLifecycle: { onAdopted: () => {}, abortSignal: params.abortSignal },
      });
    },
  );
}
