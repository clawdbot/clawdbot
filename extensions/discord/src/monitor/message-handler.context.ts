import {
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelContextVisibilityMode } from "openclaw/plugin-sdk/context-visibility-runtime";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/conversation-runtime";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { buildPendingHistoryContextFromMap } from "openclaw/plugin-sdk/reply-history";
import { buildAgentSessionKey, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { evaluateSupplementalContextVisibility } from "openclaw/plugin-sdk/security-runtime";
import { readSessionUpdatedAt, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordConversationIdentity } from "../conversation-identity.js";
import { ChannelType } from "../internal/discord.js";
import { normalizeDiscordAllowList, normalizeDiscordSlug } from "./allow-list.js";
import { resolveTimestampMs } from "./format.js";
import {
  buildDiscordInboundAccessContext,
  createDiscordSupplementalContextAccessChecker,
} from "./inbound-context.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import {
  buildDiscordMediaPayload,
  resolveDiscordMessageText,
  type DiscordMediaInfo,
} from "./message-utils.js";
import { buildDirectLabel, buildGuildLabel, resolveReplyContext } from "./reply-context.js";
import { resolveDiscordAutoThreadReplyPlan, resolveDiscordThreadStarter } from "./threading.js";

function normalizeDiscordDmOwnerEntry(entry: string): string | undefined {
  const normalized = normalizeDiscordAllowList([entry], ["discord:", "user:", "pk:"]);
  const candidate = normalized?.ids.values().next().value;
  return typeof candidate === "string" && /^\d+$/.test(candidate) ? candidate : undefined;
}

export async function buildDiscordMessageProcessContext(params: {
  ctx: DiscordMessagePreflightContext;
  text: string;
  mediaList: DiscordMediaInfo[];
}) {
  const { ctx, text, mediaList } = params;
  const {
    cfg,
    discordConfig,
    accountId,
    runtime,
    guildHistories,
    historyLimit,
    replyToMode,
    message,
    author,
    sender,
    canonicalMessageId,
    data,
    client,
    channelInfo,
    channelName,
    messageChannelId,
    isGuildMessage,
    isDirectMessage,
    baseText,
    preflightAudioTranscript,
    threadChannel,
    threadParentId,
    threadParentName,
    threadParentType,
    threadName,
    displayChannelSlug,
    guildInfo,
    guildSlug,
    memberRoleIds,
    channelConfig,
    baseSessionKey,
    boundSessionKey,
    route,
    commandAuthorized,
  } = ctx;

  const fromLabel = isDirectMessage
    ? buildDirectLabel(author)
    : buildGuildLabel({
        guild: data.guild ?? undefined,
        channelName: channelName ?? messageChannelId,
        channelId: messageChannelId,
      });
  const senderLabel = sender.label;
  const isForumParent =
    threadParentType === ChannelType.GuildForum || threadParentType === ChannelType.GuildMedia;
  const forumParentSlug =
    isForumParent && threadParentName ? normalizeDiscordSlug(threadParentName) : "";
  const threadChannelId = threadChannel?.id;
  const threadParentInheritanceEnabled = discordConfig?.thread?.inheritParent ?? false;
  const isForumStarter =
    Boolean(threadChannelId && isForumParent && forumParentSlug) && message.id === threadChannelId;
  const forumContextLine = isForumStarter ? `[Forum parent: #${forumParentSlug}]` : null;
  const groupChannel = isGuildMessage && displayChannelSlug ? `#${displayChannelSlug}` : undefined;
  const groupSubject = isDirectMessage ? undefined : groupChannel;
  const senderName = sender.isPluralKit
    ? (sender.name ?? author.username)
    : (data.member?.nickname ?? author.globalName ?? author.username);
  const senderUsername = sender.isPluralKit
    ? (sender.tag ?? sender.name ?? author.username)
    : author.username;
  const { groupSystemPrompt, ownerAllowFrom, untrustedContext } = buildDiscordInboundAccessContext({
    channelConfig,
    guildInfo,
    sender: { id: sender.id, name: sender.name, tag: sender.tag },
    allowNameMatching: isDangerousNameMatchingEnabled(discordConfig),
    isGuild: isGuildMessage,
    channelTopic: channelInfo?.topic,
    messageBody: text,
  });
  const pinnedMainDmOwner = isDirectMessage
    ? resolvePinnedMainDmOwnerFromAllowlist({
        dmScope: cfg.session?.dmScope,
        allowFrom: channelConfig?.users ?? guildInfo?.users,
        normalizeEntry: normalizeDiscordDmOwnerEntry,
      })
    : null;
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg,
    channel: "discord",
    accountId,
  });
  const allowNameMatching = isDangerousNameMatchingEnabled(discordConfig);
  const isSupplementalContextSenderAllowed = createDiscordSupplementalContextAccessChecker({
    channelConfig,
    guildInfo,
    allowNameMatching,
    isGuild: isGuildMessage,
  });
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  let combinedBody = formatInboundEnvelope({
    channel: "Discord",
    from: fromLabel,
    timestamp: resolveTimestampMs(message.timestamp),
    body: text,
    chatType: isDirectMessage ? "direct" : "channel",
    senderLabel,
    previousTimestamp,
    envelope: envelopeOptions,
  });
  const shouldIncludeChannelHistory =
    !isDirectMessage && !(isGuildMessage && channelConfig?.autoThread && !threadChannel);
  if (shouldIncludeChannelHistory) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: guildHistories,
      historyKey: messageChannelId,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "Discord",
          from: fromLabel,
          timestamp: entry.timestamp,
          body: `${entry.body} [id:${entry.messageId ?? "unknown"} channel:${messageChannelId}]`,
          chatType: "channel",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
  }
  const replyContext = resolveReplyContext(message, resolveDiscordMessageText);
  const replyVisibility = replyContext
    ? evaluateSupplementalContextVisibility({
        mode: contextVisibilityMode,
        kind: "quote",
        senderAllowed: isSupplementalContextSenderAllowed({
          id: replyContext.senderId,
          name: replyContext.senderName,
          tag: replyContext.senderTag,
          memberRoleIds: replyContext.memberRoleIds,
        }),
      })
    : null;
  const filteredReplyContext = replyContext && replyVisibility?.include ? replyContext : null;
  if (replyContext && !filteredReplyContext && isGuildMessage) {
    logVerbose(`discord: drop reply context (mode=${contextVisibilityMode})`);
  }
  if (forumContextLine) {
    combinedBody = `${combinedBody}\n${forumContextLine}`;
  }

  let threadStarterBody: string | undefined;
  let threadLabel: string | undefined;
  let parentSessionKey: string | undefined;
  let modelParentSessionKey: string | undefined;
  if (threadChannel) {
    const includeThreadStarter = channelConfig?.includeThreadStarter !== false;
    if (includeThreadStarter) {
      const starter = await resolveDiscordThreadStarter({
        channel: threadChannel,
        client,
        parentId: threadParentId,
        parentType: threadParentType,
        resolveTimestampMs,
      });
      if (starter?.text) {
        const starterVisibility = evaluateSupplementalContextVisibility({
          mode: contextVisibilityMode,
          kind: "thread",
          senderAllowed: isSupplementalContextSenderAllowed({
            id: starter.authorId,
            name: starter.authorName ?? starter.author,
            tag: starter.authorTag,
            memberRoleIds: starter.memberRoleIds,
          }),
        });
        if (starterVisibility.include) {
          threadStarterBody = starter.text;
        } else {
          logVerbose(`discord: drop thread starter context (mode=${contextVisibilityMode})`);
        }
      }
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
      modelParentSessionKey = parentSessionKey;
    }
    if (!threadParentInheritanceEnabled) {
      parentSessionKey = undefined;
    }
  }
  const mediaPayload = buildDiscordMediaPayload(mediaList);
  const preflightAudioIndex =
    preflightAudioTranscript === undefined
      ? -1
      : mediaList.findIndex((media) => media.contentType?.startsWith("audio/"));
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId: threadChannel ? messageChannelId : undefined,
    parentSessionKey,
    useSuffix: false,
  });
  const replyPlan = await resolveDiscordAutoThreadReplyPlan({
    client,
    message,
    messageChannelId,
    isGuildMessage,
    channelConfig,
    threadChannel,
    channelType: channelInfo?.type,
    channelName: channelInfo?.name,
    channelDescription: channelInfo?.topic,
    baseText: baseText ?? "",
    combinedBody,
    replyToMode,
    agentId: route.agentId,
    channel: route.channel,
    cfg,
    threadParentInheritanceEnabled,
  });
  const deliverTarget = replyPlan.deliverTarget;
  const replyTarget = replyPlan.replyTarget;
  const replyReference = replyPlan.replyReference;
  const autoThreadContext = replyPlan.autoThreadContext;

  const effectiveFrom = isDirectMessage
    ? `discord:${author.id}`
    : (autoThreadContext?.From ?? `discord:channel:${messageChannelId}`);
  const dmConversationTarget = isDirectMessage
    ? resolveDiscordConversationIdentity({
        isDirectMessage,
        userId: author.id,
      })
    : undefined;
  const effectiveTo = autoThreadContext?.To ?? dmConversationTarget ?? replyTarget;
  if (!effectiveTo) {
    runtime.error?.(danger("discord: missing reply target"));
    return null;
  }
  const lastRouteTo = dmConversationTarget ?? effectiveTo;
  const inboundHistory =
    shouldIncludeChannelHistory && historyLimit > 0
      ? (guildHistories.get(messageChannelId) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;
  const originatingTo = autoThreadContext?.OriginatingTo ?? dmConversationTarget ?? replyTarget;
  const effectiveSessionKey =
    boundSessionKey ?? autoThreadContext?.SessionKey ?? threadKeys.sessionKey;
  const effectivePreviousTimestamp =
    effectiveSessionKey === route.sessionKey
      ? previousTimestamp
      : readSessionUpdatedAt({
          storePath,
          sessionKey: effectiveSessionKey,
        });

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: preflightAudioTranscript ?? baseText ?? text,
    InboundHistory: inboundHistory,
    RawBody: preflightAudioTranscript ?? baseText,
    CommandBody: preflightAudioTranscript ?? baseText,
    ...(preflightAudioTranscript !== undefined ? { Transcript: preflightAudioTranscript } : {}),
    From: effectiveFrom,
    To: effectiveTo,
    SessionKey: effectiveSessionKey,
    AccountId: route.accountId,
    ChatType: isDirectMessage ? "direct" : "channel",
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: sender.id,
    SenderUsername: senderUsername,
    SenderTag: sender.tag,
    GroupSubject: groupSubject,
    GroupChannel: groupChannel,
    MemberRoleIds: memberRoleIds,
    UntrustedContext: untrustedContext,
    GroupSystemPrompt: isGuildMessage ? groupSystemPrompt : undefined,
    GroupSpace: isGuildMessage ? (guildInfo?.id ?? guildSlug) || undefined : undefined,
    OwnerAllowFrom: ownerAllowFrom,
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: ctx.effectiveWasMentioned,
    MessageSid: canonicalMessageId ?? message.id,
    ...(canonicalMessageId && canonicalMessageId !== message.id
      ? { MessageSidFull: message.id }
      : {}),
    ReplyToId: filteredReplyContext?.id,
    ReplyToBody: filteredReplyContext?.body,
    ReplyToSender: filteredReplyContext?.sender,
    ParentSessionKey: autoThreadContext?.ParentSessionKey ?? threadKeys.parentSessionKey,
    ModelParentSessionKey:
      autoThreadContext?.ModelParentSessionKey ?? modelParentSessionKey ?? undefined,
    MessageThreadId: threadChannel?.id ?? autoThreadContext?.createdThreadId ?? undefined,
    ThreadStarterBody: !effectivePreviousTimestamp ? threadStarterBody : undefined,
    ThreadLabel: threadLabel,
    Timestamp: resolveTimestampMs(message.timestamp),
    ...mediaPayload,
    ...(preflightAudioIndex >= 0 ? { MediaTranscribedIndexes: [preflightAudioIndex] } : {}),
    CommandAuthorized: commandAuthorized,
    CommandSource: "text" as const,
    OriginatingChannel: "discord" as const,
    OriginatingTo: originatingTo,
  });
  const persistedSessionKey = ctxPayload.SessionKey ?? route.sessionKey;

  if (shouldLogVerbose()) {
    const preview = truncateUtf16Safe(combinedBody, 200).replace(/\n/g, "\\n");
    logVerbose(
      `discord inbound: channel=${messageChannelId} deliver=${deliverTarget} from=${ctxPayload.From} preview="${preview}"`,
    );
  }

  return {
    ctxPayload,
    persistedSessionKey,
    turn: {
      storePath,
      record: {
        updateLastRoute: {
          sessionKey: persistedSessionKey,
          channel: "discord",
          to: lastRouteTo,
          accountId: route.accountId,
          mainDmOwnerPin:
            isDirectMessage && persistedSessionKey === route.mainSessionKey && pinnedMainDmOwner
              ? {
                  ownerRecipient: pinnedMainDmOwner,
                  senderRecipient: author.id,
                  onSkip: ({
                    ownerRecipient,
                    senderRecipient,
                  }: {
                    ownerRecipient: string;
                    senderRecipient: string;
                  }) => {
                    logVerbose(
                      `discord: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                    );
                  },
                }
              : undefined,
        },
        onRecordError: (err: unknown) => {
          logVerbose(`discord: failed updating session meta: ${String(err)}`);
        },
      },
    },
    replyPlan,
    deliverTarget,
    replyTarget,
    replyReference,
  };
}
