// Discord plugin module implements message handler.process behavior.
import path from "node:path";
import { MessageFlags } from "discord-api-types/v10";
import { resolveAckReaction, resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  createStatusReactionController,
  DEFAULT_TIMING,
  logAckFailure,
  shouldAckReaction as shouldAckReactionGate,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  dispatchChannelInboundReply,
  hasFinalInboundReplyDispatch,
  recordChannelBotPairLoopAndCheckSuppression,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createChannelMessageReplyPipeline,
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
  resolveChannelMessageSourceReplyDeliveryMode,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry,
  resolveChannelStreamingBlockEnabled,
  resolveTranscriptBackedChannelFinalText,
} from "openclaw/plugin-sdk/channel-outbound";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { resolveChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { createChannelHistoryWindow } from "openclaw/plugin-sdk/reply-history";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  isReplyPayloadNonTerminalToolErrorWarning,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  loadSessionStore,
  readLatestAssistantTextFromSessionTranscript,
  resolveAndPersistSessionFile,
  resolveSessionStoreEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { resolveDiscordAccount, resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import { createDiscordRestClient } from "../client.js";
import { beginDiscordInboundEventDeliveryCorrelation } from "../inbound-event-delivery.js";
import {
  discordTextHasBroadcastMention,
  discordTextHasTargetedMention,
  rewriteDiscordKnownMentions,
} from "../mentions.js";
import { removeReactionDiscord } from "../send.js";
import { editMessageDiscord } from "../send.messages.js";
import { resolveDiscordTargetChannelId } from "../send.shared.js";
import { resolveDiscordChannelId } from "../targets.js";
import {
  createDiscordAckReactionAdapter,
  createDiscordAckReactionContext,
  queueInitialDiscordAckReaction,
} from "./ack-reactions.js";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import { createDiscordDraftPreviewController } from "./message-handler.draft-preview.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import { resolveForwardedMediaList, resolveMediaList } from "./message-utils.js";
import { deliverDiscordReply } from "./reply-delivery.js";
import { sanitizeDiscordFrontChannelReplyPayloads } from "./reply-safety.js";
import { createDiscordReplyTypingFeedback } from "./reply-typing-feedback.js";
import {
  DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS,
  DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS,
} from "./timeouts.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

let replyRuntimePromise: Promise<typeof import("openclaw/plugin-sdk/reply-runtime")> | undefined;

async function loadReplyRuntime() {
  replyRuntimePromise ??= import("openclaw/plugin-sdk/reply-runtime");
  return await replyRuntimePromise;
}

function isProcessAborted(abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted);
}

function formatDiscordReplyDeliveryFailure(params: {
  kind: string;
  err: unknown;
  target: string;
  sessionKey?: string;
}) {
  const context = [
    `target=${params.target}`,
    params.sessionKey ? `session=${params.sessionKey}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return `discord ${params.kind} reply failed (${context}): ${String(params.err)}`;
}

function isFallbackOnlyToolWarningFinal(payload: ReplyPayload): boolean {
  if (payload.isError !== true || !isReplyPayloadNonTerminalToolErrorWarning(payload)) {
    return false;
  }
  return !resolveSendableOutboundReplyParts(payload).hasMedia;
}

type DiscordReplySkipReason =
  | "aborted before delivery"
  | "reasoning payload"
  | "internal-only payload";

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
  try {
    await processDiscordMessageInner(ctx, observer);
  } finally {
    ctx.replyTypingFeedback?.onCleanup?.();
  }
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
    mediaMaxBytes,
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
    discordRestFetch,
    abortSignal,
    botLoopProtection,
    replyTypingFeedback,
  } = ctx;
  if (isProcessAborted(abortSignal)) {
    return;
  }
  if (botLoopProtection) {
    const botLoopResult = recordChannelBotPairLoopAndCheckSuppression(botLoopProtection);
    if (botLoopResult.suppressed) {
      logVerbose(
        `discord: bot-to-bot loop detected before dispatch setup, suppressing for ${Math.max(0, Math.ceil((botLoopResult.cooldownUntilMs - Date.now()) / 1000))}s`,
      );
      return;
    }
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
  const { dispatchReplyWithBufferedBlockDispatcher } = await loadReplyRuntime();
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
  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "discord",
    accountId,
  });
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const isRoomEvent = ctx.inboundEventKind === "room_event";
  const shouldAckReaction = () =>
    Boolean(
      !isRoomEvent &&
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
  let statusReactionTarget = `${messageChannelId}/${message.id}`;
  let statusReactionsActive = statusReactionsEnabled;
  let statusReactions = createStatusReactionController({
    enabled: statusReactionsEnabled,
    adapter: discordAdapter,
    initialEmoji: ackReaction,
    emojis: cfg.messages?.statusReactions?.emojis,
    timing: cfg.messages?.statusReactions?.timing,
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
      timing: cfg.messages?.statusReactions?.timing,
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
  queueInitialDiscordAckReaction({
    enabled: statusReactionsEnabled,
    shouldSendAckReaction,
    ackReaction,
    statusReactions,
    reactionAdapter: discordAdapter,
    target: `${messageChannelId}/${message.id}`,
  });
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
  // Deliver target can move into a thread after preflight accepted the message.
  // The typing owner follows the final target before reply dispatch starts.
  const typingFeedback =
    replyTypingFeedback ??
    createDiscordReplyTypingFeedback({
      cfg,
      token,
      accountId,
      channelId: typingChannelId,
      rest: feedbackRest,
      log: logVerbose,
    });
  if (replyTypingFeedback) {
    // A carried prestart only covers queue wait time; dispatch needs a fresh
    // controller after retargeting so an expired TTL cannot silence the run.
    replyTypingFeedback.restartForDispatch(typingChannelId);
  } else {
    typingFeedback.updateChannelId(typingChannelId);
  }

  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: "discord",
    accountId: route.accountId,
    typingCallbacks: typingFeedback,
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
      const store = loadSessionStore(storePath, { clone: false });
      const sessionEntry = resolveSessionStoreEntry({ store, sessionKey }).existing;
      if (!sessionEntry?.sessionId) {
        return undefined;
      }
      const { sessionFile } = await resolveAndPersistSessionFile({
        sessionId: sessionEntry.sessionId,
        sessionKey,
        sessionStore: store,
        storePath,
        sessionEntry,
        agentId: route.agentId,
        sessionsDir: path.dirname(storePath),
      });
      const latest = await readLatestAssistantTextFromSessionTranscript(sessionFile);
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
  const finalPreviewFlags =
    (discordConfig?.suppressEmbeds ?? true) ? MessageFlags.SuppressEmbeds : undefined;
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
    if (payload.isReasoning) {
      // Reasoning/thinking payloads should not be delivered to Discord.
      logVerbose(
        formatDiscordReplySkip({
          kind: info.kind,
          reason: "reasoning payload",
          target: deliverTarget,
          sessionKey: ctxPayload.SessionKey,
        }),
      );
      return null;
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
      // Reasoning/thinking payloads should not be delivered to Discord.
      logVerbose(
        formatDiscordReplySkip({
          kind: info.kind,
          reason: "reasoning payload",
          target: deliverTarget,
          sessionKey: ctxPayload.SessionKey,
        }),
      );
      return { visibleReplySent: false };
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
    const draftStream = draftPreview.draftStream;
    if (draftStream && draftPreview.isProgressMode && info.kind === "block") {
      const reply = resolveSendableOutboundReplyParts(deliverablePayload);
      if (!reply.hasMedia && !deliverablePayload.isError) {
        return { visibleReplySent: false };
      }
    }
    const shouldFinalizeDraftPreview =
      draftStream &&
      isFinal &&
      (!draftPreview.isProgressMode || draftPreview.hasProgressDraftStarted) &&
      !deliverablePayload.isError;
    if (shouldFinalizeDraftPreview) {
      const reply = resolveSendableOutboundReplyParts(deliverablePayload);
      const hasMedia = reply.hasMedia;
      const ttsSupplement = getReplyPayloadTtsSupplement(deliverablePayload);
      const previewSourceText = deliverablePayload.text ?? ttsSupplement?.spokenText;
      const previewFinalText = draftPreview.resolvePreviewFinalText(previewSourceText);
      const previewReplyToId = replyReference.peek();
      const hasExplicitReplyDirective =
        Boolean(deliverablePayload.replyToTag || deliverablePayload.replyToCurrent) ||
        (typeof previewSourceText === "string" &&
          /\[\[\s*reply_to(?:_current|\s*:)/i.test(previewSourceText));

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
          buildFinalEdit: () => {
            if (
              draftPreview.finalizedViaPreviewMessage ||
              (hasMedia && !ttsSupplement) ||
              typeof previewFinalText !== "string" ||
              hasExplicitReplyDirective ||
              deliverablePayload.isError
            ) {
              return undefined;
            }
            // Discord pings only on create, not edits: send a targeted mention fresh, but keep mixed @everyone/@here in place so the create cannot escalate a broadcast.
            const rewrittenFinal = rewriteDiscordKnownMentions(previewFinalText, {
              accountId,
              mentionAliases: resolveDiscordAccount({ cfg, accountId }).config.mentionAliases,
            });
            if (
              discordTextHasTargetedMention(rewrittenFinal) &&
              !discordTextHasBroadcastMention(rewrittenFinal)
            ) {
              return undefined;
            }
            return {
              content: previewFinalText,
              ...(finalPreviewFlags ? { flags: finalPreviewFlags } : {}),
            };
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
          buildSupplementalPayload: () =>
            ttsSupplement ? buildTtsSupplementMediaPayload(deliverablePayload) : undefined,
          deliverSupplemental: async (supplementalPayload) => {
            if (isProcessAborted(abortSignal)) {
              return false;
            }
            const supplementalReplyToId =
              previewReplyToId ??
              replyReference.peek() ??
              (replyToMode === "all"
                ? typeof message.id === "string" && message.id
                  ? message.id
                  : ctxPayload.MessageSid
                : undefined);
            await deliverDiscordReply({
              cfg,
              replies: [supplementalPayload],
              target: deliverTarget,
              token,
              accountId,
              rest: deliveryRest,
              runtime,
              replyToId: supplementalReplyToId,
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
            return true;
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
    await deliverDiscordReply({
      cfg,
      replies: [deliverablePayload],
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
      markUserFacingFinalDelivered();
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
  const onDiscordReplyStart = async () => {
    if (isProcessAborted(abortSignal)) {
      return;
    }
    await replyPipeline.typingCallbacks?.onReplyStart();
    await statusReactions.setThinking();
  };

  const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(discordConfig);
  let dispatchResult: Awaited<ReturnType<typeof dispatchReplyWithBufferedBlockDispatcher>> | null =
    null;
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
    const preparedResult = await dispatchChannelInboundReply({
      cfg,
      channel: "discord",
      accountId: route.accountId,
      agentId: route.agentId,
      routeSessionKey: persistedSessionKey,
      storePath: turn.storePath,
      ctxPayload,
      recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher,
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
        abortSignal,
        skillFilter: channelConfig?.skills,
        sourceReplyDeliveryMode,
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
          ? () => draftPreview.handleAssistantMessageBoundary()
          : undefined,
        onReasoningEnd: draftPreview.draftStream
          ? () => draftPreview.handleAssistantMessageBoundary()
          : undefined,
        onModelSelected,
        suppressDefaultToolProgressMessages: draftPreview.suppressDefaultToolProgressMessages
          ? true
          : undefined,
        commentaryProgressEnabled: draftPreview.isProgressMode
          ? draftPreview.commentaryProgressEnabled
          : undefined,
        onReasoningStream: async (payload) => {
          await statusReactions.setThinking();
          await draftPreview.pushReasoningProgress(payload?.text, {
            snapshot: payload?.isReasoningSnapshot === true,
          });
        },
        onToolStart: async (payload) => {
          if (isProcessAborted(abortSignal)) {
            return;
          }
          await maybeBindStatusReactionsToToolReaction(payload);
          await statusReactions.setTool(payload.name);
          await draftPreview.pushToolProgress(
            buildChannelProgressDraftLineForEntry(
              discordConfig,
              {
                event: "tool",
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
          if (payload.kind === "preamble") {
            if (draftPreview.commentaryProgressEnabled && payload.progressText) {
              await draftPreview.pushCommentaryProgress(payload.progressText, {
                itemId: payload.itemId,
              });
            }
            return;
          }
          await draftPreview.pushToolProgress(
            buildChannelProgressDraftLineForEntry(discordConfig, {
              event: "item",
              itemId: payload.itemId,
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
          await draftPreview.pushToolProgress(
            buildChannelProgressDraftLine({
              event: "plan",
              phase: payload.phase,
              title: payload.title,
              explanation: payload.explanation,
              steps: payload.steps,
            }),
          );
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
          if (payload.phase !== "end") {
            return;
          }
          await draftPreview.pushToolProgress(
            buildChannelProgressDraftLine({
              event: "command-output",
              phase: payload.phase,
              title: payload.title,
              name: payload.name,
              status: payload.status,
              exitCode: payload.exitCode,
            }),
          );
        },
        onPatchSummary: async (payload) => {
          if (payload.phase !== "end") {
            return;
          }
          await draftPreview.pushToolProgress(
            buildChannelProgressDraftLine({
              event: "patch",
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
                ? DEFAULT_TIMING.errorHoldMs
                : DEFAULT_TIMING.doneHoldMs,
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
