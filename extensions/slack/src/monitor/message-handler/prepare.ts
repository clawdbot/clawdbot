import { resolveAckReaction } from "openclaw/plugin-sdk/agent-runtime";
import {
  shouldAckReaction as shouldAckReactionGate,
  type AckReactionScope,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  buildMentionRegexes,
  formatInboundEnvelope,
  implicitMentionKindWhen,
  logInboundDrop,
  matchesMentionWithExplicit,
  resolveEnvelopeFormatOptions,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
import { hasControlCommand } from "openclaw/plugin-sdk/command-auth";
import { shouldHandleTextCommands } from "openclaw/plugin-sdk/command-auth";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/infra-runtime";
import {
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntryIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveSlackReplyToMode, type ResolvedSlackAccount } from "../../accounts.js";
import { reactSlackMessage } from "../../actions.js";
import { hasSlackThreadParticipation } from "../../sent-thread-cache.js";
import { resolveSlackThreadContext } from "../../threading.js";
import type { SlackMessageEvent } from "../../types.js";
import {
  normalizeAllowListLower,
  normalizeSlackAllowOwnerEntry,
  resolveSlackAllowListMatch,
  resolveSlackUserAllowed,
} from "../allow-list.js";
import { resolveSlackEffectiveAllowFrom } from "../auth.js";
import { resolveSlackChannelConfig } from "../channel-config.js";
import { stripSlackMentionsForCommandDetection } from "../commands.js";
import {
  readSessionUpdatedAt,
  resolveChannelContextVisibilityMode,
  resolveStorePath,
} from "../config.runtime.js";
import { normalizeSlackChannelType, type SlackMonitorContext } from "../context.js";
import { recordInboundSession, resolveConversationLabel } from "../conversation.runtime.js";
import { authorizeSlackDirectMessage } from "../dm-auth.js";
import { resolveSlackThreadStarter } from "../media.js";
import { finalizeInboundContext } from "../reply.runtime.js";
import { resolveSlackRoomContextHints } from "../room-context.js";
import { sendMessageSlack } from "../send.runtime.js";
import { resolveSlackMessageContent } from "./prepare-content.js";
import { resolveSlackThreadContextData } from "./prepare-thread-context.js";
import type { PreparedSlackMessage } from "./types.js";

const mentionRegexCache = new WeakMap<SlackMonitorContext, Map<string, RegExp[]>>();

function resolveCachedMentionRegexes(
  ctx: SlackMonitorContext,
  agentId: string | undefined,
): RegExp[] {
  const key = normalizeOptionalString(agentId) ?? "__default__";
  let byAgent = mentionRegexCache.get(ctx);
  if (!byAgent) {
    byAgent = new Map<string, RegExp[]>();
    mentionRegexCache.set(ctx, byAgent);
  }
  const cached = byAgent.get(key);
  if (cached) {
    return cached;
  }
  const built = buildMentionRegexes(ctx.cfg, agentId);
  byAgent.set(key, built);
  return built;
}

type SlackConversationContext = {
  channelInfo: {
    name?: string;
    type?: SlackMessageEvent["channel_type"];
    topic?: string;
    purpose?: string;
  };
  channelName?: string;
  resolvedChannelType: ReturnType<typeof normalizeSlackChannelType>;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isRoom: boolean;
  isRoomish: boolean;
  channelConfig: ReturnType<typeof resolveSlackChannelConfig> | null;
  allowBots: boolean;
  isBotMessage: boolean;
};

type SlackAuthorizationContext = {
  senderId: string;
  allowFromLower: string[];
};

type SlackRoutingContext = {
  route: ReturnType<typeof resolveAgentRoute>;
  chatType: "direct" | "group" | "channel";
  replyToMode: ReturnType<typeof resolveSlackReplyToMode>;
  threadContext: ReturnType<typeof resolveSlackThreadContext>;
  threadTs: string | undefined;
  isThreadReply: boolean;
  threadKeys: ReturnType<typeof resolveThreadSessionKeys>;
  sessionKey: string;
  historyKey: string;
};

async function resolveSlackConversationContext(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
}): Promise<SlackConversationContext> {
  const { ctx, account, message } = params;
  const cfg = ctx.cfg;

  let channelInfo: {
    name?: string;
    type?: SlackMessageEvent["channel_type"];
    topic?: string;
    purpose?: string;
  } = {};
  let resolvedChannelType = normalizeSlackChannelType(message.channel_type, message.channel);
  // D-prefixed channels are always direct messages. Skip channel lookups in
  // that common path to avoid an unnecessary API round-trip.
  if (resolvedChannelType !== "im" && (!message.channel_type || message.channel_type !== "im")) {
    channelInfo = await ctx.resolveChannelName(message.channel);
    resolvedChannelType = normalizeSlackChannelType(
      message.channel_type ?? channelInfo.type,
      message.channel,
    );
  }
  const channelName = channelInfo?.name;
  const isDirectMessage = resolvedChannelType === "im";
  const isGroupDm = resolvedChannelType === "mpim";
  const isRoom = resolvedChannelType === "channel" || resolvedChannelType === "group";
  const isRoomish = isRoom || isGroupDm;
  const channelConfig = isRoom
    ? resolveSlackChannelConfig({
        channelId: message.channel,
        channelName,
        channels: ctx.channelsConfig,
        channelKeys: ctx.channelsConfigKeys,
        defaultRequireMention: ctx.defaultRequireMention,
        allowNameMatching: ctx.allowNameMatching,
      })
    : null;
  const allowBots =
    channelConfig?.allowBots ??
    account.config?.allowBots ??
    cfg.channels?.slack?.allowBots ??
    false;

  return {
    channelInfo,
    channelName,
    resolvedChannelType,
    isDirectMessage,
    isGroupDm,
    isRoom,
    isRoomish,
    channelConfig,
    allowBots,
    isBotMessage: Boolean(message.bot_id),
  };
}

async function authorizeSlackInboundMessage(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  conversation: SlackConversationContext;
}): Promise<SlackAuthorizationContext | null> {
  const { ctx, account, message, conversation } = params;
  const { isDirectMessage, channelName, resolvedChannelType, isBotMessage, allowBots } =
    conversation;

  if (isBotMessage) {
    if (message.user && ctx.botUserId && message.user === ctx.botUserId) {
      return null;
    }
    if (!allowBots) {
      logVerbose(`slack: drop bot message ${message.bot_id ?? "unknown"} (allowBots=false)`);
      return null;
    }
  }

  if (isDirectMessage && !message.user) {
    logVerbose("slack: drop dm message (missing user id)");
    return null;
  }

  const senderId = message.user ?? (isBotMessage ? message.bot_id : undefined);
  if (!senderId) {
    logVerbose("slack: drop message (missing sender id)");
    return null;
  }

  if (
    !ctx.isChannelAllowed({
      channelId: message.channel,
      channelName,
      channelType: resolvedChannelType,
    })
  ) {
    logVerbose("slack: drop message (channel not allowed)");
    return null;
  }

  const { allowFromLower } = await resolveSlackEffectiveAllowFrom(ctx, {
    includePairingStore: isDirectMessage,
  });

  if (isDirectMessage) {
    const directUserId = message.user;
    if (!directUserId) {
      logVerbose("slack: drop dm message (missing user id)");
      return null;
    }
    const allowed = await authorizeSlackDirectMessage({
      ctx,
      accountId: account.accountId,
      senderId: directUserId,
      allowFromLower,
      resolveSenderName: ctx.resolveUserName,
      sendPairingReply: async (text) => {
        await sendMessageSlack(message.channel, text, {
          cfg: ctx.cfg,
          token: ctx.botToken,
          client: ctx.app.client,
          accountId: account.accountId,
        });
      },
      onDisabled: () => {
        logVerbose("slack: drop dm (dms disabled)");
      },
      onUnauthorized: ({ allowMatchMeta }) => {
        logVerbose(
          `Blocked unauthorized slack sender ${message.user} (dmPolicy=${ctx.dmPolicy}, ${allowMatchMeta})`,
        );
      },
      log: logVerbose,
    });
    if (!allowed) {
      return null;
    }
  }

  return {
    senderId,
    allowFromLower,
  };
}

function resolveSlackRoutingContext(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isRoom: boolean;
  isRoomish: boolean;
}): SlackRoutingContext {
  const { ctx, account, message, isDirectMessage, isGroupDm, isRoom, isRoomish } = params;
  const route = resolveAgentRoute({
    cfg: ctx.cfg,
    channel: "slack",
    accountId: account.accountId,
    teamId: ctx.teamId || undefined,
    peer: {
      kind: isDirectMessage ? "direct" : isRoom ? "channel" : "group",
      id: isDirectMessage ? (message.user ?? "unknown") : message.channel,
    },
  });

  const chatType = isDirectMessage ? "direct" : isGroupDm ? "group" : "channel";
  const replyToMode = resolveSlackReplyToMode(account, chatType);
  const threadContext = resolveSlackThreadContext({ message, replyToMode });
  const threadTs = threadContext.incomingThreadTs;
  const isThreadReply = threadContext.isThreadReply;
  // Keep true thread replies thread-scoped, but preserve channel-level sessions
  // for top-level room turns when replyToMode is off.
  // For DMs, preserve existing auto-thread behavior when replyToMode="all".
  const autoThreadId =
    !isThreadReply && replyToMode === "all" && threadContext.messageTs
      ? threadContext.messageTs
      : undefined;
  // Only fork channel/group messages into thread-specific sessions when they are
  // actual thread replies (thread_ts present, different from message ts).
  // Top-level channel messages must stay on the per-channel session for continuity.
  // Before this fix, every channel message used its own ts as threadId, creating
  // isolated sessions per message (regression from #10686).
  const roomThreadId = isThreadReply && threadTs ? threadTs : undefined;
  const canonicalThreadId = isRoomish ? roomThreadId : isThreadReply ? threadTs : autoThreadId;
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey: route.sessionKey,
    threadId: canonicalThreadId,
    parentSessionKey: canonicalThreadId && ctx.threadInheritParent ? route.sessionKey : undefined,
  });
  const sessionKey = threadKeys.sessionKey;
  const historyKey =
    isThreadReply && ctx.threadHistoryScope === "thread" ? sessionKey : message.channel;

  return {
    route,
    chatType,
    replyToMode,
    threadContext,
    threadTs,
    isThreadReply,
    threadKeys,
    sessionKey,
    historyKey,
  };
}

export async function prepareSlackMessage(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
}): Promise<PreparedSlackMessage | null> {
  const { ctx, account, message, opts } = params;
  const cfg = ctx.cfg;
  const conversation = await resolveSlackConversationContext({ ctx, account, message });
  const {
    channelInfo,
    channelName,
    isDirectMessage,
    isGroupDm,
    isRoom,
    isRoomish,
    channelConfig,
    isBotMessage,
  } = conversation;
  const authorization = await authorizeSlackInboundMessage({
    ctx,
    account,
    message,
    conversation,
  });
  if (!authorization) {
    return null;
  }
  const { senderId, allowFromLower } = authorization;
  const routing = resolveSlackRoutingContext({
    ctx,
    account,
    message,
    isDirectMessage,
    isGroupDm,
    isRoom,
    isRoomish,
  });
  const {
    route,
    replyToMode,
    threadContext,
    threadTs,
    isThreadReply,
    threadKeys,
    sessionKey,
    historyKey,
  } = routing;

  const mentionRegexes = resolveCachedMentionRegexes(ctx, route.agentId);
  const hasAnyMention = /<@[^>]+>/.test(message.text ?? "");
  const explicitlyMentioned = Boolean(
    ctx.botUserId && message.text?.includes(`<@${ctx.botUserId}>`),
  );
  const wasMentioned =
    opts.wasMentioned ??
    (!isDirectMessage &&
      matchesMentionWithExplicit({
        text: message.text ?? "",
        mentionRegexes,
        explicit: {
          hasAnyMention,
          isExplicitlyMentioned: explicitlyMentioned,
          canResolveExplicit: Boolean(ctx.botUserId),
        },
      }));
  const implicitMentionKinds =
    isDirectMessage || !ctx.botUserId || !message.thread_ts
      ? []
      : [
          ...implicitMentionKindWhen("reply_to_bot", message.parent_user_id === ctx.botUserId),
          ...implicitMentionKindWhen(
            "bot_thread_participant",
            hasSlackThreadParticipation(account.accountId, message.channel, message.thread_ts),
          ),
        ];

  let resolvedSenderName = normalizeOptionalString(message.username);
  const resolveSenderName = async (): Promise<string> => {
    if (resolvedSenderName) {
      return resolvedSenderName;
    }
    if (message.user) {
      const sender = await ctx.resolveUserName(message.user);
      const normalized = normalizeOptionalString(sender?.name);
      if (normalized) {
        resolvedSenderName = normalized;
        return resolvedSenderName;
      }
    }
    resolvedSenderName = message.user ?? message.bot_id ?? "unknown";
    return resolvedSenderName;
  };
  const senderNameForAuth = ctx.allowNameMatching ? await resolveSenderName() : undefined;

  const channelUserAuthorized = isRoom
    ? resolveSlackUserAllowed({
        allowList: channelConfig?.users,
        userId: senderId,
        userName: senderNameForAuth,
        allowNameMatching: ctx.allowNameMatching,
      })
    : true;
  if (isRoom && !channelUserAuthorized) {
    logVerbose(`Blocked unauthorized slack sender ${senderId} (not in channel users)`);
    return null;
  }

  const allowTextCommands = shouldHandleTextCommands({
    cfg,
    surface: "slack",
  });
  // Strip Slack mentions (<@U123>) before command detection so "@Labrador /new" is recognized
  const textForCommandDetection = stripSlackMentionsForCommandDetection(message.text ?? "");
  const hasControlCommandInMessage = hasControlCommand(textForCommandDetection, cfg);

  const ownerAuthorized = resolveSlackAllowListMatch({
    allowList: allowFromLower,
    id: senderId,
    name: senderNameForAuth,
    allowNameMatching: ctx.allowNameMatching,
  }).allowed;
  const channelUsersAllowlistConfigured =
    isRoom && Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
  const threadContextAllowFromLower = isRoom
    ? channelUsersAllowlistConfigured
      ? normalizeAllowListLower(channelConfig?.users)
      : []
    : isDirectMessage
      ? ctx.dmPolicy === "open"
        ? []
        : allowFromLower
      : [];
  const contextVisibilityMode = resolveChannelContextVisibilityMode({
    cfg: ctx.cfg,
    channel: "slack",
    accountId: account.accountId,
  });
  const channelCommandAuthorized =
    isRoom && channelUsersAllowlistConfigured
      ? resolveSlackUserAllowed({
          allowList: channelConfig?.users,
          userId: senderId,
          userName: senderNameForAuth,
          allowNameMatching: ctx.allowNameMatching,
        })
      : false;
  const commandGate = resolveControlCommandGate({
    useAccessGroups: ctx.useAccessGroups,
    authorizers: [
      { configured: allowFromLower.length > 0, allowed: ownerAuthorized },
      {
        configured: channelUsersAllowlistConfigured,
        allowed: channelCommandAuthorized,
      },
    ],
    allowTextCommands,
    hasControlCommand: hasControlCommandInMessage,
  });
  const commandAuthorized = commandGate.commandAuthorized;

  if (isRoomish && commandGate.shouldBlock) {
    logInboundDrop({
      log: logVerbose,
      channel: "slack",
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return null;
  }

  const shouldRequireMention = isRoom
    ? (channelConfig?.requireMention ?? ctx.defaultRequireMention)
    : false;

  // Allow "control commands" to bypass mention gating if sender is authorized.
  const canDetectMention = Boolean(ctx.botUserId) || mentionRegexes.length > 0;
  const mentionDecision = resolveInboundMentionDecision({
    facts: {
      canDetectMention,
      wasMentioned,
      hasAnyMention,
      implicitMentionKinds,
    },
    policy: {
      isGroup: isRoom,
      requireMention: shouldRequireMention,
      allowedImplicitMentionKinds: ctx.threadRequireExplicitMention ? [] : undefined,
      allowTextCommands,
      hasControlCommand: hasControlCommandInMessage,
      commandAuthorized,
    },
  });
  const effectiveWasMentioned = mentionDecision.effectiveWasMentioned;
  if (isRoom && shouldRequireMention && mentionDecision.shouldSkip) {
    ctx.logger.info({ channel: message.channel, reason: "no-mention" }, "skipping channel message");
    const pendingText = (message.text ?? "").trim();
    const fallbackFile = message.files?.[0]?.name
      ? `[Slack file: ${message.files[0].name}]`
      : message.files?.length
        ? "[Slack file]"
        : "";
    const pendingBody = pendingText || fallbackFile;
    recordPendingHistoryEntryIfEnabled({
      historyMap: ctx.channelHistories,
      historyKey,
      limit: ctx.historyLimit,
      entry: pendingBody
        ? {
            sender: await resolveSenderName(),
            body: pendingBody,
            timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
            messageId: message.ts,
          }
        : null,
    });
    return null;
  }

  const threadStarter =
    isThreadReply && threadTs
      ? await resolveSlackThreadStarter({
          channelId: message.channel,
          threadTs,
          client: ctx.app.client,
        })
      : null;
  const resolvedMessageContent = await resolveSlackMessageContent({
    message,
    isThreadReply,
    threadStarter,
    isBotMessage,
    botToken: ctx.botToken,
    mediaMaxBytes: ctx.mediaMaxBytes,
    resolveUserName: ctx.resolveUserName,
  });
  if (!resolvedMessageContent) {
    return null;
  }
  const { rawBody, effectiveDirectMedia } = resolvedMessageContent;

  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "slack",
    accountId: account.accountId,
  });
  const ackReactionValue = ackReaction ?? "";

  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        scope: ctx.ackReactionScope as AckReactionScope | undefined,
        isDirect: isDirectMessage,
        isGroup: isRoomish,
        isMentionableGroup: isRoom,
        requireMention: shouldRequireMention,
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention: mentionDecision.shouldBypassMention,
      }),
    );

  const ackReactionMessageTs = message.ts;
  const statusReactionsWillHandle =
    Boolean(ackReactionMessageTs) &&
    cfg.messages?.statusReactions?.enabled !== false &&
    shouldAckReaction();
  const ackReactionPromise =
    !statusReactionsWillHandle && shouldAckReaction() && ackReactionMessageTs && ackReactionValue
      ? reactSlackMessage(message.channel, ackReactionMessageTs, ackReactionValue, {
          token: ctx.botToken,
          client: ctx.app.client,
        }).then(
          () => true,
          (err) => {
            logVerbose(
              `slack react failed for channel ${message.channel}: ${formatErrorMessage(err)}`,
            );
            return false;
          },
        )
      : statusReactionsWillHandle
        ? Promise.resolve(true)
        : null;

  const roomLabel = channelName ? `#${channelName}` : `#${message.channel}`;
  const senderName = await resolveSenderName();
  const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
  const inboundLabel = isDirectMessage
    ? `Slack DM from ${senderName}`
    : `Slack message in ${roomLabel} from ${senderName}`;
  const slackFrom = isDirectMessage
    ? `slack:${message.user}`
    : isRoom
      ? `slack:channel:${message.channel}`
      : `slack:group:${message.channel}`;

  enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
    sessionKey,
    contextKey: `slack:message:${message.channel}:${message.ts ?? "unknown"}`,
  });

  const envelopeFrom =
    resolveConversationLabel({
      ChatType: isDirectMessage ? "direct" : "channel",
      SenderName: senderName,
      GroupSubject: isRoomish ? roomLabel : undefined,
      From: slackFrom,
    }) ?? (isDirectMessage ? senderName : roomLabel);
  const threadInfo =
    isThreadReply && threadTs
      ? ` thread_ts: ${threadTs}${message.parent_user_id ? ` parent_user_id: ${message.parent_user_id}` : ""}`
      : "";
  const textWithId = `${rawBody}\n[slack message id: ${message.ts} channel: ${message.channel}${threadInfo}]`;
  const storePath = resolveStorePath(ctx.cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(ctx.cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey,
  });
  const body = formatInboundEnvelope({
    channel: "Slack",
    from: envelopeFrom,
    timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
    body: textWithId,
    chatType: isDirectMessage ? "direct" : "channel",
    sender: { name: senderName, id: senderId },
    previousTimestamp,
    envelope: envelopeOptions,
  });

  let combinedBody = body;
  if (isRoomish && ctx.historyLimit > 0) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: ctx.channelHistories,
      historyKey,
      limit: ctx.historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "Slack",
          from: roomLabel,
          timestamp: entry.timestamp,
          body: `${entry.body}${
            entry.messageId ? ` [id:${entry.messageId} channel:${message.channel}]` : ""
          }`,
          chatType: "channel",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
  }

  const slackTo = isDirectMessage ? `user:${message.user}` : `channel:${message.channel}`;

  const { untrustedChannelMetadata, groupSystemPrompt } = resolveSlackRoomContextHints({
    isRoomish,
    channelInfo,
    channelConfig,
  });

  const {
    threadStarterBody,
    threadHistoryBody,
    threadSessionPreviousTimestamp,
    threadLabel,
    threadStarterMedia,
  } = await resolveSlackThreadContextData({
    ctx,
    account,
    message,
    isThreadReply,
    threadTs,
    threadStarter,
    roomLabel,
    storePath,
    sessionKey,
    allowFromLower: threadContextAllowFromLower,
    allowNameMatching: ctx.allowNameMatching,
    contextVisibilityMode,
    envelopeOptions,
    effectiveDirectMedia,
  });

  // Use direct media (including forwarded attachment media) if available, else thread starter media
  const effectiveMedia = effectiveDirectMedia ?? threadStarterMedia;
  const firstMedia = effectiveMedia?.[0];

  const inboundHistory =
    isRoomish && ctx.historyLimit > 0
      ? (ctx.channelHistories.get(historyKey) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;
  const commandBody = textForCommandDetection.trim();

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: rawBody,
    InboundHistory: inboundHistory,
    RawBody: rawBody,
    CommandBody: commandBody,
    BodyForCommands: commandBody,
    From: slackFrom,
    To: slackTo,
    SessionKey: sessionKey,
    AccountId: route.accountId,
    ChatType: isDirectMessage ? "direct" : "channel",
    ConversationLabel: envelopeFrom,
    GroupSubject: isRoomish ? roomLabel : undefined,
    GroupSpace: ctx.teamId || undefined,
    GroupSystemPrompt: groupSystemPrompt,
    UntrustedContext: untrustedChannelMetadata ? [untrustedChannelMetadata] : undefined,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "slack" as const,
    Surface: "slack" as const,
    MessageSid: message.ts,
    ReplyToId: threadContext.replyToId,
    // Preserve thread context for routed tool notifications.
    MessageThreadId: threadContext.messageThreadId,
    ParentSessionKey: threadKeys.parentSessionKey,
    // Only include thread starter body for NEW sessions (existing sessions already have it in their transcript)
    ThreadStarterBody: !threadSessionPreviousTimestamp ? threadStarterBody : undefined,
    ThreadHistoryBody: threadHistoryBody,
    IsFirstThreadTurn:
      isThreadReply && threadTs && !threadSessionPreviousTimestamp ? true : undefined,
    ThreadLabel: threadLabel,
    Timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
    WasMentioned: isRoomish ? effectiveWasMentioned : undefined,
    MediaPath: firstMedia?.path,
    MediaType: firstMedia?.contentType,
    MediaUrl: firstMedia?.path,
    MediaPaths:
      effectiveMedia && effectiveMedia.length > 0 ? effectiveMedia.map((m) => m.path) : undefined,
    MediaUrls:
      effectiveMedia && effectiveMedia.length > 0 ? effectiveMedia.map((m) => m.path) : undefined,
    MediaTypes:
      effectiveMedia && effectiveMedia.length > 0
        ? effectiveMedia.map((m) => m.contentType ?? "")
        : undefined,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: "slack" as const,
    OriginatingTo: slackTo,
    NativeChannelId: message.channel,
  }) satisfies FinalizedMsgContext;
  const pinnedMainDmOwner = isDirectMessage
    ? resolvePinnedMainDmOwnerFromAllowlist({
        dmScope: cfg.session?.dmScope,
        allowFrom: ctx.allowFrom,
        normalizeEntry: normalizeSlackAllowOwnerEntry,
      })
    : null;

  await recordInboundSession({
    storePath,
    sessionKey,
    ctx: ctxPayload,
    updateLastRoute: isDirectMessage
      ? {
          sessionKey: route.mainSessionKey,
          channel: "slack",
          to: `user:${message.user}`,
          accountId: route.accountId,
          threadId: threadContext.messageThreadId,
          mainDmOwnerPin:
            pinnedMainDmOwner && message.user
              ? {
                  ownerRecipient: pinnedMainDmOwner,
                  senderRecipient: normalizeLowercaseStringOrEmpty(message.user),
                  onSkip: ({ ownerRecipient, senderRecipient }) => {
                    logVerbose(
                      `slack: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                    );
                  },
                }
              : undefined,
        }
      : undefined,
    onRecordError: (err) => {
      ctx.logger.warn(
        {
          error: formatErrorMessage(err),
          storePath,
          sessionKey,
        },
        "failed updating session meta",
      );
    },
  });

  // Live DM replies should target the concrete Slack DM channel id we just
  // received on. This avoids depending on a follow-up conversations.open
  // round-trip for the normal reply path while keeping persisted routing
  // metadata user-scoped for later session deliveries.
  const replyTarget = isDirectMessage ? `channel:${message.channel}` : (ctxPayload.To ?? undefined);
  if (!replyTarget) {
    return null;
  }

  if (shouldLogVerbose()) {
    logVerbose(`slack inbound: channel=${message.channel} from=${slackFrom} preview="${preview}"`);
  }

  return {
    ctx,
    account,
    message,
    route,
    channelConfig,
    replyTarget,
    ctxPayload,
    replyToMode,
    isDirectMessage,
    isRoomish,
    historyKey,
    preview,
    ackReactionMessageTs,
    ackReactionValue,
    ackReactionPromise,
  };
}
