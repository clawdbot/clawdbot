// Discord plugin module implements message handler.process behavior.
import type { APIAllowedMentions } from "discord-api-types/v10";
import { resolveAgentConfig, resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  dispatchChannelInboundTurn,
  hasFinalInboundReplyDispatch,
  readAgentRunTerminalOutcome,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  bindIngressLifecycleToReplyOptions,
  defineFinalizableLivePreviewAdapter,
  deliverWithFinalizableLivePreviewAdapter,
  resolveChannelMessageSourceReplyDeliveryMode,
  resolveTranscriptBackedChannelFinalText,
} from "openclaw/plugin-sdk/channel-outbound";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
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
  sleepWithAbort,
} from "openclaw/plugin-sdk/runtime-env";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { discordTextHasBroadcastMention } from "../mentions.js";
import { editMessageDiscord } from "../send.messages.js";
import type { DiscordMessageEdit } from "../send.types.js";
import { buildDiscordMessageProcessContext } from "./message-handler.context.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import { createDiscordMessageProgressRuntime } from "./message-handler.process-progress.js";
import { createDiscordMessageReactionRuntime } from "./message-handler.process-reactions.js";
import {
  createDiscordBeforePayloadDelivery,
  createDiscordMessageReplyRuntime,
  formatDiscordReasoningQuote,
} from "./message-handler.process-reply-runtime.js";
import { createDiscordMessageActiveThreadRoute } from "./message-handler.process-thread-route.js";
import { completeDiscordSessionConflict } from "./message-handler.retry.js";
import {
  deliverDiscordReply,
  formatDiscordReplyDeliveryFailure,
  formatDiscordReplySkip,
} from "./reply-delivery.js";
import { sanitizeDiscordFrontChannelReplyPayloads } from "./reply-safety.js";
import { resolveDiscordWebhookId } from "./sender-identity.js";

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

export { formatDiscordReplySkip } from "./reply-delivery.js";

type DiscordMessageProcessObserver = {
  onFinalReplyStart?: () => void;
  onFinalReplyDelivered?: () => void;
  onReplyPlanResolved?: (params: { createdThreadId?: string; sessionKey?: string }) => void;
};

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
    accountId,
    token,
    runtime,
    textLimit,
    replyToMode,
    message,
    messageChannelId,
    isGuildMessage,
    isDirectMessage,
    isGroupDm,
    messageText,
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
  if (!text && mediaList.length === 0) {
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
  const routedAgentConfig = resolveAgentConfig(cfg, route.agentId);
  const configuredTypingMode = routedAgentConfig?.typingMode ?? cfg.agents?.defaults?.typingMode;
  const configuredTypingInterval = cfg.agents?.defaults?.typingIntervalSeconds;
  const shouldDisableCoreTypingKeepalive =
    sourceRepliesAreToolOnly &&
    configuredTypingMode === undefined &&
    configuredTypingInterval === undefined;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const isRoomEvent = ctx.inboundEventKind === "room_event";
  const reactions = createDiscordMessageReactionRuntime({
    ctx,
    sourceRepliesAreToolOnly,
    isRoomEvent,
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
    deliverTarget: initialDeliverTarget,
    replyTarget,
    replyReference: sourceReplyReference,
  } = processContext;
  let deliverTarget = initialDeliverTarget;
  const activeThreadRoute = createDiscordMessageActiveThreadRoute({
    sessionKey: ctxPayload.SessionKey,
    accountId,
    sourceChannelId: messageChannelId,
    sourceMessageId: ctx.canonicalMessageId ?? message.id,
    sourceReplyReference,
    log: logVerbose,
  });
  const replyReference = activeThreadRoute.replyReference;
  observer?.onReplyPlanResolved?.({
    createdThreadId: replyPlan.createdThreadId,
    sessionKey: persistedSessionKey,
  });

  const replyRuntime = createDiscordMessageReplyRuntime({
    ctx,
    processContext: { ...processContext, replyReference },
    sourceRepliesAreToolOnly,
    shouldDisableCoreTypingKeepalive,
    isRoomEvent,
    dispatchStartedAt,
    feedbackRest: reactions.feedbackRest,
    deliveryRest: reactions.deliveryRest,
  });
  const {
    replyPipeline,
    onModelSelected,
    tableMode,
    maxLinesPerMessage,
    chunkMode,
    beginQueuedDeliveryCorrelation,
    endDeliveryCorrelation,
    resolveCurrentTurnTranscriptFinalText,
    deliverChannelId: initialDeliverChannelId,
    draftPreview,
    resolvedBlockStreamingEnabled,
  } = replyRuntime;
  let deliverChannelId = initialDeliverChannelId;
  activeThreadRoute.bindThreadAdoption(async (threadId) => {
    deliverTarget = `channel:${threadId}`;
    deliverChannelId = threadId;
    await draftPreview.retarget(threadId);
  });
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
  // Set when a progress draft collapses: the draft message deletes once the
  // final answer has actually delivered.
  let clearProgressDraftAfterFinalDelivery = false;
  const resetDeliveryState = () => {
    finalReplyStartNotified = false;
    userFacingFinalDelivered = false;
    userFacingFinalDeliveryFailed = false;
    pendingToolWarningFinal = undefined;
    clearProgressDraftAfterFinalDelivery = false;
  };
  const progress = createDiscordMessageProgressRuntime({
    ctx,
    sessionKey: ctxPayload.SessionKey,
    sourceRepliesAreToolOnly,
    draftPreview,
    reactions,
    onTurnReset: resetDeliveryState,
  });
  let replyLifecycleStarted = false;
  const onDiscordReplyStart = async () => {
    if (isProcessAborted(abortSignal)) {
      return;
    }
    replyLifecycleStarted = true;
    await replyPipeline.typingCallbacks?.onReplyStart();
    await reactions.controller.setThinking();
  };
  const beforeDiscordPayloadDelivery = createDiscordBeforePayloadDelivery({
    abortSignal,
    getDeliverTarget: () => deliverTarget,
    sessionKey: ctxPayload.SessionKey,
    draftPreview,
    isFallbackOnlyToolWarningFinal,
  });

  const deliverDiscordPayload = async (
    payload: ReplyPayload,
    info: {
      kind: ReplyDispatchKind;
      bindPendingFinalDelivery?: <T extends ReplyPayload>(payload: T) => T;
    },
    options?: {
      allowFallbackOnlyToolWarning?: boolean;
      allowProgressBlock?: boolean;
    },
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
      const result = await deliverDiscordReply({
        cfg,
        replies,
        target: deliverTarget,
        token,
        accountId,
        rest: reactions.deliveryRest,
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
        bindPendingFinalDelivery: info.bindPendingFinalDelivery,
      });
      if (result.visibleReplySent) {
        replyReference.markSent();
      }
      return result;
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
    if (
      draftStream &&
      draftPreview.isProgressMode &&
      info.kind === "block" &&
      !options?.allowProgressBlock
    ) {
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
      // The working draft deletes once the final answer lands, so busy channels
      // keep no orphaned tool log above the reply. Error finals skip this and
      // keep the draft as the visible record of the failed turn.
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
              rest: reactions.deliveryRest,
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
          const deliveryResult = await deliverDiscordReply({
            cfg,
            replies: [fallbackPayload],
            target: deliverTarget,
            token,
            accountId,
            rest: reactions.deliveryRest,
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
            bindPendingFinalDelivery: info.bindPendingFinalDelivery,
          });
          return deliveryResult.visibleReplySent;
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
    const result = await deliverDiscordReply({
      cfg,
      replies: [deliverablePayload],
      target: deliverTarget,
      token,
      accountId,
      rest: reactions.deliveryRest,
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
      bindPendingFinalDelivery: info.bindPendingFinalDelivery,
    });
    if (!result.visibleReplySent) {
      return result;
    }
    replyReference.markSent();
    if (isFinal && deliverablePayload.isError !== true) {
      markUserFacingFinalDelivered();
      if (clearProgressDraftAfterFinalDelivery) {
        clearProgressDraftAfterFinalDelivery = false;
        // Commit only after Discord accepted the final. A failed send leaves
        // the draft intact as the visible record for the queued retry.
        draftPreview.markProgressDraftCollapsed();
        // Delete the working draft only after the final landed so a failed
        // send never erases the only visible record of the turn.
        await draftStream?.discardPending();
        await draftStream?.clear();
      }
    }
    return result;
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
      outboundEchoSourceId: resolveDiscordWebhookId(message) ?? undefined,
      route: { agentId: route.agentId, sessionKey: persistedSessionKey },
      ctxPayload,
      afterRecord: reactions.queueInitialAckReactionAfterRecord,
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
        deliverWithProviderMessageSending: deliverDiscordPayload,
        onError: onDiscordDeliveryError,
      },
      record: turn.record,
      history: isRoomEvent
        ? undefined
        : {
            isGroup: isGuildMessage,
            historyKey: messageChannelId,
            historyMap: ctx.guildHistories,
            limit: ctx.historyLimit,
          },
      replyOptions: {
        ...(turnAdoptionLifecycle ? bindIngressLifecycleToReplyOptions(turnAdoptionLifecycle) : {}),
        abortSignal,
        skillFilter: ctx.channelConfig?.skills,
        sourceReplyDeliveryMode,
        typingKeepalive: shouldDisableCoreTypingKeepalive ? false : undefined,
        // The primary turn already owns one correlation; each queued followup
        // needs a fresh owner so its eventual delivery clears room history.
        queuedDeliveryCorrelations: isRoomEvent
          ? [{ begin: beginQueuedDeliveryCorrelation }]
          : undefined,
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
        ...progress.replyOptions,
        onModelSelected,
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
    if (activeThreadRoute.threadReplyDelivered && !userFacingFinalDelivered) {
      draftPreview.markFinalReplyStarted();
      if (draftPreview.hasProgressDraftToCollapse) {
        try {
          // The model already replied inside the thread, so a draft that cannot
          // seal leaves the thread with visible output either way.
          await draftPreview.finalizeProgressDraft();
        } catch (error) {
          logVerbose(`discord: failed to finalize adopted thread progress (${String(error)})`);
        }
      }
      markUserFacingFinalDelivered();
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
    activeThreadRoute.end();
    endDeliveryCorrelation();
    await draftPreview.cleanup();
    dispatchError ||= readAgentRunTerminalOutcome(dispatchResult) === "failed";
    const finalDeliveryFailed = (dispatchResult?.failedCounts?.final ?? 0) > 0;
    await reactions.finish({ dispatchAborted, dispatchError, finalDeliveryFailed });
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
