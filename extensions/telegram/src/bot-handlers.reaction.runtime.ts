// Telegram reaction handler registration.
import type { ReactionTypeEmoji } from "grammy/types";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import { resolveTelegramAccount } from "./accounts.js";
import type { TelegramHandlerAuthorizationRuntime } from "./bot-handlers.authorization.runtime.js";
import type { TelegramHandlerMessageRuntime } from "./bot-handlers.message.runtime.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
import {
  buildTelegramGroupPeerId,
  buildTelegramParentPeer,
  resolveTelegramThreadSpec,
  type TelegramThreadSpec,
} from "./bot/helpers.js";
import { resolveTelegramConversationRoute } from "./conversation-route.js";

/** Stable operator-facing reason for a scoped reaction dropped without a known topic. */
const TELEGRAM_REACTION_THREAD_UNRESOLVED_REASON = "thread-context-unavailable";

/** Only the message-cache lookup this handler needs, so tests can supply it directly. */
type TelegramReactionThreadRecovery = Pick<
  TelegramHandlerMessageRuntime,
  "resolveCachedMessageThreadSpec"
>;

export function registerTelegramReactionHandler(
  { accountId, bot, runtime, telegramDeps, shouldSkipUpdate }: RegisterTelegramHandlerParams,
  threadRecovery: TelegramReactionThreadRecovery,
  authorizationRuntime: TelegramHandlerAuthorizationRuntime,
) {
  const { resolveTelegramEventAuthorizationContext, authorizeTelegramEventSender } =
    authorizationRuntime;
  // Handle emoji reactions to messages.
  bot.on("message_reaction", async (ctx) => {
    try {
      const reaction = ctx.messageReaction;
      if (!reaction) {
        return;
      }
      if (shouldSkipUpdate(ctx)) {
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

      // Resolve reaction notification mode (default: "own").
      const reactionMode = authorizationTelegramCfg.reactionNotifications ?? "own";
      if (reactionMode === "off") {
        return;
      }
      if (user?.is_bot) {
        return;
      }
      if (
        reactionMode === "own" &&
        !telegramDeps.wasSentByBot(chatId, messageId, authorizationCfg)
      ) {
        logVerbose(
          `telegram: skipped reaction on msg ${messageId} in chat ${chatId} (own mode, not sent by bot)`,
        );
        return;
      }
      // Detect added reactions. This runs before topic recovery so a reaction that
      // enqueues nothing never spends a cache lookup or logs an unresolved-topic warning.
      const oldEmojis = new Set(
        reaction.old_reaction
          .filter((r): r is ReactionTypeEmoji => r.type === "emoji")
          .map((r) => r.emoji),
      );
      const addedReactions = reaction.new_reaction
        .filter((r): r is ReactionTypeEmoji => r.type === "emoji")
        .filter((r) => !oldEmojis.has(r.emoji));

      if (addedReactions.length === 0) {
        return;
      }

      // `MessageReactionUpdated` omits every topic field. Scoped reactions only have a
      // route if the reacted-to message is still in the bounded message cache.
      let recoveredThreadSpec: TelegramThreadSpec | undefined;
      const requiredScope = isDirectMessagesChat
        ? "direct-messages"
        : isForum
          ? "forum"
          : undefined;
      if (requiredScope) {
        recoveredThreadSpec = await threadRecovery.resolveCachedMessageThreadSpec({
          chatId,
          messageId,
        });
        if (recoveredThreadSpec?.scope !== requiredScope || recoveredThreadSpec.id === undefined) {
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

      // Enforce requireTopic for DM reactions: since Telegram doesn't provide messageThreadId
      // for reactions, we cannot determine if the reaction came from a topic, so block all
      // reactions if requireTopic is enabled for this DM.
      if (!isGroup) {
        const requireTopic = (
          eventAuthContext.groupConfig as { requireTopic?: boolean } | undefined
        )?.requireTopic;
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
        // Scoped topics carry topic agents and conversation bindings, so the recovered
        // spec goes through the canonical route resolver instead of a bare peer route.
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
        // Direct chats and non-forum groups have no topic to recover; keep their
        // established peer route so reaction sessions stay where they already are.
        const peerId = isGroup
          ? buildTelegramGroupPeerId(chatId, resolvedThreadId)
          : String(chatId);
        const parentPeer = buildTelegramParentPeer({ isGroup, resolvedThreadId, chatId });
        // Fresh config for bindings lookup; other routing inputs are payload-derived.
        sessionKey = resolveAgentRoute({
          cfg: eventAuthContext.cfg,
          channel: "telegram",
          accountId,
          peer: { kind: isGroup ? "group" : "direct", id: peerId },
          parentPeer,
        }).sessionKey;
      }

      // Build sender label.
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

      // Enqueue system event for each added reaction.
      for (const r of addedReactions) {
        const emoji = r.emoji;
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
}
