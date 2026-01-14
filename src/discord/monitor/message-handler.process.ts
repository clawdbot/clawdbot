import {
  resolveAckReaction,
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
} from "../../agents/identity.js";
import {
  formatAgentEnvelope,
  formatThreadStarterEnvelope,
} from "../../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.js";
import {
  buildHistoryContextFromMap,
  clearHistoryEntries,
} from "../../auto-reply/reply/history.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { resolveStorePath, updateLastRoute } from "../../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../globals.js";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../../routing/session-key.js";
import { truncateUtf16Safe } from "../../utils.js";
import { reactMessageDiscord, removeReactionDiscord } from "../send.js";
import { normalizeDiscordSlug } from "./allow-list.js";
import { formatDiscordUserTag, resolveTimestampMs } from "./format.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import {
  buildDiscordMediaPayload,
  resolveDiscordMessageText,
  resolveMediaList,
} from "./message-utils.js";
import {
  buildDirectLabel,
  buildGuildLabel,
  resolveReplyContext,
} from "./reply-context.js";
import { deliverDiscordReply } from "./reply-delivery.js";
import {
  maybeCreateDiscordAutoThread,
  resolveDiscordReplyDeliveryPlan,
  resolveDiscordThreadStarter,
} from "./threading.js";
import { sendTyping } from "./typing.js";

export async function processDiscordMessage(
  ctx: DiscordMessagePreflightContext,
) {
  const {
    cfg,
    discordConfig,
    accountId,
    token,
    runtime,
    guildHistories,
    historyLimit,
    mediaMaxBytes,
    textLimit,
    replyToMode,
    ackReactionScope,
    message,
    author,
    data,
    client,
    channelInfo,
    channelName,
    isGuildMessage,
    isDirectMessage,
    isGroupDm,
    baseText,
    messageText,
    wasMentioned,
    shouldRequireMention,
    canDetectMention,
    shouldBypassMention,
    effectiveWasMentioned,
    historyEntry,
    threadChannel,
    threadParentId,
    threadParentName,
    threadParentType,
    threadName,
    displayChannelSlug,
    guildInfo,
    guildSlug,
    channelConfig,
    baseSessionKey,
    route,
    commandAuthorized,
  } = ctx;

  const mediaList = await resolveMediaList(message, mediaMaxBytes);
  const text = messageText;
  if (!text) {
    logVerbose(`discord: drop message ${message.id} (empty content)`);
    return;
  }
  const ackReaction = resolveAckReaction(cfg, route.agentId);
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const shouldAckReaction = () => {
    if (!ackReaction) return false;
    if (ackReactionScope === "all") return true;
    if (ackReactionScope === "direct") return isDirectMessage;
    const isGroupChat = isGuildMessage || isGroupDm;
    if (ackReactionScope === "group-all") return isGroupChat;
    if (ackReactionScope === "group-mentions") {
      if (!isGuildMessage) return false;
      if (!shouldRequireMention) return false;
      if (!canDetectMention) return false;
      return wasMentioned || shouldBypassMention;
    }
    return false;
  };
  const ackReactionPromise = shouldAckReaction()
    ? reactMessageDiscord(message.channelId, message.id, ackReaction, {
        rest: client.rest,
      }).then(
        () => true,
        (err) => {
          logVerbose(
            `discord react failed for channel ${message.channelId}: ${String(err)}`,
          );
          return false;
        },
      )
    : null;

  const fromLabel = isDirectMessage
    ? buildDirectLabel(author)
    : buildGuildLabel({
        guild: data.guild ?? undefined,
        channelName: channelName ?? message.channelId,
        channelId: message.channelId,
      });
  const groupRoom =
    isGuildMessage && displayChannelSlug ? `#${displayChannelSlug}` : undefined;
  const groupSubject = isDirectMessage ? undefined : groupRoom;
  const channelDescription = channelInfo?.topic?.trim();
  const systemPromptParts = [
    channelDescription ? `Channel topic: ${channelDescription}` : null,
    channelConfig?.systemPrompt?.trim() || null,
  ].filter((entry): entry is string => Boolean(entry));
  const groupSystemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
  let combinedBody = formatAgentEnvelope({
    channel: "Discord",
    from: fromLabel,
    timestamp: resolveTimestampMs(message.timestamp),
    body: text,
  });
  let shouldClearHistory = false;
  if (!isDirectMessage) {
    combinedBody = buildHistoryContextFromMap({
      historyMap: guildHistories,
      historyKey: message.channelId,
      limit: historyLimit,
      entry: historyEntry,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatAgentEnvelope({
          channel: "Discord",
          from: fromLabel,
          timestamp: entry.timestamp,
          body: `${entry.sender}: ${entry.body} [id:${entry.messageId ?? "unknown"} channel:${message.channelId}]`,
        }),
    });
    const name = formatDiscordUserTag(author);
    const id = author.id;
    combinedBody = `${combinedBody}\n[from: ${name} user id:${id}]`;
    shouldClearHistory = true;
  }
  const replyContext = resolveReplyContext(message, resolveDiscordMessageText);
  if (replyContext) {
    combinedBody = `[Replied message - for context]\n${replyContext}\n\n${combinedBody}`;
  }

  let threadStarterBody: string | undefined;
  let threadLabel: string | undefined;
  let parentSessionKey: string | undefined;
  if (threadChannel) {
    const starter = await resolveDiscordThreadStarter({
      channel: threadChannel,
      client,
      parentId: threadParentId,
      parentType: threadParentType,
      resolveTimestampMs,
    });
    if (starter?.text) {
      const starterEnvelope = formatThreadStarterEnvelope({
        channel: "Discord",
        author: starter.author,
        timestamp: starter.timestamp,
        body: starter.text,
      });
      threadStarterBody = starterEnvelope;
    }
    const parentName = threadParentName ?? "parent";
    threadLabel = threadName
      ? `Discord thread #${normalizeDiscordSlug(parentName)} › ${threadName}`
      : `Discord thread #${normalizeDiscordSlug(parentName)}`;
    if (threadParentId) {
      parentSessionKey = buildAgentSessionKey({
        agentId: route.agentId,
        channel: route.channel,
        peer: { kind: "channel", id: threadParentId },
      });
    }
  }
  const mediaPayload = buildDiscordMediaPayload(mediaList);
  const discordTo = `channel:${message.channelId}`;
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId: threadChannel ? message.channelId : undefined,
    parentSessionKey,
    useSuffix: false,
  });
  const ctxPayload = {
    Body: combinedBody,
    RawBody: baseText,
    CommandBody: baseText,
    From: isDirectMessage
      ? `discord:${author.id}`
      : `group:${message.channelId}`,
    To: discordTo,
    SessionKey: threadKeys.sessionKey,
    AccountId: route.accountId,
    ChatType: isDirectMessage ? "direct" : "group",
    SenderName: data.member?.nickname ?? author.globalName ?? author.username,
    SenderId: author.id,
    SenderUsername: author.username,
    SenderTag: formatDiscordUserTag(author),
    GroupSubject: groupSubject,
    GroupRoom: groupRoom,
    GroupSystemPrompt: isGuildMessage ? groupSystemPrompt : undefined,
    GroupSpace: isGuildMessage
      ? (guildInfo?.id ?? guildSlug) || undefined
      : undefined,
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: effectiveWasMentioned,
    MessageSid: message.id,
    ParentSessionKey: threadKeys.parentSessionKey,
    ThreadStarterBody: threadStarterBody,
    ThreadLabel: threadLabel,
    Timestamp: resolveTimestampMs(message.timestamp),
    ...mediaPayload,
    CommandAuthorized: commandAuthorized,
    CommandSource: "text" as const,
    // Originating channel for reply routing.
    OriginatingChannel: "discord" as const,
    OriginatingTo: discordTo,
  };
  let replyTarget = ctxPayload.To ?? undefined;
  if (!replyTarget) {
    runtime.error?.(danger("discord: missing reply target"));
    return;
  }
  const createdThreadId = await maybeCreateDiscordAutoThread({
    client,
    message,
    isGuildMessage,
    channelConfig,
    threadChannel,
    baseText: baseText ?? "",
    combinedBody,
  });
  const replyPlan = resolveDiscordReplyDeliveryPlan({
    replyTarget,
    replyToMode,
    messageId: message.id,
    threadChannel,
    createdThreadId,
  });
  const deliverTarget = replyPlan.deliverTarget;
  replyTarget = replyPlan.replyTarget;
  const replyReference = replyPlan.replyReference;

  if (isDirectMessage) {
    const sessionCfg = cfg.session;
    const storePath = resolveStorePath(sessionCfg?.store, {
      agentId: route.agentId,
    });
    await updateLastRoute({
      storePath,
      sessionKey: route.mainSessionKey,
      channel: "discord",
      to: `user:${author.id}`,
      accountId: route.accountId,
    });
  }

  if (shouldLogVerbose()) {
    const preview = truncateUtf16Safe(combinedBody, 200).replace(/\n/g, "\\n");
    logVerbose(
      `discord inbound: channel=${message.channelId} from=${ctxPayload.From} preview="${preview}"`,
    );
  }

  let didSendReply = false;
  const { dispatcher, replyOptions, markDispatchIdle } =
    createReplyDispatcherWithTyping({
      responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId)
        .responsePrefix,
      humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload: ReplyPayload) => {
        const replyToId = replyReference.use();
        await deliverDiscordReply({
          replies: [payload],
          target: deliverTarget,
          token,
          accountId,
          rest: client.rest,
          runtime,
          replyToId,
          textLimit,
          maxLinesPerMessage: discordConfig?.maxLinesPerMessage,
        });
        didSendReply = true;
        replyReference.markSent();
      },
      onError: (err, info) => {
        runtime.error?.(
          danger(`discord ${info.kind} reply failed: ${String(err)}`),
        );
      },
      onReplyStart: () => sendTyping({ client, channelId: message.channelId }),
    });

  const { queuedFinal, counts } = await dispatchReplyFromConfig({
    ctx: ctxPayload,
    cfg,
    dispatcher,
    replyOptions: {
      ...replyOptions,
      skillFilter: channelConfig?.skills,
      disableBlockStreaming:
        typeof discordConfig?.blockStreaming === "boolean"
          ? !discordConfig.blockStreaming
          : undefined,
    },
  });
  markDispatchIdle();
  if (!queuedFinal) {
    if (
      isGuildMessage &&
      shouldClearHistory &&
      historyLimit > 0 &&
      didSendReply
    ) {
      clearHistoryEntries({
        historyMap: guildHistories,
        historyKey: message.channelId,
      });
    }
    return;
  }
  didSendReply = true;
  if (shouldLogVerbose()) {
    const finalCount = counts.final;
    logVerbose(
      `discord: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
    );
  }
  if (removeAckAfterReply && ackReactionPromise && ackReaction) {
    const ackReactionValue = ackReaction;
    void ackReactionPromise.then((didAck) => {
      if (!didAck) return;
      removeReactionDiscord(message.channelId, message.id, ackReactionValue, {
        rest: client.rest,
      }).catch((err) => {
        logVerbose(
          `discord: failed to remove ack reaction from ${message.channelId}/${message.id}: ${String(err)}`,
        );
      });
    });
  }
  if (
    isGuildMessage &&
    shouldClearHistory &&
    historyLimit > 0 &&
    didSendReply
  ) {
    clearHistoryEntries({
      historyMap: guildHistories,
      historyKey: message.channelId,
    });
  }
}
