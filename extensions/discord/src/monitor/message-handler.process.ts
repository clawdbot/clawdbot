// Discord plugin module implements message handler.process behavior.
import type { APIAllowedMentions } from "discord-api-types/v10";
import { resolveAckReaction, resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  createStatusReactionController,
  DEFAULT_TIMING,
  logAckFailure,
  shouldAckReaction as shouldAckReactionGate,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  dispatchChannelInboundTurn,
  hasFinalInboundReplyDispatch,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelMessageReplyPipeline,
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
  resolveChannelMessageSourceReplyDeliveryMode,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry,
  isChannelProgressDraftWorkToolName,
  resolveChannelStreamingBlockEnabled,
  resolveTranscriptBackedChannelFinalText,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { resolveChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { createChannelHistoryWindow } from "openclaw/plugin-sdk/reply-history";
import {
  getReplyPayloadTtsSupplement,
  isReplyPayloadNonTerminalToolErrorWarning,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  danger,
  logVerbose,
  shouldLogVerbose,
  sleep,
  sleepWithAbort,
} from "openclaw/plugin-sdk/runtime-env";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { readLatestAssistantTextByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { createDiscordRestClient } from "../client.js";
import { beginDiscordInboundEventDeliveryCorrelation } from "../inbound-event-delivery.js";
import { discordTextHasBroadcastMention } from "../mentions.js";
import { removeReactionDiscord } from "../send.js";
import { editMessageDiscord } from "../send.messages.js";
import { resolveDiscordTargetChannelId } from "../send.shared.js";
import type { DiscordMessageEdit } from "../send.types.js";
import { resolveDiscordChannelId } from "../targets.js";
import {
  createDiscordAckReactionAdapter,
  createDiscordAckReactionContext,
  queueInitialDiscordAckReaction,
} from "./ack-reactions.js";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import { createDiscordDraftPreviewController } from "./message-handler.draft-preview.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import { completeDiscordSessionConflict } from "./message-handler.retry.js";
import { deliverDiscordReply, formatDiscordReplyDeliveryFailure } from "./reply-delivery.js";
import { sanitizeDiscordFrontChannelReplyPayloads } from "./reply-safety.js";
import { createDiscordReplyTypingFeedback } from "./reply-typing-feedback.js";

const TARGETED_ONLY_ALLOWED_MENTIONS = {
  parse: ["users", "roles"],
} as APIAllowedMentions;

function isProcessAborted(abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted);
}

function isFallbackOnlyToolWarningFinal(payload: ReplyPayload): boolean {
  if (payload.isError !== true || !isReplyPayloadNonTerminalToolErrorWarning(payload)) {
    return false;
  }
  return !resolveSendableOutboundReplyParts(payload).hasMedia;
}

function isFailedProgress(payload: {
  phase?: string;
  status?: string;
  exitCode?: number | null;
}): boolean {
  return (
    payload.phase === "error" ||
    payload.status === "failed" ||
    payload.status === "error" ||
    (typeof payload.exitCode === "number" && payload.exitCode !== 0)
  );
}

type DiscordReplySkipReason = "aborted before delivery" | "internal-only payload";

export function formatDiscordReplySkip(params: {
  kind: "tool" | "block" | "final";
  reason: DiscordReplySkipReason;
  target: string;
  sessionKey?: string;
}) {
  const context = [
    `target=${params.target}`,
    params.sessionKey ? `session=${params.sessionKey}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return `discord ${params.kind} reply skipped (${params.reason}): ${context}`;
}

type DiscordMessageProcessObserver = {
  onFinalReplyStart?: () => void;
  onFinalReplyDelivered?: () => void;
  onReplyPlanResolved?: (params: { createdThreadId?: string; sessionKey?: string }) => void;
};

type ToolStartPayload = {
  name?: string;
  phase?: string;
  args?: Record<string, unknown>;
  detailMode?: "explain" | "raw";
};

function readToolStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readToolBooleanArg(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

export async function processDiscordMessage(
  ctx: DiscordMessagePreflightContext,
  observer?: DiscordMessageProcessObserver,
) {
  await processDiscordMessageInner(ctx, observer);
}

async function processDiscordMessageInner(
  ctx: DiscordMessagePreflightContext,
  observer?: DiscordMessageProcessObserver,
) {
  const dispatchStartedAt = Date.now();
  const {
    cfg,
    discordConfig,
    accountId,
    token,
    runtime,
    guildHistories,
    historyLimit,
    textLimit,
    replyToMode,
    ackReactionScope,
    message,
    messageChannelId,
    isGuildMessage,
    isDirectMessage,
    isGroupDm,
    messageText,
    shouldRequireMention,
    canDetectMention,
    effectiveWasMentioned,
    shouldBypassMention,
    channelConfig,
    threadBindings,
    route,
    abortSignal,
    turnAdoptionLifecycle,
    preparedMedia: mediaList,
  } = ctx;
  if (isProcessAborted(abortSignal)) {
    return;
  }
  const text = messageText;
  if (!text) {
    logVerbose("discord: drop message " + message.id + " (empty content)");
    return;
  }

  const boundThreadId = ctx.threadBinding?.conversation?.conversationId?.trim();
  if (boundThreadId && typeof threadBindings.touchThread === "function") {
    threadBindings.touchThread({ threadId: boundThreadId });
  }
  const sourceReplyDeliveryMode = resolveChannelMessageSourceReplyDeliveryMode({
    cfg,
    ctx: {
      ChatType: isDirectMessage
        ? "direct"
        : isGroupDm
          ? "group"
          : isGuildMessage
            ? "channel"
            : undefined,
      InboundEventKind: ctx.inboundEventKind,
    },
  });
  const sourceRepliesAreToolOnly = sourceReplyDeliveryMode === "message_tool_only";
  const configuredTypingMode = cfg.session?.typingMode ?? cfg.agents?.defaults?.typingMode;
  const configuredTypingInterval =
    cfg.agents?.defaults?.typingIntervalSeconds ?? cfg.session?.typingIntervalSeconds;
  const shouldDisableCoreTypingKeepalive =
    sourceRepliesAreToolOnly &&
    configuredTypingMode === undefined &&
    configuredTypingInterval === undefined;
  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "discord",
    accountId,
  });
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const isRoomEvent = ctx.inboundEventKind === "room_event";
  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        scope: ackReactionScope,
        inboundEventKind: ctx.inboundEventKind,
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
  const statusReactionsExplicitlyEnabled = cfg.messages?.statusReactions?.enabled === true;
  const statusReactionsEnabled =
    !isRoomEvent &&
    shouldSendAckReaction &&
    cfg.messages?.statusReactions?.enabled !== false &&
    (!sourceRepliesAreToolOnly || statusReactionsExplicitlyEnabled);
  const feedbackRest = createDiscordRestClient({
    cfg,
    token,
    accountId,
  }).rest;
  const deliveryRest = createDiscordRestClient({
    cfg,
    token,
    accountId,
  }).rest;
  // Discord outbound helpers expect the internal REST client shape explicitly.
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
  const statusReactionTiming = {
    ...DEFAULT_TIMING,
    ...cfg.messages?.statusReactions?.timing,
  };
  let statusReactionTarget = `${messageChannelId}/${message.id}`;
  let statusReactionsActive = statusReactionsEnabled;
  let statusReactions = createStatusReactionController({
    enabled: statusReactionsEnabled,
    adapter: discordAdapter,
    initialEmoji: ackReaction,
    emojis: cfg.messages?.statusReactions?.emojis,
    timing: statusReactionTiming,
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "discord",
        target: statusReactionTarget,
        error: err,
      });
    },
  });
  const resolveTrackedReactionChannelId = async (
    args: Record<string, unknown>,
  ): Promise<string> => {
    const target =
      readToolStringArg(args, "channelId") ??
      readToolStringArg(args, "channel_id") ??
      readToolStringArg(args, "to");
    if (!target) {
      return messageChannelId;
    }
    try {
      return resolveDiscordChannelId(target);
    } catch {
      return (
        await resolveDiscordTargetChannelId(target, {
          cfg,
          token,
          accountId,
        })
      ).channelId;
    }
  };
  const maybeBindStatusReactionsToToolReaction = async (payload: ToolStartPayload) => {
    if (
      sourceRepliesAreToolOnly ||
      cfg.messages?.statusReactions?.enabled === false ||
      payload.phase !== "start" ||
      payload.name !== "message" ||
      !payload.args
    ) {
      return;
    }
    const args = payload.args;
    const action = readToolStringArg(args, "action")?.toLowerCase();
    if (action !== "react") {
      return;
    }
    const shouldTrack =
      readToolBooleanArg(args, "trackToolCalls") || readToolBooleanArg(args, "track_tool_calls");
    if (!shouldTrack) {
      return;
    }
    const emoji = readToolStringArg(args, "emoji");
    const remove = readToolBooleanArg(args, "remove");
    if (!emoji || remove) {
      return;
    }
    const trackedMessageId =
      readToolStringArg(args, "messageId") ?? readToolStringArg(args, "message_id") ?? message.id;
    let trackedChannelId: string;
    try {
      trackedChannelId = await resolveTrackedReactionChannelId(args);
    } catch (err) {
      logAckFailure({
        log: logVerbose,
        channel: "discord",
        target: `${readToolStringArg(args, "to") ?? readToolStringArg(args, "channelId") ?? messageChannelId}/${trackedMessageId}`,
        error: err,
      });
      return;
    }
    statusReactionTarget = `${trackedChannelId}/${trackedMessageId}`;
    if (statusReactionsActive) {
      void statusReactions.clear();
    }
    const trackedAdapter = createDiscordAckReactionAdapter({
      channelId: trackedChannelId,
      messageId: trackedMessageId,
      reactionContext: ackReactionContext,
    });
    statusReactions = createStatusReactionController({
      enabled: true,
      adapter: trackedAdapter,
      initialEmoji: emoji,
      emojis: cfg.messages?.statusReactions?.emojis,
      timing: statusReactionTiming,
      onError: (err) => {
        logAckFailure({
          log: logVerbose,
          channel: "discord",
          target: statusReactionTarget,
          error: err,
        });
      },
    });
    statusReactionsActive = true;
    void statusReactions.setQueued();
  };
  let initialAckReactionQueued = false;
  const queueInitialAckReactionAfterRecord = () => {
    if (initialAckReactionQueued) {
      return;
    }
    initialAckReactionQueued = true;
    if (statusReactionsEnabled) {
      statusReactionsActive = true;
    }
    queueInitialDiscordAckReaction({
      enabled: statusReactionsEnabled,
      shouldSendAckReaction,
      ackReaction,
      statusReactions,
      reactionAdapter: discordAdapter,
      target: `${messageChannelId}/${message.id}`,
    });
  };
  const processContext = await buildDiscordMessageProcessContext({
    ctx,
    text,
    mediaList,
  });
  if (!processContext) {
    return;
  }
  const {
    ctxPayload,
    persistedSessionKey,
    turn,
    replyPlan,
    deliverTarget,
    replyTarget,
    replyReference,
  } = processContext;
  observer?.onReplyPlanResolved?.({
    createdThreadId: replyPlan.createdThreadId,
    sessionKey: persistedSessionKey,
  });

  const typingChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : messageChannelId;
  let typingFeedback: ReturnType<typeof createDiscordReplyTypingFeedback> | undefined;
  const getTypingFeedback = () =>
    (typingFeedback ??= createDiscordReplyTypingFeedback({
      cfg,
      token,
      accountId,
      channelId: typingChannelId,
      rest: feedbackRest,
      log: logVerbose,
      keepaliveIntervalMs: shouldDisableCoreTypingKeepalive ? undefined : 0,
    }));

  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: "discord",
    accountId: route.accountId,
    // The core lifecycle reaches this callback only after reply admission.
    // Silent pre-dispatch outcomes therefore never allocate or emit feedback.
    typingCallbacks: {
      onReplyStart: () => getTypingFeedback().onReplyStart(),
      onIdle: () => typingFeedback?.onIdle?.(),
      onCleanup: () => typingFeedback?.onCleanup?.(),
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
  const clearGroupHistory = () => {
    if (isDirectMessage) {
      return;
    }
    createChannelHistoryWindow({ historyMap: guildHistories }).clear({
      historyKey: messageChannelId,
      limit: historyLimit,
    });
  };
  const beginDeliveryCorrelation = () =>
    isRoomEvent
      ? beginDiscordInboundEventDeliveryCorrelation(
          ctxPayload.SessionKey,
          {
            outboundTo: messageChannelId,
            outboundAccountId: route.accountId,
            markInboundEventDelivered: clearGroupHistory,
          },
          { inboundEventKind: ctxPayload.InboundEventKind },
        )
      : () => {};
  const endDiscordInboundEventDeliveryCorrelation = beginDeliveryCorrelation();
  const resolveCurrentTurnTranscriptFinalText = async (): Promise<string | undefined> => {
    const sessionKey = ctxPayload.SessionKey;
    if (!sessionKey) {
      return undefined;
    }
    try {
      const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
      const sessionEntry = getSessionEntry({
        agentId: route.agentId,
        sessionKey,
        storePath,
      });
      if (!sessionEntry?.sessionId) {
        return undefined;
      }
      const latest = await readLatestAssistantTextByIdentity({
        agentId: route.agentId,
        sessionId: sessionEntry.sessionId,
        sessionKey,
        storePath,
      });
      if (!latest?.timestamp || latest.timestamp < dispatchStartedAt) {
        return undefined;
      }
      return latest.text;
    } catch (err) {
      logVerbose(`discord transcript final candidate lookup failed: ${String(err)}`);
      return undefined;
    }
  };

  const deliverChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : messageChannelId;
  const draftPreview = createDiscordDraftPreviewController({
    cfg,
    discordConfig,
    accountId,
    sourceRepliesAreToolOnly,
    textLimit,
    deliveryRest,
    deliverChannelId,
    replyReference,
    tableMode,
    maxLinesPerMessage,
    chunkMode,
    log: logVerbose,
  });
  let shouldYieldDraftProgress: () => boolean = () => false;
  let finalReplyStartNotified = false;
  const notifyFinalReplyStart = () => {
    if (finalReplyStartNotified) {
      return;
    }
    finalReplyStartNotified = true;
    draftPreview.markFinalReplyStarted();
    observer?.onFinalReplyStart?.();
  };
  let userFacingFinalDelivered = false;
  let userFacingFinalDeliveryFailed = false;
  let pendingToolWarningFinal:
    | { payload: ReplyPayload; info: { kind: ReplyDispatchKind } }
    | undefined;
  const markUserFacingFinalDelivered = () => {
    userFacingFinalDelivered = true;
    userFacingFinalDeliveryFailed = false;
    pendingToolWarningFinal = undefined;
    draftPreview.markFinalReplyDelivered();
    observer?.onFinalReplyDelivered?.();
  };
  // Per-line quoting survives Discord chunking; blank quote rows render badly.
  const formatDiscordReasoningQuote = (quoteText: string): string | undefined => {
    const lines = quoteText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) {
      return undefined;
    }
    lines[0] = `🧠 ${lines[0]}`;
    return lines.map((line) => `> ${line}`).join("\n");
  };
  // Reasoning delivery follows the session /reasoning level, not streaming config.
  const reasoningLevel = ((): "on" | "stream" | "off" => {
    const normalizedAgentId = (route.agentId ?? "").trim().toLowerCase() || "main";
    const agentEntryDefault = cfg.agents?.list?.find(
      (entry) => ((entry?.id ?? "").trim().toLowerCase() || "main") === normalizedAgentId,
    )?.reasoningDefault;
    const cfgDefault = agentEntryDefault ?? cfg.agents?.defaults?.reasoningDefault;
    const configDefault: "on" | "stream" | "off" =
      cfgDefault === "on" || cfgDefault === "stream" ? cfgDefault : "off";
    const sessionKey = ctxPayload.SessionKey;
    if (!sessionKey) {
      return configDefault;
    }
    try {
      const storePath = resolveStorePath(cfg.session?.store, { agentId: route.agentId });
      const level = getSessionEntry({
        agentId: route.agentId,
        sessionKey,
        storePath,
      })?.reasoningLevel;
      if (level === "on" || level === "stream" || level === "off") {
        return level;
      }
    } catch {
      return "off";
    }
    return configDefault;
  })();
  const reasoningDurableEnabled = reasoningLevel === "on";
  const reasoningWindowEnabled = reasoningLevel === "stream";
  let progressTurnStartedAt = Date.now();
  let progressReasoningSteps = 0;
  let progressToolCalls = 0;
  let progressCommentaryNotes = 0;
  // Set when a progress draft collapses: the receipt appends to the final
  // answer text and the draft message deletes once that answer delivered.
  let progressReceiptLine: string | undefined;
  let clearProgressDraftAfterFinalDelivery = false;
  // Preamble updates can re-fire; count each item id or id-less text once.
  const seenCommentaryIds = new Set<string>();
  let lastCommentaryNoteText = "";
  const noteWindowCommentary = (itemId?: string, noteText?: string) => {
    const trimmed = noteText?.trim();
    if (!trimmed) {
      return;
    }
    if (itemId) {
      if (seenCommentaryIds.has(itemId)) {
        return;
      }
      seenCommentaryIds.add(itemId);
      progressCommentaryNotes += 1;
      return;
    }
    if (trimmed !== lastCommentaryNoteText) {
      lastCommentaryNoteText = trimmed;
      progressCommentaryNotes += 1;
    }
  };
  // DeepSeek does not always emit a thinking_end, so tool/final boundaries also close bursts.
  let windowReasoningOpen = false;
  const closePendingWindowThought = () => {
    if (windowReasoningOpen) {
      windowReasoningOpen = false;
      progressReasoningSteps += 1;
    }
  };
  const resetProgressTurnState = () => {
    finalReplyStartNotified = false;
    userFacingFinalDelivered = false;
    userFacingFinalDeliveryFailed = false;
    pendingToolWarningFinal = undefined;
    progressTurnStartedAt = Date.now();
    progressReasoningSteps = 0;
    progressToolCalls = 0;
    progressCommentaryNotes = 0;
    progressReceiptLine = undefined;
    clearProgressDraftAfterFinalDelivery = false;
    seenCommentaryIds.clear();
    lastCommentaryNoteText = "";
    windowReasoningOpen = false;
  };
  const handleAssistantMessageBoundary = () => {
    if (draftPreview.handleAssistantMessageBoundary()) {
      resetProgressTurnState();
    }
  };
  const buildProgressSummaryLine = () => {
    closePendingWindowThought();
    const seconds = Math.max(1, Math.round((Date.now() - progressTurnStartedAt) / 1000));
    const parts = [
      ...(progressReasoningSteps > 0
        ? [`🧠 ${progressReasoningSteps} thought${progressReasoningSteps === 1 ? "" : "s"}`]
        : []),
      ...(progressCommentaryNotes > 0
        ? [`💬 ${progressCommentaryNotes} note${progressCommentaryNotes === 1 ? "" : "s"}`]
        : []),
      ...(progressToolCalls > 0
        ? [`🛠️ ${progressToolCalls} tool call${progressToolCalls === 1 ? "" : "s"}`]
        : []),
      `⏱️ ${seconds}s`,
    ];
    return `-# ${parts.join(" · ")}`;
  };
  let replyLifecycleStarted = false;
  const onDiscordReplyStart = async () => {
    if (isProcessAborted(abortSignal)) {
      return;
    }
    replyLifecycleStarted = true;
    await replyPipeline.typingCallbacks?.onReplyStart();
    await statusReactions.setThinking();
  };
  const beforeDiscordPayloadDelivery = (
    payload: ReplyPayload,
    info: { kind: ReplyDispatchKind },
  ): ReplyPayload | null => {
    if (isProcessAborted(abortSignal)) {
      logVerbose(
        formatDiscordReplySkip({
          kind: info.kind,
          reason: "aborted before delivery",
          target: deliverTarget,
          sessionKey: ctxPayload.SessionKey,
        }),
      );
      return null;
    }
    if (payload.isReasoning || payload.isCommentary) {
      return payload;
    }
    if (draftPreview.draftStream && draftPreview.isProgressMode && info.kind === "block") {
      const reply = resolveSendableOutboundReplyParts(payload);
      if (!reply.hasMedia && !payload.isError) {
        return null;
      }
    }
    if (info.kind === "final" && !isFallbackOnlyToolWarningFinal(payload)) {
      draftPreview.markFinalReplyStarted();
    }
    return payload;
  };

  const deliverDiscordPayload = async (
    payload: ReplyPayload,
    info: { kind: ReplyDispatchKind },
    options?: { allowFallbackOnlyToolWarning?: boolean },
  ) => {
    if (isProcessAborted(abortSignal)) {
      // Surface so operators don't chase missing replies when an abort
      // drops a model-produced text payload.
      logVerbose(
        formatDiscordReplySkip({
          kind: info.kind,
          reason: "aborted before delivery",
          target: deliverTarget,
          sessionKey: ctxPayload.SessionKey,
        }),
      );
      return { visibleReplySent: false };
    }
    const isFinal = info.kind === "final";
    if (payload.isReasoning) {
      const raw = (payload.text ?? "").trim();
      const body = raw.startsWith("Reasoning:\n") ? raw.slice("Reasoning:\n".length).trim() : raw;
      if (!body) {
        return { visibleReplySent: false };
      }
      const chunkLimit = Math.max(256, Math.min(textLimit, 2000) - 8);
      const chunks = chunkDiscordTextWithMode(body, {
        maxChars: chunkLimit,
        maxLines: maxLinesPerMessage,
        chunkMode,
      });
      const replies = (chunks.length ? chunks : [body])
        .map((chunk) => formatDiscordReasoningQuote(chunk))
        .filter((quote): quote is string => Boolean(quote))
        .map((quote) => Object.assign({}, payload, { text: quote, isReasoning: undefined }));
      if (!replies.length) {
        return { visibleReplySent: false };
      }
      await deliverDiscordReply({
        cfg,
        replies,
        target: deliverTarget,
        token,
        accountId,
        rest: deliveryRest,
        runtime,
        replyToId: replyReference.use(),
        replyToMode,
        textLimit,
        maxLinesPerMessage,
        tableMode,
        chunkMode,
        sessionKey: ctxPayload.SessionKey,
        threadBindings,
        mediaLocalRoots,
        kind: "block",
      });
      replyReference.markSent();
      return { visibleReplySent: true };
    }
    if (
      isFinal &&
      !options?.allowFallbackOnlyToolWarning &&
      isFallbackOnlyToolWarningFinal(payload)
    ) {
      if (
        !userFacingFinalDelivered &&
        (!finalReplyStartNotified || userFacingFinalDeliveryFailed)
      ) {
        pendingToolWarningFinal = { payload, info };
      }
      return { visibleReplySent: false };
    }
    if (isFinal) {
      draftPreview.markFinalReplyStarted();
    }
    const finalText =
      isFinal && typeof payload.text === "string"
        ? await resolveTranscriptBackedChannelFinalText({
            finalText: payload.text,
            resolveCandidateText: resolveCurrentTurnTranscriptFinalText,
          })
        : payload.text;
    const effectivePayload = finalText !== payload.text ? { ...payload, text: finalText } : payload;
    const [deliverablePayload] = sanitizeDiscordFrontChannelReplyPayloads([effectivePayload], {
      kind: info.kind,
    });
    if (!deliverablePayload) {
      logVerbose(
        formatDiscordReplySkip({
          kind: info.kind,
          reason: "internal-only payload",
          target: deliverTarget,
          sessionKey: ctxPayload.SessionKey,
        }),
      );
      return { visibleReplySent: false };
    }
    if (isFinal && !replyLifecycleStarted && !isRoomEvent && configuredTypingMode !== "never") {
      // Fast replies can bypass the normal resolver lifecycle. Start feedback
      // only after a deliverable final survives every suppression boundary.
      await onDiscordReplyStart();
    }
    const draftStream = draftPreview.draftStream;
    if (draftStream && draftPreview.isProgressMode && info.kind === "block") {
      const reply = resolveSendableOutboundReplyParts(deliverablePayload);
      if (!reply.hasMedia && !deliverablePayload.isError) {
        return { visibleReplySent: false };
      }
    }
    const shouldCollapseProgressDraft =
      draftStream &&
      isFinal &&
      draftPreview.isProgressMode &&
      !deliverablePayload.isError &&
      draftPreview.hasProgressDraftToCollapse;
    if (shouldCollapseProgressDraft && draftStream) {
      await draftPreview.flush();
      // The activity receipt rides on the final answer and the working draft
      // deletes after that answer lands, so busy channels keep no orphaned
      // tool log above the reply. Error finals skip both and keep the draft
      // as the visible record of the failed turn.
      progressReceiptLine = buildProgressSummaryLine();
      clearProgressDraftAfterFinalDelivery = true;
      // Fall through to the generic fresh send below for the final itself.
    }
    const shouldFinalizeDraftPreview =
      draftStream && isFinal && !draftPreview.isProgressMode && !deliverablePayload.isError;
    if (shouldFinalizeDraftPreview) {
      const ttsSupplement = getReplyPayloadTtsSupplement(deliverablePayload);

      const result = await deliverWithFinalizableLivePreviewAdapter({
        kind: info.kind,
        payload: deliverablePayload,
        adapter: defineFinalizableLivePreviewAdapter({
          draft: {
            flush: () => draftPreview.flush(),
            clear: () => draftStream.clear(),
            discardPending: () => draftStream.discardPending(),
            seal: () => draftStream.seal(),
            id: draftStream.messageId,
          },
          buildFinalEdit: (): DiscordMessageEdit | undefined => {
            // Final replies need MESSAGE_CREATE so Discord advances unread state.
            // Editing the preview only emits MESSAGE_UPDATE and can stay unnoticed.
            return undefined;
          },
          editFinal: async (previewMessageId, edit) => {
            if (isProcessAborted(abortSignal)) {
              throw new Error("process aborted");
            }
            notifyFinalReplyStart();
            await editMessageDiscord(deliverChannelId, previewMessageId, edit, {
              cfg,
              accountId,
              rest: deliveryRest,
            });
          },
          onPreviewFinalized: () => {
            markUserFacingFinalDelivered();
            draftPreview.markPreviewFinalized();
            replyReference.markSent();
          },
          logPreviewEditFailure: (err) => {
            logVerbose(
              `discord: preview final edit failed; falling back to standard send (${String(err)})`,
            );
          },
        }),
        deliverNormally: async () => {
          if (isProcessAborted(abortSignal)) {
            return false;
          }
          const fallbackPayload =
            ttsSupplement &&
            ttsSupplement.visibleTextAlreadyDelivered !== true &&
            !deliverablePayload.text?.trim()
              ? { ...deliverablePayload, text: ttsSupplement.spokenText }
              : deliverablePayload;
          // Fresh bot messages parse broadcasts by default. Preserve intended
          // user/role pings without escalating @everyone or @here.
          const allowedMentions = discordTextHasBroadcastMention(fallbackPayload.text ?? "")
            ? TARGETED_ONLY_ALLOWED_MENTIONS
            : undefined;
          const replyToId = replyReference.use();
          notifyFinalReplyStart();
          await deliverDiscordReply({
            cfg,
            replies: [fallbackPayload],
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
            allowedMentions,
            kind: info.kind,
          });
          return true;
        },
        onNormalDelivered: () => {
          markUserFacingFinalDelivered();
          replyReference.markSent();
        },
      });
      if (result.kind !== "normal-skipped") {
        return { visibleReplySent: true };
      }
    }
    if (isProcessAborted(abortSignal)) {
      // Mirror the entry-point abort log so a mid-deliver abort (after
      // the preview path bowed out) does not silently drop the reply.
      logVerbose(
        formatDiscordReplySkip({
          kind: info.kind,
          reason: "aborted before delivery",
          target: deliverTarget,
          sessionKey: ctxPayload.SessionKey,
        }),
      );
      return { visibleReplySent: false };
    }

    const replyToId = replyReference.use();
    if (isFinal) {
      notifyFinalReplyStart();
    }
    const receiptLine =
      isFinal && deliverablePayload.isError !== true ? progressReceiptLine : undefined;
    const payloadForDelivery = receiptLine
      ? {
          ...deliverablePayload,
          text: deliverablePayload.text?.trim()
            ? `${deliverablePayload.text.trimEnd()}\n${receiptLine}`
            : receiptLine,
        }
      : deliverablePayload;
    await deliverDiscordReply({
      cfg,
      replies: [payloadForDelivery],
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
      kind: info.kind,
    });
    replyReference.markSent();
    if (isFinal && deliverablePayload.isError !== true) {
      if (receiptLine) {
        progressReceiptLine = undefined;
        // Commit only after Discord accepted the receipt-bearing final. A
        // failed send leaves the same receipt available to the queued retry.
        draftPreview.markProgressDraftCollapsed();
      }
      markUserFacingFinalDelivered();
      if (clearProgressDraftAfterFinalDelivery) {
        clearProgressDraftAfterFinalDelivery = false;
        // Delete the working draft only after the final landed so a failed
        // send never erases the only visible record of the turn.
        await draftStream?.discardPending();
        await draftStream?.clear();
      }
    }
    return { visibleReplySent: true };
  };
  const onDiscordDeliveryError = (err: unknown, info: { kind: string }) => {
    if (info.kind === "final" && finalReplyStartNotified && !userFacingFinalDelivered) {
      userFacingFinalDeliveryFailed = true;
    }
    runtime.error(
      danger(
        formatDiscordReplyDeliveryFailure({
          kind: info.kind,
          err,
          target: deliverTarget,
          sessionKey: ctxPayload.SessionKey,
        }),
      ),
    );
  };
  const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(discordConfig);
  let dispatchResult: {
    queuedFinal: boolean;
    counts: Record<ReplyDispatchKind, number>;
    failedCounts?: Partial<Record<ReplyDispatchKind, number>>;
  } | null = null;
  let dispatchError = false;
  let dispatchAborted = false;
  const deliverPendingToolWarningFinalIfNeeded = async () => {
    if (!pendingToolWarningFinal || userFacingFinalDelivered || isProcessAborted(abortSignal)) {
      return undefined;
    }
    const pending = pendingToolWarningFinal;
    pendingToolWarningFinal = undefined;
    try {
      return await deliverDiscordPayload(pending.payload, pending.info, {
        allowFallbackOnlyToolWarning: true,
      });
    } catch (err) {
      dispatchError = true;
      onDiscordDeliveryError(err, pending.info);
      return { visibleReplySent: false };
    }
  };
  try {
    if (isProcessAborted(abortSignal)) {
      dispatchAborted = true;
      return;
    }
    const preparedResult = await dispatchChannelInboundTurn({
      cfg,
      channel: "discord",
      accountId: route.accountId,
      route: { agentId: route.agentId, sessionKey: persistedSessionKey },
      ctxPayload,
      afterRecord: queueInitialAckReactionAfterRecord,
      sessionInitRetry: {
        delaysMs: [250, 1_000, 2_500],
        signal: abortSignal,
        sleep: sleepWithAbort,
      },
      dispatcherOptions: {
        ...replyPipeline,
        humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
        beforeDeliver: beforeDiscordPayloadDelivery,
        onReplyStart: onDiscordReplyStart,
        onFreshSettledDelivery: deliverPendingToolWarningFinalIfNeeded,
      },
      delivery: {
        deliver: deliverDiscordPayload,
        onError: onDiscordDeliveryError,
      },
      record: turn.record,
      history: isRoomEvent
        ? undefined
        : {
            isGroup: isGuildMessage,
            historyKey: messageChannelId,
            historyMap: guildHistories,
            limit: historyLimit,
          },
      replyOptions: {
        ...(turnAdoptionLifecycle ? bindIngressLifecycleToReplyOptions(turnAdoptionLifecycle) : {}),
        abortSignal,
        skillFilter: channelConfig?.skills,
        sourceReplyDeliveryMode,
        typingKeepalive: shouldDisableCoreTypingKeepalive ? false : undefined,
        queuedDeliveryCorrelations: isRoomEvent ? [{ begin: beginDeliveryCorrelation }] : undefined,
        suppressTyping: isRoomEvent ? true : undefined,
        allowProgressCallbacksWhenSourceDeliverySuppressed:
          sourceRepliesAreToolOnly && draftPreview.draftStream && draftPreview.isProgressMode
            ? true
            : undefined,
        disableBlockStreaming: sourceRepliesAreToolOnly
          ? true
          : (draftPreview.disableBlockStreamingForDraft ??
            (typeof resolvedBlockStreamingEnabled === "boolean"
              ? !resolvedBlockStreamingEnabled
              : undefined)),
        onPartialReply:
          draftPreview.draftStream && !draftPreview.isProgressMode
            ? (payload) => draftPreview.updateFromPartial(payload.text)
            : undefined,
        onAssistantMessageStart: draftPreview.draftStream
          ? handleAssistantMessageBoundary
          : undefined,
        onReasoningEnd: draftPreview.draftStream
          ? () => {
              closePendingWindowThought();
              handleAssistantMessageBoundary();
            }
          : undefined,
        onModelSelected,
        suppressDefaultToolProgressMessages:
          (sourceRepliesAreToolOnly && statusReactionsExplicitlyEnabled) ||
          draftPreview.suppressDefaultToolProgressMessages
            ? true
            : undefined,
        allowToolLifecycleWhenProgressHidden: statusReactionsEnabled ? true : undefined,
        commentaryProgressEnabled: draftPreview.isProgressMode
          ? draftPreview.commentaryProgressEnabled
          : undefined,
        progressPreambleEnabled:
          draftPreview.draftStream && draftPreview.isProgressMode ? true : undefined,
        commentaryPayloadsEnabled: draftPreview.isProgressMode
          ? draftPreview.commentaryProgressEnabled
          : undefined,
        reasoningPayloadsEnabled: reasoningDurableEnabled,
        onVerboseProgressVisibility: (isActive) => {
          shouldYieldDraftProgress = isActive;
        },
        onNarrationUpdate: draftPreview.narrationProgressEnabled
          ? async (payload) => {
              if (isProcessAborted(abortSignal) || shouldYieldDraftProgress()) {
                return;
              }
              await draftPreview.pushNarrationProgress(payload.text);
            }
          : undefined,
        onProgressNarratorLifecycle: draftPreview.narrationProgressEnabled
          ? (lifecycle) => draftPreview.setProgressNarratorLifecycle(lifecycle)
          : undefined,
        isProgressDraftVisible: draftPreview.narrationProgressEnabled
          ? () => draftPreview.isProgressDraftVisible
          : undefined,
        narrationHideCommandText: draftPreview.narrationHideCommandText ? true : undefined,
        onReasoningStream: async (payload) => {
          if (payload?.requiresReasoningProgressOptIn === true && !reasoningWindowEnabled) {
            return;
          }
          if (payload?.text) {
            windowReasoningOpen = true;
          }
          await statusReactions.setThinking();
          await draftPreview.pushReasoningProgress(payload?.text, {
            snapshot: payload?.isReasoningSnapshot === true,
          });
        },
        streamReasoningInNonStreamModes: reasoningWindowEnabled,
        onToolStart: async (payload) => {
          if (isProcessAborted(abortSignal)) {
            return;
          }
          await maybeBindStatusReactionsToToolReaction(payload);
          await statusReactions.setTool(payload.name);
          if (payload.phase === "start") {
            closePendingWindowThought();
          }
          if (shouldYieldDraftProgress()) {
            return;
          }
          // Match the compositor: message/react/typing are not work-tool lines.
          if (payload.phase === "start" && isChannelProgressDraftWorkToolName(payload.name)) {
            progressToolCalls += 1;
          }
          await draftPreview.pushToolProgress(
            buildChannelProgressDraftLineForEntry(
              discordConfig,
              {
                event: "tool",
                itemId: payload.itemId,
                toolCallId: payload.toolCallId,
                name: payload.name,
                phase: payload.phase,
                args: payload.args,
              },
              payload.detailMode ? { detailMode: payload.detailMode } : undefined,
            ),
            { toolName: payload.name },
          );
        },
        onItemEvent: async (payload) => {
          if (isFailedProgress(payload)) {
            return false;
          }
          if (payload.kind === "preamble") {
            if (shouldYieldDraftProgress()) {
              return undefined;
            }
            return await draftPreview.pushPreambleItemEvent(payload, noteWindowCommentary);
          }
          if (shouldYieldDraftProgress()) {
            return undefined;
          }
          await draftPreview.pushToolProgress(
            buildChannelProgressDraftLineForEntry(discordConfig, {
              event: "item",
              itemId: payload.itemId,
              toolCallId: payload.toolCallId,
              itemKind: payload.kind,
              title: payload.title,
              name: payload.name,
              phase: payload.phase,
              status: payload.status,
              summary: payload.summary,
              progressText: payload.progressText,
              meta: payload.meta,
            }),
          );
        },
        onPlanUpdate: async (payload) => {
          if (payload.phase !== "update") {
            return;
          }
          await draftPreview.pushPlanProgress(payload.steps, {
            explanation: payload.explanation,
          });
        },
        onApprovalEvent: async (payload) => {
          if (payload.phase !== "requested") {
            return;
          }
          await draftPreview.pushToolProgress(
            buildChannelProgressDraftLine({
              event: "approval",
              phase: payload.phase,
              title: payload.title,
              command: payload.command,
              reason: payload.reason,
              message: payload.message,
            }),
          );
        },
        onCommandOutput: async (payload) => {
          if (isFailedProgress(payload)) {
            return false;
          }
          if (payload.phase !== "end") {
            return undefined;
          }
          if (shouldYieldDraftProgress()) {
            return undefined;
          }
          await draftPreview.pushToolProgress(
            buildChannelProgressDraftLine({
              event: "command-output",
              itemId: payload.itemId,
              toolCallId: payload.toolCallId,
              phase: payload.phase,
              title: payload.title,
              name: payload.name,
              status: payload.status,
              exitCode: payload.exitCode,
            }),
          );
          return undefined;
        },
        onPatchSummary: async (payload) => {
          if (payload.phase !== "end") {
            return;
          }
          if (shouldYieldDraftProgress()) {
            return;
          }
          await draftPreview.pushToolProgress(
            buildChannelProgressDraftLine({
              event: "patch",
              itemId: payload.itemId,
              toolCallId: payload.toolCallId,
              phase: payload.phase,
              title: payload.title,
              name: payload.name,
              added: payload.added,
              modified: payload.modified,
              deleted: payload.deleted,
              summary: payload.summary,
            }),
          );
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
    if (!preparedResult.dispatched) {
      return;
    }
    dispatchResult = preparedResult.dispatchResult;
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
    if (await completeDiscordSessionConflict(err, deliverDiscordPayload, onDiscordDeliveryError)) {
      // The visible terminal notice owns this event, so replay can commit.
      return;
    }
    throw err;
  } finally {
    endDiscordInboundEventDeliveryCorrelation();
    await draftPreview.cleanup();
    const finalDeliveryFailed = (dispatchResult?.failedCounts?.final ?? 0) > 0;
    if (statusReactionsActive) {
      if (dispatchAborted) {
        if (removeAckAfterReply) {
          void statusReactions.clear();
        } else {
          void statusReactions.restoreInitial();
        }
      } else {
        if (dispatchError || finalDeliveryFailed) {
          await statusReactions.setError();
        } else {
          await statusReactions.setDone();
        }
        if (removeAckAfterReply) {
          void (async () => {
            await sleep(
              dispatchError || finalDeliveryFailed
                ? statusReactionTiming.errorHoldMs
                : statusReactionTiming.doneHoldMs,
            );
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

  const finalDispatchResult = dispatchResult;
  if (!finalDispatchResult || !hasFinalInboundReplyDispatch(finalDispatchResult)) {
    return;
  }
  if (shouldLogVerbose()) {
    const finalCount = finalDispatchResult.counts.final;
    logVerbose(
      `discord: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
    );
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
