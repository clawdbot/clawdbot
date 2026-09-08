import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveTelegramMessageThreadSpec, type TelegramThreadSpec } from "./bot/helpers.js";
import { resolveTelegramEffectiveGroupPolicy } from "./group-access.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import { beginTelegramPollRegistration } from "./poll-answer-context.js";
import {
  createTelegramPollRegistryEntry,
  recordTelegramPollRegistryEntry,
  type TelegramPollRegistryEntry,
} from "./poll-registry.js";
import { withTelegramApiContext, type TelegramApiContext } from "./send-context.js";
import type {
  TelegramSendOpts,
  TelegramSendResult,
  TelegramThreadedSendOpts,
} from "./send-message-types.js";
import { finalizeTelegramOutbound, prepareTelegramOutbound } from "./send-outbound.js";
import { normalizePollInput, type PollInput } from "./send.runtime.js";
import { parseTelegramTarget } from "./targets.js";
import { resolveTelegramBotUserIdFromToken } from "./token-fingerprint.js";

type TelegramSendPollParams = Parameters<TelegramApiContext["api"]["sendPoll"]>[3];

type TelegramPollSendResult = {
  messageId: string;
  chatId: string;
  pollId: string;
  pollAnswerRouting?: "enabled" | "unavailable";
  warning?: string;
};

function resolveTelegramPollThreadSpec(
  threadSpec: TelegramThreadSpec,
): TelegramPollRegistryEntry["threadSpec"] | undefined {
  if (threadSpec.scope === "none") {
    return { scope: "none" };
  }
  if (threadSpec.scope === "dm") {
    return threadSpec.id === undefined ? { scope: "dm" } : { scope: "dm", id: threadSpec.id };
  }
  return threadSpec.scope === "forum" && threadSpec.id !== undefined
    ? { scope: "forum", id: threadSpec.id }
    : undefined;
}

/**
 * Send a sticker to a Telegram chat by file_id.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param fileId - Telegram file_id of the sticker to send
 * @param opts - Optional configuration
 */
export async function sendStickerTelegram(
  to: string,
  fileId: string,
  opts: TelegramThreadedSendOpts,
): Promise<TelegramSendResult> {
  if (!fileId?.trim()) {
    throw new Error("Telegram sticker file_id is required");
  }

  return withTelegramApiContext(opts, async (context): Promise<TelegramSendResult> => {
    const { api } = context;
    const prepared = await prepareTelegramOutbound({
      to,
      context,
      opts,
      thread: {
        messageThreadId: opts.messageThreadId,
        replyToMessageId: opts.replyToMessageId,
      },
      request: { kind: "nonIdempotent", useApiErrorLogging: false },
    });
    const stickerParams =
      Object.keys(prepared.threadParams).length > 0 ? prepared.threadParams : undefined;

    const result = await prepared.request(
      () => api.sendSticker(prepared.chatId, fileId.trim(), stickerParams),
      "sticker",
    );
    return finalizeTelegramOutbound({
      context,
      prepared,
      result,
      resultContext: "sticker send",
    });
  });
}

type TelegramPollOpts = TelegramThreadedSendOpts &
  Pick<TelegramSendOpts, "assertPlatformSendAuthorized" | "onPlatformSendDispatch" | "silent"> & {
    /** Whether votes are anonymous. Defaults to true (Telegram default). */
    isAnonymous?: boolean;
  };

/**
 * Send a poll to a Telegram chat.
 * @param to - Chat ID or username (e.g., "123456789" or "@username")
 * @param poll - Poll input with question, options, maxSelections, and optional durationHours
 * @param opts - Optional configuration
 */
export async function sendPollTelegram(
  to: string,
  poll: PollInput,
  opts: TelegramPollOpts,
): Promise<TelegramPollSendResult> {
  if (parseTelegramTarget(to).directMessagesTopicId != null) {
    throw new Error("Telegram polls are not supported in channel Direct Messages chats.");
  }
  return withTelegramApiContext(opts, async (context): Promise<TelegramPollSendResult> => {
    const { api } = context;
    const prepared = await prepareTelegramOutbound({
      to,
      context,
      opts,
      thread: {
        messageThreadId: opts.messageThreadId,
        replyToMessageId: opts.replyToMessageId,
      },
      request: { kind: "nonIdempotent" },
    });

    const normalizedPoll = normalizePollInput(poll, { maxOptions: 12 });

    const durationSeconds = normalizedPoll.durationSeconds;
    if (durationSeconds === undefined && normalizedPoll.durationHours !== undefined) {
      throw new Error(
        "Telegram poll durationHours is not supported. Use durationSeconds (5-604800) instead.",
      );
    }
    if (durationSeconds !== undefined && (durationSeconds < 5 || durationSeconds > 604_800)) {
      throw new Error("Telegram poll durationSeconds must be between 5 and 604800");
    }

    const pollParams: TelegramSendPollParams = {
      allows_multiple_answers: normalizedPoll.maxSelections > 1,
      is_anonymous: opts.isAnonymous ?? true,
      ...(durationSeconds !== undefined ? { open_period: durationSeconds } : {}),
      ...(Object.keys(prepared.threadParams).length > 0 ? prepared.threadParams : {}),
      ...(opts.silent === true ? { disable_notification: true } : {}),
    };

    await opts.onPlatformSendDispatch?.();
    const result = await prepared.request(() => {
      opts.assertPlatformSendAuthorized?.();
      return api.sendPoll(
        prepared.chatId,
        normalizedPoll.question,
        normalizedPoll.options,
        pollParams,
      );
    }, "poll");
    const pollId = result.poll.id;
    const routeChat = result.chat.type === "channel" ? undefined : result.chat;
    const routeMessage =
      result.message_thread_id === undefined && prepared.threadSpec?.id !== undefined
        ? { ...result, message_thread_id: prepared.threadSpec.id }
        : result;
    const resolvedThreadSpec = routeChat
      ? resolveTelegramMessageThreadSpec(
          routeMessage,
          prepared.threadSpec?.scope === "forum" || result.chat.is_forum === true,
        )
      : undefined;
    const threadSpec = resolvedThreadSpec
      ? resolveTelegramPollThreadSpec(resolvedThreadSpec)
      : undefined;
    const messageThreadId = threadSpec && "id" in threadSpec ? threadSpec.id : undefined;
    const provisionalEntry =
      opts.isAnonymous === false && routeChat && threadSpec
        ? createTelegramPollRegistryEntry({
            pollId,
            chat: routeChat,
            messageId: result.message_id,
            threadSpec,
            question: normalizedPoll.question,
            options: normalizedPoll.options,
          })
        : undefined;
    const registration = provisionalEntry
      ? beginTelegramPollRegistration({
          accountId: context.account.accountId,
          entry: provisionalEntry,
        })
      : undefined;
    let registeredEntry: Awaited<ReturnType<typeof recordTelegramPollRegistryEntry>> | null = null;
    let pollAnswerRouting: TelegramPollSendResult["pollAnswerRouting"];
    let warning: string | undefined;
    try {
      const finalized = await finalizeTelegramOutbound({
        context,
        prepared,
        result,
        resultContext: "poll send",
      });
      // Public poll answers omit chat/thread routing metadata. Record the origin at
      // the central send boundary so every caller gets the same inbound route.
      // The poll already exists, so surface storage failure instead of retrying and duplicating it.
      if (pollId && opts.isAnonymous !== false) {
        pollAnswerRouting = "unavailable";
        warning =
          "Poll sent anonymously, so Telegram does not identify voters and answers cannot reach the agent. Send a public poll to route votes into this conversation.";
      } else if (pollId) {
        const isGroup = result.chat.type === "group" || result.chat.type === "supergroup";
        const botUserId = resolveTelegramBotUserIdFromToken(opts.token || context.account.token);
        let canVerifyVoters = result.chat.type === "private";
        if (result.chat.type === "channel") {
          pollAnswerRouting = "unavailable";
          warning =
            "Poll sent, but public poll answer routing is not supported for Telegram channels. Send the poll in a direct chat or group, or ask subscribers to reply in text.";
        } else if (isGroup) {
          const { groupConfig, topicConfig } = resolveTelegramScopedGroupConfig(
            context.account.config,
            result.chat.id,
            messageThreadId,
          );
          const groupPolicyConfig =
            groupConfig && "groupPolicy" in groupConfig ? groupConfig : undefined;
          const groupIngressDisabled =
            groupConfig?.enabled === false ||
            topicConfig?.enabled === false ||
            resolveTelegramEffectiveGroupPolicy({
              cfg: opts.cfg,
              telegramCfg: context.account.config,
              groupConfig: groupPolicyConfig,
              topicConfig,
            }) === "disabled";
          if (groupIngressDisabled) {
            pollAnswerRouting = "unavailable";
            warning =
              "Poll sent, but answers cannot reach the agent because inbound messages are disabled for this group or topic. Enable inbound messages for this target and send a new poll, or ask participants to reply in text.";
          } else if (botUserId == null) {
            pollAnswerRouting = "unavailable";
            warning =
              "Poll sent, but answers cannot reach the agent because the bot account could not be verified. Check the bot token and send a new poll, or ask the user to reply in text.";
          } else {
            try {
              const botMember = await api.getChatMember(result.chat.id, botUserId);
              canVerifyVoters =
                botMember.status === "creator" || botMember.status === "administrator";
              if (!canVerifyVoters) {
                pollAnswerRouting = "unavailable";
                warning =
                  "Poll sent, but answers cannot reach the agent because the bot is not an administrator in this group. Make the bot an administrator and send a new poll, or ask the user to reply in text.";
              }
            } catch (err) {
              pollAnswerRouting = "unavailable";
              warning =
                "Poll sent, but answers cannot reach the agent because group membership verification failed. Make the bot an administrator and send a new poll, or ask the user to reply in text.";
              logVerbose(
                `telegram: failed to verify poll voter access for poll ${pollId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
        }
        if (canVerifyVoters && provisionalEntry) {
          try {
            registeredEntry = await recordTelegramPollRegistryEntry({
              accountId: context.account.accountId,
              ...provisionalEntry,
            });
            pollAnswerRouting = "enabled";
          } catch (err) {
            pollAnswerRouting = "unavailable";
            warning =
              "Poll sent, but answers cannot reach the agent because routing state could not be saved. Ask the user to reply in text.";
            logVerbose(
              `telegram: failed to record poll registry entry for poll ${pollId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
      return {
        ...finalized,
        pollId,
        ...(pollAnswerRouting ? { pollAnswerRouting } : {}),
        ...(warning ? { warning } : {}),
      };
    } finally {
      registration?.complete(registeredEntry);
    }
  });
}
