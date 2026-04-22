import { ChannelType, type RequestClient } from "@buape/carbon";
import {
  EmbeddedBlockChunker,
  resolveAckReaction,
  resolveHumanDelayConfig,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  createStatusReactionController,
  DEFAULT_TIMING,
  logAckFailure,
  logTypingFailure,
  shouldAckReaction as shouldAckReactionGate,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import { deliverFinalizableDraftPreview } from "openclaw/plugin-sdk/channel-lifecycle";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import {
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingPreviewToolProgress,
} from "openclaw/plugin-sdk/channel-streaming";
import {
  isDangerousNameMatchingEnabled,
  readSessionUpdatedAt,
  resolveChannelContextVisibilityMode,
  resolveMarkdownTableMode,
  resolveStorePath,
} from "openclaw/plugin-sdk/config-runtime";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { resolveChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { buildAgentSessionKey, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { evaluateSupplementalContextVisibility } from "openclaw/plugin-sdk/security-runtime";
import {
  convertMarkdownTables,
  stripInlineDirectiveTagsForDelivery,
  stripReasoningTagsFromText,
  truncateUtf16Safe,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { createDiscordRestClient } from "../client.js";
import { resolveDiscordConversationIdentity } from "../conversation-identity.js";
import { resolveDiscordDraftStreamingChunking } from "../draft-chunking.js";
import { createDiscordDraftStream } from "../draft-stream.js";
import { resolveDiscordPreviewStreamMode } from "../preview-streaming.js";
import { removeReactionDiscord } from "../send.js";
import { editMessageDiscord } from "../send.messages.js";
import {
  createDiscordAckReactionAdapter,
  createDiscordAckReactionContext,
  queueInitialDiscordAckReaction,
} from "./ack-reactions.js";
import { normalizeDiscordSlug } from "./allow-list.js";
import { resolveTimestampMs } from "./format.js";
import {
  buildDiscordInboundAccessContext,
  createDiscordSupplementalContextAccessChecker,
} from "./inbound-context.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import {
  buildDiscordMediaPayload,
  resolveDiscordMessageText,
  resolveForwardedMediaList,
  resolveMediaList,
} from "./message-utils.js";
import { buildDirectLabel, buildGuildLabel, resolveReplyContext } from "./reply-context.js";
import { deliverDiscordReply } from "./reply-delivery.js";
import { resolveDiscordAutoThreadReplyPlan, resolveDiscordThreadStarter } from "./threading.js";
import {
  DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
  DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
} from "./timeouts.js";
import { sendTyping } from "./typing.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const DISCORD_TYPING_MAX_DURATION_MS = 20 * 60_000;
let replyRuntimePromise: Promise<typeof import("openclaw/plugin-sdk/reply-runtime")> | undefined;

async function loadReplyRuntime() {
  replyRuntimePromise ??= import("openclaw/plugin-sdk/reply-runtime");
  return await replyRuntimePromise;
}

function isProcessAborted(abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted);
}

type DiscordMessageProcessObserver = {
  onFinalReplyStart?: () => void;
  onFinalReplyDelivered?: () => void;
  onReplyPlanResolved?: (params: { createdThreadId?: string; sessionKey?: string }) => void;
};

export async function processDiscordMessage(
  ctx: DiscordMessagePreflightContext,
  observer?: DiscordMessageProcessObserver,
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
    sender,
    data,
    client,
    channelInfo,
    channelName,
    messageChannelId,
    isGuildMessage,
    isDirectMessage,
    isGroupDm,
    baseText,
    messageText,
    shouldRequireMention,
    canDetectMention,
    effectiveWasMentioned,
    shouldBypassMention,
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
    threadBindings,
    route,
    commandAuthorized,
    discordRestFetch,
    abortSignal,
  } = ctx;
  if (isProcessAborted(abortSignal)) {
    return;
  }

  const ssrfPolicy = cfg.browser?.ssrfPolicy;
  const mediaResolveOptions = {
    fetchImpl: discordRestFetch,
    ssrfPolicy,
    readIdleTimeoutMs: DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
    totalTimeoutMs: DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
    abortSignal,
  };
  const mediaList = await resolveMediaList(message, mediaMaxBytes, mediaResolveOptions);
  if (isProcessAborted(abortSignal)) {
    return;
  }
  const forwardedMediaList = await resolveForwardedMediaList(
    message,
    mediaMaxBytes,
    mediaResolveOptions,
  );
  if (isProcessAborted(abortSignal)) {
    return;
  }
  mediaList.push(...forwardedMediaList);
  const text = messageText;
  if (!text) {
    logVerbose("discord: drop message " + message.id + " (empty content)");
    return;
  }

  const boundThreadId = ctx.threadBinding?.conversation?.conversationId?.trim();
  if (boundThreadId && typeof threadBindings.touchThread === "function") {
    threadBindings.touchThread({ threadId: boundThreadId });
  }
  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "discord",
    accountId,
  });
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        scope: ackReactionScope,
        isDirect: isDirectMessage,
        isGroup: isGuildMessage || isGroupDm,
        isMentionableGroup: isGuildMessage,
        requireMention: shouldRequireMention,
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention,
      }),
    );
  const shouldSendAckReaction = shouldAckReaction();
  const statusReactionsEnabled =
    shouldSendAckReaction && cfg.messages?.statusReactions?.enabled !== false;
  const feedbackRest = createDiscordRestClient({
    cfg,
    token,
    accountId,
  }).rest as unknown as RequestClient;
  const deliveryRest = createDiscordRestClient({
    cfg,
    token,
    accountId,
  }).rest as unknown as RequestClient;
  // Discord outbound helpers expect Carbon's request client shape explicitly.
  const ackReactionContext = createDiscordAckReactionContext({
    rest: feedbackRest,
    cfg,
    accountId,
  });
  const discordAdapter = createDiscordAckReactionAdapter({
    channelId: messageChannelId,
    messageId: message.id,
    reactionContext: ackReactionContext,
  });
  const statusReactions = createStatusReactionController({
    enabled: statusReactionsEnabled,
    adapter: discordAdapter,
    initialEmoji: ackReaction,
    emojis: cfg.messages?.statusReactions?.emojis,
    timing: cfg.messages?.statusReactions?.timing,
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "discord",
        target: `${messageChannelId}/${message.id}`,
        error: err,
      });
    },
  });
  queueInitialDiscordAckReaction({
    enabled: statusReactionsEnabled,
    shouldSendAckReaction,
    ackReaction,
    statusReactions,
    reactionAdapter: discordAdapter,
    target: `${messageChannelId}/${message.id}`,
  });
  const { createReplyDispatcherWithTyping, dispatchInboundMessage } = await loadReplyRuntime();

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
  const senderTag = sender.tag;
  const { groupSystemPrompt, ownerAllowFrom, untrustedContext } = buildDiscordInboundAccessContext({
    channelConfig,
    guildInfo,
    sender: { id: sender.id, name: sender.name, tag: sender.tag },
    allowNameMatching: isDangerousNameMatchingEnabled(discordConfig),
    isGuild: isGuildMessage,
    channelTopic: channelInfo?.topic,
    messageBody: text,
  });
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
          // Keep thread starter as raw text; metadata is provided out-of-band in the system prompt.
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
    }
  }
  const mediaPayload = buildDiscordMediaPayload(mediaList);
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
  });
  const deliverTarget = replyPlan.deliverTarget;
  const replyTarget = replyPlan.replyTarget;
  const replyReference = replyPlan.replyReference;
  const autoThreadContext = replyPlan.autoThreadContext;

  const effectiveFrom = isDirectMessage
    ? `discord:${author.id}`
    : (autoThreadContext?.From ?? `discord:channel:${messageChannelId}`);
  const effectiveTo = autoThreadContext?.To ?? replyTarget;
  if (!effectiveTo) {
    runtime.error?.(danger("discord: missing reply target"));
    return;
  }
  const dmConversationTarget = isDirectMessage
    ? resolveDiscordConversationIdentity({
        isDirectMessage,
        userId: author.id,
      })
    : undefined;
  // Keep DM routes user-addressed so follow-up sends resolve direct session keys.
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

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: baseText ?? text,
    InboundHistory: inboundHistory,
    RawBody: baseText,
    CommandBody: baseText,
    From: effectiveFrom,
    To: effectiveTo,
    SessionKey: boundSessionKey ?? autoThreadContext?.SessionKey ?? threadKeys.sessionKey,
    AccountId: route.accountId,
    ChatType: isDirectMessage ? "direct" : "channel",
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: sender.id,
    SenderUsername: senderUsername,
    SenderTag: senderTag,
    GroupSubject: groupSubject,
    GroupChannel: groupChannel,
    MemberRoleIds: memberRoleIds,
    UntrustedContext: untrustedContext,
    GroupSystemPrompt: isGuildMessage ? groupSystemPrompt : undefined,
    GroupSpace: isGuildMessage ? (guildInfo?.id ?? guildSlug) || undefined : undefined,
    OwnerAllowFrom: ownerAllowFrom,
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: effectiveWasMentioned,
    MessageSid: message.id,
    ReplyToId: filteredReplyContext?.id,
    ReplyToBody: filteredReplyContext?.body,
    ReplyToSender: filteredReplyContext?.sender,
    ParentSessionKey: autoThreadContext?.ParentSessionKey ?? threadKeys.parentSessionKey,
    MessageThreadId: threadChannel?.id ?? autoThreadContext?.createdThreadId ?? undefined,
    ThreadStarterBody: threadStarterBody,
    ThreadLabel: threadLabel,
    Timestamp: resolveTimestampMs(message.timestamp),
    ...mediaPayload,
    CommandAuthorized: commandAuthorized,
    CommandSource: "text" as const,
    // Originating channel for reply routing.
    OriginatingChannel: "discord" as const,
    OriginatingTo: originatingTo,
  });
  const persistedSessionKey = ctxPayload.SessionKey ?? route.sessionKey;
  observer?.onReplyPlanResolved?.({
    createdThreadId: replyPlan.createdThreadId,
    sessionKey: persistedSessionKey,
  });

  await recordInboundSession({
    storePath,
    sessionKey: persistedSessionKey,
    ctx: ctxPayload,
    updateLastRoute: {
      sessionKey: persistedSessionKey,
      channel: "discord",
      to: lastRouteTo,
      accountId: route.accountId,
    },
    onRecordError: (err) => {
      logVerbose(`discord: failed updating session meta: ${String(err)}`);
    },
  });

  if (shouldLogVerbose()) {
    const preview = truncateUtf16Safe(combinedBody, 200).replace(/\n/g, "\\n");
    logVerbose(
      `discord inbound: channel=${messageChannelId} deliver=${deliverTarget} from=${ctxPayload.From} preview="${preview}"`,
    );
  }

  const typingChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : messageChannelId;

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: "discord",
    accountId: route.accountId,
    typing: {
      start: () => sendTyping({ rest: feedbackRest, channelId: typingChannelId }),
      onStartError: (err) => {
        logTypingFailure({
          log: logVerbose,
          channel: "discord",
          target: typingChannelId,
          error: err,
        });
      },
      // Long tool-heavy runs are expected on Discord; keep heartbeats alive.
      maxDurationMs: DISCORD_TYPING_MAX_DURATION_MS,
    },
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "discord",
    accountId,
  });
  const maxLinesPerMessage = resolveDiscordMaxLinesPerMessage({
    cfg,
    discordConfig,
    accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "discord", accountId);

  // --- Discord draft stream (edit-based preview streaming) ---
  const discordStreamMode = resolveDiscordPreviewStreamMode(discordConfig);
  const draftMaxChars = Math.min(textLimit, 2000);
  const accountBlockStreamingEnabled =
    resolveChannelStreamingBlockEnabled(discordConfig) ??
    cfg.agents?.defaults?.blockStreamingDefault === "on";
  const canStreamDraft = discordStreamMode !== "off" && !accountBlockStreamingEnabled;
  const draftReplyToMessageId = () => replyReference.peek();
  const deliverChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : messageChannelId;
  const draftStream = canStreamDraft
    ? createDiscordDraftStream({
        rest: deliveryRest,
        channelId: deliverChannelId,
        maxChars: draftMaxChars,
        replyToMessageId: draftReplyToMessageId,
        minInitialChars: 30,
        throttleMs: 1200,
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;
  const draftChunking =
    draftStream && discordStreamMode === "block"
      ? resolveDiscordDraftStreamingChunking(cfg, accountId)
      : undefined;
  const shouldSplitPreviewMessages = discordStreamMode === "block";
  const draftChunker = draftChunking ? new EmbeddedBlockChunker(draftChunking) : undefined;
  let lastPartialText = "";
  let draftText = "";
  let hasStreamedMessage = false;
  let finalizedViaPreviewMessage = false;
  let draftFinalDeliveryHandled = false;
  const previewToolProgressEnabled =
    Boolean(draftStream) && resolveChannelStreamingPreviewToolProgress(discordConfig);
  let previewToolProgressSuppressed = false;
  let previewToolProgressLines: string[] = [];

  const pushPreviewToolProgress = (line?: string) => {
    if (!draftStream || !previewToolProgressEnabled || previewToolProgressSuppressed) {
      return;
    }
    const normalized = line?.replace(/\s+/g, " ").trim();
    if (!normalized) {
      return;
    }
    const previous = previewToolProgressLines.at(-1);
    if (previous === normalized) {
      return;
    }
    previewToolProgressLines = [...previewToolProgressLines, normalized].slice(-8);
    const previewText = ["Working…", ...previewToolProgressLines.map((entry) => `• ${entry}`)].join(
      "\n",
    );
    lastPartialText = previewText;
    draftText = previewText;
    hasStreamedMessage = true;
    draftChunker?.reset();
    draftStream.update(previewText);
  };

  const resolvePreviewFinalText = (text?: string) => {
    if (typeof text !== "string") {
      return undefined;
    }
    const formatted = convertMarkdownTables(
      stripInlineDirectiveTagsForDelivery(text).text,
      tableMode,
    );
    const chunks = chunkDiscordTextWithMode(formatted, {
      maxChars: draftMaxChars,
      maxLines: maxLinesPerMessage,
      chunkMode,
    });
    if (!chunks.length && formatted) {
      chunks.push(formatted);
    }
    if (chunks.length !== 1) {
      return undefined;
    }
    const trimmed = chunks[0].trim();
    if (!trimmed) {
      return undefined;
    }
    const currentPreviewText = discordStreamMode === "block" ? draftText : lastPartialText;
    if (
      currentPreviewText &&
      currentPreviewText.startsWith(trimmed) &&
      trimmed.length < currentPreviewText.length
    ) {
      return undefined;
    }
    return trimmed;
  };

  const updateDraftFromPartial = (text?: string) => {
    if (!draftStream || !text) {
      return;
    }
    // Strip reasoning/thinking tags that may leak through the stream.
    const cleaned = stripInlineDirectiveTagsForDelivery(
      stripReasoningTagsFromText(text, { mode: "strict", trim: "both" }),
    ).text;
    // Skip pure-reasoning messages (e.g. "Reasoning:\n…") that contain no answer text.
    if (!cleaned || cleaned.startsWith("Reasoning:\n")) {
      return;
    }
    if (cleaned === lastPartialText) {
      return;
    }
    previewToolProgressSuppressed = true;
    previewToolProgressLines = [];
    hasStreamedMessage = true;
    if (discordStreamMode === "partial") {
      // Keep the longer preview to avoid visible punctuation flicker.
      if (
        lastPartialText &&
        lastPartialText.startsWith(cleaned) &&
        cleaned.length < lastPartialText.length
      ) {
        return;
      }
      lastPartialText = cleaned;
      draftStream.update(cleaned);
      return;
    }

    let delta = cleaned;
    if (cleaned.startsWith(lastPartialText)) {
      delta = cleaned.slice(lastPartialText.length);
    } else {
      // Streaming buffer reset (or non-monotonic stream). Start fresh.
      draftChunker?.reset();
      draftText = "";
    }
    lastPartialText = cleaned;
    if (!delta) {
      return;
    }
    if (!draftChunker) {
      draftText = cleaned;
      draftStream.update(draftText);
      return;
    }
    draftChunker.append(delta);
    draftChunker.drain({
      force: false,
      emit: (chunk) => {
        draftText += chunk;
        draftStream.update(draftText);
      },
    });
  };

  const flushDraft = async () => {
    if (!draftStream) {
      return;
    }
    if (draftChunker?.hasBuffered()) {
      draftChunker.drain({
        force: true,
        emit: (chunk) => {
          draftText += chunk;
        },
      });
      draftChunker.reset();
      if (draftText) {
        draftStream.update(draftText);
      }
    }
    await draftStream.flush();
  };

  // When draft streaming is active, suppress block streaming to avoid double-streaming.
  const disableBlockStreamingForDraft = draftStream ? true : undefined;
  let finalReplyStartNotified = false;
  const notifyFinalReplyStart = () => {
    if (finalReplyStartNotified) {
      return;
    }
    finalReplyStartNotified = true;
    observer?.onFinalReplyStart?.();
  };

  const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } =
    createReplyDispatcherWithTyping({
      ...replyPipeline,
      humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
      deliver: async (payload: ReplyPayload, info) => {
        if (isProcessAborted(abortSignal)) {
          return;
        }
        const isFinal = info.kind === "final";
        if (payload.isReasoning) {
          // Reasoning/thinking payloads should not be delivered to Discord.
          return;
        }
        if (draftStream && isFinal) {
          draftFinalDeliveryHandled = true;
          const reply = resolveSendableOutboundReplyParts(payload);
          const hasMedia = reply.hasMedia;
          const finalText = payload.text;
          const previewFinalText = resolvePreviewFinalText(finalText);
          const hasExplicitReplyDirective =
            Boolean(payload.replyToTag || payload.replyToCurrent) ||
            (typeof finalText === "string" && /\[\[\s*reply_to(?:_current|\s*:)/i.test(finalText));

          const result = await deliverFinalizableDraftPreview({
            kind: info.kind,
            payload,
            draft: {
              flush: flushDraft,
              clear: draftStream.clear,
              discardPending: draftStream.discardPending,
              seal: draftStream.seal,
              id: draftStream.messageId,
            },
            buildFinalEdit: () => {
              if (
                finalizedViaPreviewMessage ||
                hasMedia ||
                typeof previewFinalText !== "string" ||
                hasExplicitReplyDirective ||
                payload.isError
              ) {
                return undefined;
              }
              return { content: previewFinalText };
            },
            editFinal: async (previewMessageId, edit) => {
              if (isProcessAborted(abortSignal)) {
                throw new Error("process aborted");
              }
              notifyFinalReplyStart();
              await editMessageDiscord(deliverChannelId, previewMessageId, edit, {
                rest: deliveryRest,
              });
            },
            deliverNormally: async () => {
              if (isProcessAborted(abortSignal)) {
                return false;
              }
              const replyToId = replyReference.use();
              notifyFinalReplyStart();
              await deliverDiscordReply({
                cfg,
                replies: [payload],
                target: deliverTarget,
                token,
                accountId,
                rest: deliveryRest,
                runtime,
                replyToId,
                replyToMode,
                textLimit,
                maxLinesPerMessage,
                tableMode,
                chunkMode,
                sessionKey: ctxPayload.SessionKey,
                threadBindings,
                mediaLocalRoots,
              });
              replyReference.markSent();
              observer?.onFinalReplyDelivered?.();
              return true;
            },
            onPreviewFinalized: () => {
              finalizedViaPreviewMessage = true;
              replyReference.markSent();
              observer?.onFinalReplyDelivered?.();
            },
            logPreviewEditFailure: (err) => {
              logVerbose(
                `discord: preview final edit failed; falling back to standard send (${String(err)})`,
              );
            },
          });
          if (result !== "normal-skipped") {
            return;
          }
        }
        if (isProcessAborted(abortSignal)) {
          return;
        }

        const replyToId = replyReference.use();
        if (isFinal) {
          notifyFinalReplyStart();
        }
        await deliverDiscordReply({
          cfg,
          replies: [payload],
          target: deliverTarget,
          token,
          accountId,
          rest: deliveryRest,
          runtime,
          replyToId,
          replyToMode,
          textLimit,
          maxLinesPerMessage,
          tableMode,
          chunkMode,
          sessionKey: ctxPayload.SessionKey,
          threadBindings,
          mediaLocalRoots,
        });
        replyReference.markSent();
        if (isFinal) {
          observer?.onFinalReplyDelivered?.();
        }
      },
      onError: (err, info) => {
        runtime.error?.(danger(`discord ${info.kind} reply failed: ${String(err)}`));
      },
      onReplyStart: async () => {
        if (isProcessAborted(abortSignal)) {
          return;
        }
        await replyPipeline.typingCallbacks?.onReplyStart();
        await statusReactions.setThinking();
      },
    });

  const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(discordConfig);
  let dispatchResult: Awaited<ReturnType<typeof dispatchInboundMessage>> | null = null;
  let dispatchError = false;
  let dispatchAborted = false;
  try {
    if (isProcessAborted(abortSignal)) {
      dispatchAborted = true;
      return;
    }
    dispatchResult = await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        abortSignal,
        skillFilter: channelConfig?.skills,
        disableBlockStreaming:
          disableBlockStreamingForDraft ??
          (typeof resolvedBlockStreamingEnabled === "boolean"
            ? !resolvedBlockStreamingEnabled
            : undefined),
        onPartialReply: draftStream ? (payload) => updateDraftFromPartial(payload.text) : undefined,
        onAssistantMessageStart: draftStream
          ? () => {
              if (shouldSplitPreviewMessages && hasStreamedMessage) {
                logVerbose("discord: calling forceNewMessage() for draft stream");
                draftStream.forceNewMessage();
              }
              lastPartialText = "";
              draftText = "";
              draftChunker?.reset();
              previewToolProgressSuppressed = false;
              previewToolProgressLines = [];
            }
          : undefined,
        onReasoningEnd: draftStream
          ? () => {
              if (shouldSplitPreviewMessages && hasStreamedMessage) {
                logVerbose("discord: calling forceNewMessage() for draft stream");
                draftStream.forceNewMessage();
              }
              lastPartialText = "";
              draftText = "";
              draftChunker?.reset();
              previewToolProgressSuppressed = false;
              previewToolProgressLines = [];
            }
          : undefined,
        onModelSelected,
        suppressDefaultToolProgressMessages: previewToolProgressEnabled ? true : undefined,
        onReasoningStream: async () => {
          await statusReactions.setThinking();
        },
        onToolStart: async (payload) => {
          if (isProcessAborted(abortSignal)) {
            return;
          }
          await statusReactions.setTool(payload.name);
          pushPreviewToolProgress(payload.name ? `tool: ${payload.name}` : "tool running");
        },
        onItemEvent: async (payload) => {
          pushPreviewToolProgress(
            payload.progressText ?? payload.summary ?? payload.title ?? payload.name,
          );
        },
        onPlanUpdate: async (payload) => {
          if (payload.phase !== "update") {
            return;
          }
          pushPreviewToolProgress(payload.explanation ?? payload.steps?.[0] ?? "planning");
        },
        onApprovalEvent: async (payload) => {
          if (payload.phase !== "requested") {
            return;
          }
          pushPreviewToolProgress(
            payload.command ? `approval: ${payload.command}` : "approval requested",
          );
        },
        onCommandOutput: async (payload) => {
          if (payload.phase !== "end") {
            return;
          }
          pushPreviewToolProgress(
            payload.name
              ? `${payload.name}${payload.exitCode === 0 ? " ✓" : payload.exitCode != null ? ` (exit ${payload.exitCode})` : ""}`
              : payload.title,
          );
        },
        onPatchSummary: async (payload) => {
          if (payload.phase !== "end") {
            return;
          }
          pushPreviewToolProgress(payload.summary ?? payload.title ?? "patch applied");
        },
        onCompactionStart: async () => {
          if (isProcessAborted(abortSignal)) {
            return;
          }
          await statusReactions.setCompacting();
        },
        onCompactionEnd: async () => {
          if (isProcessAborted(abortSignal)) {
            return;
          }
          statusReactions.cancelPending();
          await statusReactions.setThinking();
        },
      },
    });
    if (isProcessAborted(abortSignal)) {
      dispatchAborted = true;
      return;
    }
  } catch (err) {
    if (isProcessAborted(abortSignal)) {
      dispatchAborted = true;
      return;
    }
    dispatchError = true;
    throw err;
  } finally {
    try {
      if (!draftFinalDeliveryHandled) {
        await draftStream?.discardPending();
      }
      if (!draftFinalDeliveryHandled && !finalizedViaPreviewMessage && draftStream?.messageId()) {
        await draftStream?.clear();
      }
    } catch (err) {
      // Draft cleanup should never keep typing alive.
      logVerbose(`discord: draft cleanup failed: ${String(err)}`);
    } finally {
      markRunComplete();
      markDispatchIdle();
    }
    if (statusReactionsEnabled) {
      if (dispatchAborted) {
        if (removeAckAfterReply) {
          void statusReactions.clear();
        } else {
          void statusReactions.restoreInitial();
        }
      } else {
        if (dispatchError) {
          await statusReactions.setError();
        } else {
          await statusReactions.setDone();
        }
        if (removeAckAfterReply) {
          void (async () => {
            await sleep(dispatchError ? DEFAULT_TIMING.errorHoldMs : DEFAULT_TIMING.doneHoldMs);
            await statusReactions.clear();
          })();
        } else {
          void statusReactions.restoreInitial();
        }
      }
    } else if (shouldSendAckReaction && ackReaction && removeAckAfterReply) {
      void removeReactionDiscord(
        messageChannelId,
        message.id,
        ackReaction,
        ackReactionContext,
      ).catch((err: unknown) => {
        logAckFailure({
          log: logVerbose,
          channel: "discord",
          target: `${messageChannelId}/${message.id}`,
          error: err,
        });
      });
    }
  }
  if (dispatchAborted) {
    return;
  }

  if (!dispatchResult?.queuedFinal) {
    if (isGuildMessage) {
      clearHistoryEntriesIfEnabled({
        historyMap: guildHistories,
        historyKey: messageChannelId,
        limit: historyLimit,
      });
    }
    return;
  }
  if (shouldLogVerbose()) {
    const finalCount = dispatchResult.counts.final;
    logVerbose(
      `discord: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
    );
  }
  if (isGuildMessage) {
    clearHistoryEntriesIfEnabled({
      historyMap: guildHistories,
      historyKey: messageChannelId,
      limit: historyLimit,
    });
  }
}
