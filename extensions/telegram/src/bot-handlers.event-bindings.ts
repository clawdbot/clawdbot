import type { ChatMember, ReactionTypeEmoji } from "grammy/types";
import { resolveChannelConfigWrites } from "openclaw/plugin-sdk/channel-config-helpers";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import { resolveTelegramAccount } from "./accounts.js";
import type { TelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import type { TelegramMessagePipeline } from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams, TelegramEventBindings } from "./bot-handlers.types.js";
import {
  isTelegramSpooledReplayUpdate,
  recordTelegramMessageProcessingResult,
} from "./bot-processing-outcome.js";
import {
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  resolveTelegramThreadSpec,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import { resolveTelegramConversationRoute } from "./conversation-route.js";
import { migrateTelegramGroupConfig } from "./group-migration.js";
import { getPreparedTelegramPollAnswer } from "./poll-answer-context.js";
import { findTelegramPollRegistryEntry, retireTelegramPollRegistryEntry } from "./poll-registry.js";

/** Stable operator-facing reason for a scoped reaction dropped without a known topic. */
const TELEGRAM_REACTION_THREAD_UNRESOLVED_REASON = "thread-context-unavailable";

type TelegramEventMessageDependencies = Pick<
  TelegramMessagePipeline,
  | "resolveCachedMessageThreadSpec"
  | "buildSyntheticTextMessage"
  | "buildSyntheticContext"
  | "processMessageWithReplyChain"
>;

type CreateTelegramEventBindingsOptions = {
  params: RegisterTelegramHandlerParams;
  message: TelegramEventMessageDependencies;
  authorization: Pick<
    TelegramHandlerAuthorization,
    "resolveTelegramEventAuthorizationContext" | "authorizeTelegramEventSender"
  >;
  registerMessages: () => void;
};

function isCurrentTelegramChatMember(member: ChatMember): boolean {
  return (
    member.status === "creator" ||
    member.status === "administrator" ||
    member.status === "member" ||
    (member.status === "restricted" && member.is_member)
  );
}

export function createTelegramEventBindings({
  params,
  message,
  authorization,
  registerMessages,
}: CreateTelegramEventBindingsOptions): TelegramEventBindings {
  const { accountId, ownerAgentId, bot, cfg, runtime, shouldSkipUpdate, telegramDeps } = params;
  const { authorizeTelegramEventSender, resolveTelegramEventAuthorizationContext } = authorization;
  const {
    buildSyntheticContext,
    buildSyntheticTextMessage,
    processMessageWithReplyChain,
    resolveCachedMessageThreadSpec,
  } = message;

  const registerReaction = () => {
    bot.on("message_reaction", async (ctx) => {
      try {
        const reaction = ctx.messageReaction;
        if (!reaction || shouldSkipUpdate(ctx)) {
          return;
        }

        const chatId = reaction.chat.id;
        const messageId = reaction.message_id;
        const user = reaction.user;
        const senderId = user?.id != null ? String(user.id) : "";
        const senderUsername = user?.username ?? "";
        const isGroup = reaction.chat.type === "group" || reaction.chat.type === "supergroup";
        const isDirectMessagesChat = reaction.chat.is_direct_messages === true;
        const isForum = !isDirectMessagesChat && reaction.chat.is_forum === true;
        const authorizationCfg = telegramDeps.getRuntimeConfig();
        const authorizationTelegramCfg = resolveTelegramAccount({
          cfg: authorizationCfg,
          accountId,
        }).config;

        const reactionMode = authorizationTelegramCfg.reactionNotifications ?? "own";
        if (reactionMode === "off" || user?.is_bot) {
          return;
        }
        if (
          reactionMode === "own" &&
          !telegramDeps.wasSentByBot(chatId, messageId, authorizationCfg, {
            accountId,
            agentId: ownerAgentId,
          })
        ) {
          logVerbose(
            `telegram: skipped reaction on msg ${messageId} in chat ${chatId} (own mode, not sent by bot)`,
          );
          return;
        }

        // Detect additions before topic recovery so no-op reactions avoid cache work and warnings.
        const oldEmojis = new Set(
          reaction.old_reaction
            .filter((item): item is ReactionTypeEmoji => item.type === "emoji")
            .map((item) => item.emoji),
        );
        const addedReactions = reaction.new_reaction
          .filter((item): item is ReactionTypeEmoji => item.type === "emoji")
          .filter((item) => !oldEmojis.has(item.emoji));
        if (addedReactions.length === 0) {
          return;
        }

        // Reaction updates omit every topic field. Scoped reactions require the bounded cache.
        let recoveredThreadSpec: TelegramThreadSpec | undefined;
        const requiredScope = isDirectMessagesChat
          ? "direct-messages"
          : isForum
            ? "forum"
            : undefined;
        if (requiredScope) {
          recoveredThreadSpec = await resolveCachedMessageThreadSpec({ chatId, messageId });
          if (
            recoveredThreadSpec?.scope !== requiredScope ||
            recoveredThreadSpec.id === undefined
          ) {
            runtime.log?.(
              warn(
                `telegram: skipped scoped reaction account=${accountId} chat=${chatId} message=${messageId} reason=${TELEGRAM_REACTION_THREAD_UNRESOLVED_REASON}`,
              ),
            );
            return;
          }
        }

        const eventAuthContext = await resolveTelegramEventAuthorizationContext({
          cfg: authorizationCfg,
          chatId,
          isGroup,
          senderId,
          threadSpec:
            recoveredThreadSpec ??
            resolveTelegramThreadSpec({
              isGroup,
              isForum,
            }),
        });
        const senderAuthorization = await authorizeTelegramEventSender({
          chatId,
          chatTitle: reaction.chat.title,
          isGroup,
          senderId,
          senderUsername,
          mode: "reaction",
          context: eventAuthContext,
        });
        if (!senderAuthorization) {
          return;
        }

        // DM reactions cannot prove topic membership because Telegram omits the thread id.
        if (!isGroup) {
          const requireTopic =
            eventAuthContext.groupConfig && "requireTopic" in eventAuthContext.groupConfig
              ? eventAuthContext.groupConfig.requireTopic
              : undefined;
          if (requireTopic === true) {
            logVerbose(
              `Blocked telegram reaction in DM ${chatId}: requireTopic=true but topic unknown for reactions`,
            );
            return;
          }
        }

        const resolvedThreadId = eventAuthContext.resolvedThreadId;
        let sessionKey: string;
        if (recoveredThreadSpec) {
          // Scoped topics must retain topic agents and conversation bindings.
          sessionKey = resolveTelegramConversationRoute({
            cfg: eventAuthContext.cfg,
            accountId,
            chatId,
            isGroup,
            resolvedThreadId,
            replyThreadId: recoveredThreadSpec.id,
            senderId,
            topicAgentId: eventAuthContext.topicConfig?.agentId,
          }).route.sessionKey;
        } else {
          // Direct chats and non-forum groups retain their established peer route.
          const peerId = isGroup
            ? buildTelegramGroupPeerId(chatId, resolvedThreadId)
            : String(chatId);
          const parentPeer = buildTelegramParentPeer({ isGroup, resolvedThreadId, chatId });
          sessionKey = resolveAgentRoute({
            cfg: eventAuthContext.cfg,
            channel: "telegram",
            accountId,
            peer: { kind: isGroup ? "group" : "direct", id: peerId },
            parentPeer,
          }).sessionKey;
        }

        const senderName = user
          ? [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || user.username
          : undefined;
        const senderUsernameLabel = user?.username ? `@${user.username}` : undefined;
        let senderLabel = senderName;
        if (senderName && senderUsernameLabel) {
          senderLabel = `${senderName} (${senderUsernameLabel})`;
        } else if (!senderName && senderUsernameLabel) {
          senderLabel = senderUsernameLabel;
        }
        if (!senderLabel && user?.id) {
          senderLabel = `id:${user.id}`;
        }
        senderLabel = senderLabel || "unknown";

        for (const addedReaction of addedReactions) {
          const emoji = addedReaction.emoji;
          const text = `Telegram reaction added: ${emoji} by ${senderLabel} on msg ${messageId}`;
          telegramDeps.enqueueSystemEvent(text, {
            sessionKey,
            contextKey: `telegram:reaction:add:${chatId}:${messageId}:${user?.id ?? "anon"}:${emoji}`,
          });
          logVerbose(`telegram: reaction event enqueued: ${text}`);
        }
      } catch (err) {
        runtime.error?.(danger(`telegram reaction handler failed: ${String(err)}`));
        throw err;
      }
    });
  };

  const registerPolls = () => {
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

    // Public poll answers omit chat/thread data. The send path persists that origin.
    bot.on("poll_answer", async (ctx) => {
      try {
        const pollAnswer = ctx.pollAnswer;
        if (!pollAnswer || shouldSkipUpdate(ctx)) {
          return;
        }
        const optionIds = pollAnswer.option_ids ?? [];
        const user = pollAnswer.user;
        // Retractions and voters without a usable user identity cannot pass authorization.
        if (optionIds.length === 0 || !user || user.is_bot) {
          return;
        }

        // Store failures replay durable ingress; only a true miss is a safe no-op.
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
        const senderId = String(user.id);
        const senderUsername = user.username ?? "";
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
          mode: "reaction",
          context: eventAuthContext,
        });
        if (!senderAuthorization) {
          return;
        }

        // A DM poll without persisted topic context must not wake the base DM session.
        const requireTopic =
          eventAuthContext.groupConfig && "requireTopic" in eventAuthContext.groupConfig
            ? eventAuthContext.groupConfig.requireTopic
            : undefined;
        if (!isGroup && requireTopic === true) {
          if (eventAuthContext.dmThreadId == null) {
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
  };

  const registerMigration = () => {
    bot.on("message:migrate_to_chat_id", async (ctx) => {
      try {
        const msg = ctx.message;
        if (!msg?.migrate_to_chat_id || shouldSkipUpdate(ctx)) {
          return;
        }

        const oldChatId = String(msg.chat.id);
        const newChatId = String(msg.migrate_to_chat_id);
        const chatTitle = msg.chat.title ?? "Unknown";
        runtime.log?.(
          warn(`[telegram] Group migrated: "${chatTitle}" ${oldChatId} → ${newChatId}`),
        );

        if (!resolveChannelConfigWrites({ cfg, channelId: "telegram", accountId })) {
          runtime.log?.(
            warn("[telegram] Config writes disabled; skipping group config migration."),
          );
          return;
        }

        const currentConfig = telegramDeps.getRuntimeConfig();
        const migration = migrateTelegramGroupConfig({
          cfg: currentConfig,
          accountId,
          oldChatId,
          newChatId,
        });

        if (migration.migrated) {
          runtime.log?.(
            warn(`[telegram] Migrating group config from ${oldChatId} to ${newChatId}`),
          );
          migrateTelegramGroupConfig({ cfg, accountId, oldChatId, newChatId });
          await mutateConfigFile({
            afterWrite: { mode: "auto" },
            mutate: (draft) => {
              migrateTelegramGroupConfig({ cfg: draft, accountId, oldChatId, newChatId });
            },
          });
          runtime.log?.(warn("[telegram] Group config migrated and saved successfully"));
        } else if (migration.skippedExisting) {
          runtime.log?.(
            warn(
              `[telegram] Group config already exists for ${newChatId}; leaving ${oldChatId} unchanged`,
            ),
          );
        } else {
          runtime.log?.(
            warn(`[telegram] No config found for old group ID ${oldChatId}, migration logged only`),
          );
        }
      } catch (err) {
        runtime.error?.(danger(`[telegram] Group migration handler failed: ${String(err)}`));
        throw err;
      }
    });
  };

  return { registerReaction, registerPolls, registerMigration, registerMessages };
}
