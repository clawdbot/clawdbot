// Telegram public-poll answer handler registration.
import type { ChatMember } from "grammy/types";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramHandlerAuthorizationRuntime } from "./bot-handlers.authorization.runtime.js";
import type { TelegramHandlerMessageRuntime } from "./bot-handlers.message.runtime.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import { getPreparedTelegramPollAnswer } from "./poll-answer-context.js";
import { findTelegramPollRegistryEntry, retireTelegramPollRegistryEntry } from "./poll-registry.js";

function isCurrentTelegramChatMember(member: ChatMember): boolean {
  return (
    member.status === "creator" ||
    member.status === "administrator" ||
    member.status === "member" ||
    (member.status === "restricted" && member.is_member)
  );
}

export function registerTelegramPollHandlers(
  { accountId, bot, runtime, telegramDeps, shouldSkipUpdate }: RegisterTelegramHandlerParams,
  messageRuntime: TelegramHandlerMessageRuntime,
  authorizationRuntime: TelegramHandlerAuthorizationRuntime,
) {
  const { resolveTelegramEventAuthorizationContext, authorizeTelegramEventSender } =
    authorizationRuntime;
  const { buildSyntheticTextMessage, buildSyntheticContext, processMessageWithReplyChain } =
    messageRuntime;

  bot.on("poll", async (ctx) => {
    try {
      const poll = ctx.poll;
      if (!poll?.is_closed || shouldSkipUpdate(ctx)) {
        return;
      }
      await retireTelegramPollRegistryEntry({ accountId, pollId: poll.id });
    } catch (err) {
      runtime.error?.(danger(`telegram poll handler failed: ${String(err)}`));
      if (isTelegramSpooledReplayUpdate(ctx.update)) {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
        return;
      }
      throw err;
    }
  });

  // Telegram emits poll_answer only for non-anonymous polls, and the update omits
  // chat/thread data. The send path records that origin in the keyed plugin store.
  bot.on("poll_answer", async (ctx) => {
    try {
      const pollAnswer = ctx.pollAnswer;
      if (!pollAnswer || shouldSkipUpdate(ctx)) {
        return;
      }
      const optionIds = pollAnswer.option_ids ?? [];
      const user = pollAnswer.user;
      // Retractions have no selection to route. Bot voters and voter_chat-only
      // answers have no user identity that can pass the sender authorization gate.
      if (optionIds.length === 0 || !user || user.is_bot) {
        return;
      }

      // A true miss is a safe no-op. Store failures throw so durable ingress can
      // release the claim and replay instead of permanently dropping the vote.
      const pollId = pollAnswer.poll_id;
      const prepared = getPreparedTelegramPollAnswer(ctx.update);
      const entry = prepared
        ? prepared.entry
        : await findTelegramPollRegistryEntry({ pollId, accountId });
      if (!entry) {
        logVerbose(`telegram: poll_answer for poll ${pollId} has no registry entry; skipping`);
        return;
      }

      const chatId = entry.chat.id;
      const isGroup = entry.chat.type === "group" || entry.chat.type === "supergroup";
      const senderId = user?.id != null ? String(user.id) : "";
      const senderUsername = user?.username ?? "";
      if (!isGroup && user.id !== chatId) {
        logVerbose(`Blocked forwarded telegram poll_answer for DM ${chatId} from ${senderId}`);
        return;
      }
      if (isGroup && !isCurrentTelegramChatMember(await bot.api.getChatMember(chatId, user.id))) {
        logVerbose(
          `Blocked forwarded telegram poll_answer for group ${chatId} from non-member ${senderId}`,
        );
        return;
      }
      const authorizationCfg = telegramDeps.getRuntimeConfig();
      const eventAuthContext = await resolveTelegramEventAuthorizationContext({
        cfg: authorizationCfg,
        chatId,
        isGroup,
        senderId,
        threadSpec: entry.threadSpec,
      });
      const senderAuthorization = await authorizeTelegramEventSender({
        chatId,
        chatTitle: "title" in entry.chat ? entry.chat.title : undefined,
        isGroup,
        senderId,
        senderUsername,
        // Poll votes and reactions are both user-originated updates attached to
        // bot-created UI, so they share the reaction authorization boundary.
        mode: "reaction",
        context: eventAuthContext,
      });
      if (!senderAuthorization) {
        return;
      }

      // poll_answer has no thread id. A DM poll without persisted topic context
      // cannot satisfy requireTopic and must not wake the base DM session.
      if (!isGroup) {
        const requireTopic = (
          eventAuthContext.groupConfig as { requireTopic?: boolean } | undefined
        )?.requireTopic;
        if (requireTopic === true && eventAuthContext.dmThreadId == null) {
          logVerbose(
            `Blocked telegram poll_answer in DM ${chatId}: requireTopic=true but topic unknown`,
          );
          return;
        }
      }

      const optionLabels = optionIds.map((index) => entry.options[index] ?? `option ${index}`);
      const text = `Poll response to "${entry.question}": ${optionLabels.join(", ")}`;
      const messageThreadId = "id" in entry.threadSpec ? entry.threadSpec.id : undefined;
      const syntheticMessage = buildSyntheticTextMessage({
        base: {
          message_id: entry.messageId,
          date: Math.floor(Date.now() / 1000),
          chat: entry.chat,
          ...(messageThreadId == null
            ? {}
            : {
                message_thread_id: messageThreadId,
                is_topic_message: true,
              }),
        },
        from: user,
        text,
      });
      const result = await processMessageWithReplyChain({
        ctx: buildSyntheticContext(ctx, syntheticMessage),
        msg: syntheticMessage,
        allMedia: [],
        storeAllowFrom: eventAuthContext.storeAllowFrom,
        options: {
          forceWasMentioned: true,
          messageIdOverride:
            typeof ctx.update.update_id === "number"
              ? String(ctx.update.update_id)
              : `poll:${pollId}:${user.id}:${optionIds.join("-")}`,
        },
      });
      recordTelegramMessageProcessingResult(result);
      logVerbose(`telegram: poll_answer dispatched for poll ${pollId} by ${senderId}`);
    } catch (err) {
      runtime.error?.(danger(`telegram poll_answer handler failed: ${String(err)}`));
      if (isTelegramSpooledReplayUpdate(ctx.update)) {
        recordTelegramMessageProcessingResult({ kind: "failed-retryable", error: err });
        return;
      }
      throw err;
    }
  });
}
