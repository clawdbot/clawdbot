import {
  resolveAckReaction,
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
  resolveIdentityName,
} from "../../agents/identity.js";
import {
  extractShortModelName,
  type ResponsePrefixContext,
} from "../../auto-reply/reply/response-prefix-template.js";
import { formatInboundEnvelope, formatThreadStarterEnvelope } from "../../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.js";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntries,
} from "../../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import {
  recordSessionMetaFromInbound,
  resolveStorePath,
  updateLastRoute,
} from "../../config/sessions.js";
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
import { buildDirectLabel, buildGuildLabel, resolveReplyContext } from "./reply-context.js";
import { deliverDiscordReply } from "./reply-delivery.js";
import { resolveDiscordAutoThreadReplyPlan, resolveDiscordThreadStarter } from "./threading.js";
import { sendTyping } from "./typing.js";

export async function processDiscordMessage(ctx: DiscordMessagePreflightContext) {
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
    shouldRequireMention,
    canDetectMention,
    effectiveWasMentioned,
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
      return effectiveWasMentioned;
    }
    return false;
  };
  const ackReactionPromise = shouldAckReaction()
    ? reactMessageDiscord(message.channelId, message.id, ackReaction, {
        rest: client.rest,
      }).then(
        () => true,
        (err) => {
          logVerbose(`discord react failed for channel ${message.channelId}: ${String(err)}`);
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
  const senderTag = formatDiscordUserTag(author);
  const senderDisplay = data.member?.nickname ?? author.globalName ?? author.username;
  const senderLabel =
    senderDisplay && senderTag && senderDisplay !== senderTag
      ? `${senderDisplay} (${senderTag})`
      : (senderDisplay ?? senderTag ?? author.id);
  const groupChannel = isGuildMessage && displayChannelSlug ? `#${displayChannelSlug}` : undefined;
  const groupSubject = isDirectMessage ? undefined : groupChannel;
  const channelDescription = channelInfo?.topic?.trim();
  const systemPromptParts = [
    channelDescription ? `Channel topic: ${channelDescription}` : null,
    channelConfig?.systemPrompt?.trim() || null,
  ].filter((entry): entry is string => Boolean(entry));
  const groupSystemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
  let combinedBody = formatInboundEnvelope({
    channel: "Discord",
    from: fromLabel,
    timestamp: resolveTimestampMs(message.timestamp),
    body: text,
    chatType: isDirectMessage ? "direct" : "channel",
    senderLabel,
  });
  const shouldIncludeChannelHistory =
    !isDirectMessage && !(isGuildMessage && channelConfig?.autoThread && !threadChannel);
  if (shouldIncludeChannelHistory) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: guildHistories,
      historyKey: message.channelId,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "Discord",
          from: fromLabel,
          timestamp: entry.timestamp,
          body: `${entry.body} [id:${entry.messageId ?? "unknown"} channel:${message.channelId}]`,
          chatType: "channel",
          senderLabel: entry.sender,
        }),
    });
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
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId: threadChannel ? message.channelId : undefined,
    parentSessionKey,
    useSuffix: false,
  });
  const replyPlan = await resolveDiscordAutoThreadReplyPlan({
    client,
    message,
    isGuildMessage,
    channelConfig,
    threadChannel,
    baseText: baseText ?? "",
    combinedBody,
    replyToMode,
    agentId: route.agentId,
    channel: route.channel,
  });
  const deliverTarget = replyPlan.deliverTarget;
  const replyTarget = replyPlan.replyTarget;
  const replyReference = replyPlan.replyReference;
  const autoThreadContext = replyPlan.autoThreadContext;

  const effectiveFrom = isDirectMessage
    ? `discord:${author.id}`
    : (autoThreadContext?.From ?? `discord:channel:${message.channelId}`);
  const effectiveTo = autoThreadContext?.To ?? replyTarget;
  if (!effectiveTo) {
    runtime.error?.(danger("discord: missing reply target"));
    return;
  }

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    RawBody: baseText,
    CommandBody: baseText,
    From: effectiveFrom,
    To: effectiveTo,
    SessionKey: autoThreadContext?.SessionKey ?? threadKeys.sessionKey,
    AccountId: route.accountId,
    ChatType: isDirectMessage ? "direct" : "channel",
    ConversationLabel: fromLabel,
    SenderName: data.member?.nickname ?? author.globalName ?? author.username,
    SenderId: author.id,
    SenderUsername: author.username,
    SenderTag: formatDiscordUserTag(author),
    GroupSubject: groupSubject,
    GroupChannel: groupChannel,
    GroupSystemPrompt: isGuildMessage ? groupSystemPrompt : undefined,
    GroupSpace: isGuildMessage ? (guildInfo?.id ?? guildSlug) || undefined : undefined,
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: effectiveWasMentioned,
    MessageSid: message.id,
    ParentSessionKey: autoThreadContext?.ParentSessionKey ?? threadKeys.parentSessionKey,
    ThreadStarterBody: threadStarterBody,
    ThreadLabel: threadLabel,
    Timestamp: resolveTimestampMs(message.timestamp),
    ...mediaPayload,
    CommandAuthorized: commandAuthorized,
    CommandSource: "text" as const,
    // Originating channel for reply routing.
    OriginatingChannel: "discord" as const,
    OriginatingTo: autoThreadContext?.OriginatingTo ?? replyTarget,
  });

  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  void recordSessionMetaFromInbound({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
  }).catch((err) => {
    logVerbose(`discord: failed updating session meta: ${String(err)}`);
  });

  if (isDirectMessage) {
    await updateLastRoute({
      storePath,
      sessionKey: route.mainSessionKey,
      deliveryContext: {
        channel: "discord",
        to: `user:${author.id}`,
        accountId: route.accountId,
      },
      ctx: ctxPayload,
    });
  }

  if (shouldLogVerbose()) {
    const preview = truncateUtf16Safe(combinedBody, 200).replace(/\n/g, "\\n");
    logVerbose(
      `discord inbound: channel=${message.channelId} deliver=${deliverTarget} from=${ctxPayload.From} preview="${preview}"`,
    );
  }

  const typingChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : message.channelId;

  // Create mutable context for response prefix template interpolation
  let prefixContext: ResponsePrefixContext = {
    identityName: resolveIdentityName(cfg, route.agentId),
  };

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    responsePrefix: resolveEffectiveMessagesConfig(cfg, route.agentId).responsePrefix,
    responsePrefixContextProvider: () => prefixContext,
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
      replyReference.markSent();
    },
    onError: (err, info) => {
      runtime.error?.(danger(`discord ${info.kind} reply failed: ${String(err)}`));
    },
    onReplyStart: () => sendTyping({ client, channelId: typingChannelId }),
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
      onModelSelected: (ctx) => {
        // Mutate the object directly instead of reassigning to ensure the closure sees updates
        prefixContext.provider = ctx.provider;
        prefixContext.model = extractShortModelName(ctx.model);
        prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
        prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
      },
    },
  });
  markDispatchIdle();
  if (!queuedFinal) {
    if (isGuildMessage && historyLimit > 0) {
      clearHistoryEntries({
        historyMap: guildHistories,
        historyKey: message.channelId,
      });
    }
    return;
  }
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
  if (isGuildMessage && historyLimit > 0) {
    clearHistoryEntries({
      historyMap: guildHistories,
      historyKey: message.channelId,
    });
  }
}
