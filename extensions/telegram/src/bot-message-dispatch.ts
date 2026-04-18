import type { Bot } from "grammy";
import {
  logAckFailure,
  logTypingFailure,
  removeAckReactionAfterReply,
} from "openclaw/plugin-sdk/channel-feedback";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-streaming";
import type {
  OpenClawConfig,
  ReplyToMode,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { clearHistoryEntriesIfEnabled } from "openclaw/plugin-sdk/reply-history";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { isAbortRequestText, type ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { danger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { defaultTelegramBotDeps, type TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
  resolveAgentDir,
  resolveDefaultModelForAgent,
} from "./bot-message-dispatch.agent.runtime.js";
import {
  generateTopicLabel,
  getAgentScopedMediaLocalRoots,
  loadSessionStore,
  resolveAutoTopicLabelConfig,
  resolveChunkMode,
  resolveMarkdownTableMode,
  resolveSessionStoreEntry,
} from "./bot-message-dispatch.runtime.js";
import type { TelegramBotOptions } from "./bot.types.js";
import { deliverReplies, emitInternalMessageSentHook } from "./bot/delivery.js";
import type { TelegramStreamMode } from "./bot/types.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { createTelegramDraftStream } from "./draft-stream.js";
import {
  buildTelegramErrorScopeKey,
  isSilentErrorPolicy,
  resolveTelegramErrorPolicy,
  shouldSuppressTelegramError,
} from "./error-policy.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import { renderTelegramHtmlText } from "./format.js";
import {
  type ArchivedPreview,
  createLaneDeliveryStateTracker,
  createLaneTextDeliverer,
  type DraftLaneState,
  type LaneDeliveryResult,
  type LaneName,
  type LanePreviewLifecycle,
} from "./lane-delivery.js";
import {
  createTelegramReasoningStepState,
  splitTelegramReasoningText,
} from "./reasoning-lane-coordinator.js";
import { editMessageTelegram } from "./send.js";
import { cacheSticker, describeStickerImage } from "./sticker-cache.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

/** Minimum chars before sending first streaming message (improves push notification UX) */
const DRAFT_MIN_INITIAL_CHARS = 30;

async function resolveStickerVisionSupport(cfg: OpenClawConfig, agentId: string) {
  try {
    const catalog = await loadModelCatalog({ config: cfg });
    const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    if (!entry) {
      return false;
    }
    return modelSupportsVision(entry);
  } catch {
    return false;
  }
}

export function pruneStickerMediaFromContext(
  ctxPayload: {
    MediaPath?: string;
    MediaUrl?: string;
    MediaType?: string;
    MediaPaths?: string[];
    MediaUrls?: string[];
    MediaTypes?: string[];
  },
  opts?: { stickerMediaIncluded?: boolean },
) {
  if (opts?.stickerMediaIncluded === false) {
    return;
  }
  const nextMediaPaths = Array.isArray(ctxPayload.MediaPaths)
    ? ctxPayload.MediaPaths.slice(1)
    : undefined;
  const nextMediaUrls = Array.isArray(ctxPayload.MediaUrls)
    ? ctxPayload.MediaUrls.slice(1)
    : undefined;
  const nextMediaTypes = Array.isArray(ctxPayload.MediaTypes)
    ? ctxPayload.MediaTypes.slice(1)
    : undefined;
  ctxPayload.MediaPaths = nextMediaPaths && nextMediaPaths.length > 0 ? nextMediaPaths : undefined;
  ctxPayload.MediaUrls = nextMediaUrls && nextMediaUrls.length > 0 ? nextMediaUrls : undefined;
  ctxPayload.MediaTypes = nextMediaTypes && nextMediaTypes.length > 0 ? nextMediaTypes : undefined;
  ctxPayload.MediaPath = ctxPayload.MediaPaths?.[0];
  ctxPayload.MediaUrl = ctxPayload.MediaUrls?.[0] ?? ctxPayload.MediaPath;
  ctxPayload.MediaType = ctxPayload.MediaTypes?.[0];
}

type DispatchTelegramMessageParams = {
  context: TelegramMessageContext;
  bot: Bot;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  replyToMode: ReplyToMode;
  streamMode: TelegramStreamMode;
  textLimit: number;
  telegramCfg: TelegramAccountConfig;
  telegramDeps?: TelegramBotDeps;
  opts: Pick<TelegramBotOptions, "token">;
};

type TelegramReasoningLevel = "off" | "on" | "stream";

type TelegramAbortFenceState = {
  generation: number;
  activeDispatches: number;
};

// Abort can arrive on Telegram's control lane ahead of older same-session reply work.
const telegramAbortFenceByKey = new Map<string, TelegramAbortFenceState>();

function normalizeTelegramFenceKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveTelegramAbortFenceKey(params: {
  ctxPayload: { SessionKey?: string; CommandTargetSessionKey?: string };
  chatId: number | string;
  threadSpec: { id?: number | string | null; scope?: string };
}): string {
  return (
    normalizeTelegramFenceKey(params.ctxPayload.CommandTargetSessionKey) ??
    normalizeTelegramFenceKey(params.ctxPayload.SessionKey) ??
    `telegram:${String(params.chatId)}:${params.threadSpec.scope ?? "default"}:${params.threadSpec.id ?? "root"}`
  );
}

function beginTelegramAbortFence(params: { key: string; supersede: boolean }): number {
  const existing = telegramAbortFenceByKey.get(params.key);
  const state: TelegramAbortFenceState = existing ?? {
    generation: 0,
    activeDispatches: 0,
  };
  if (params.supersede) {
    state.generation += 1;
  }
  state.activeDispatches += 1;
  telegramAbortFenceByKey.set(params.key, state);
  return state.generation;
}

function isTelegramAbortFenceSuperseded(params: { key: string; generation: number }): boolean {
  return (telegramAbortFenceByKey.get(params.key)?.generation ?? 0) !== params.generation;
}

function endTelegramAbortFence(key: string): void {
  const state = telegramAbortFenceByKey.get(key);
  if (!state) {
    return;
  }
  state.activeDispatches -= 1;
  if (state.activeDispatches <= 0) {
    telegramAbortFenceByKey.delete(key);
  }
}

export function getTelegramAbortFenceSizeForTests(): number {
  return telegramAbortFenceByKey.size;
}

export function resetTelegramAbortFenceForTests(): void {
  telegramAbortFenceByKey.clear();
}

function resolveTelegramReasoningLevel(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId: string;
  telegramDeps: TelegramBotDeps;
}): TelegramReasoningLevel {
  const { cfg, sessionKey, agentId, telegramDeps } = params;
  if (!sessionKey) {
    return "off";
  }
  try {
    const storePath = telegramDeps.resolveStorePath(cfg.session?.store, { agentId });
    const store = (telegramDeps.loadSessionStore ?? loadSessionStore)(storePath, {
      skipCache: true,
    });
    const entry = resolveSessionStoreEntry({ store, sessionKey }).existing;
    const level = entry?.reasoningLevel;
    if (level === "on" || level === "stream") {
      return level;
    }
  } catch {
    // Fall through to default.
  }
  return "off";
}

export const dispatchTelegramMessage = async ({
  context,
  bot,
  cfg,
  runtime,
  replyToMode,
  streamMode,
  textLimit,
  telegramCfg,
  telegramDeps = defaultTelegramBotDeps,
  opts,
}: DispatchTelegramMessageParams) => {
  const {
    ctxPayload,
    msg,
    chatId,
    isGroup,
    groupConfig,
    topicConfig,
    threadSpec,
    historyKey,
    historyLimit,
    groupHistories,
    route,
    skillFilter,
    sendTyping,
    sendRecordVoice,
    ackReactionPromise,
    reactionApi,
    removeAckAfterReply,
    statusReactionController,
  } = context;
  const dispatchFenceKey = resolveTelegramAbortFenceKey({
    ctxPayload,
    chatId,
    threadSpec,
  });
  let abortFenceGeneration: number | undefined;
  let dispatchWasSuperseded = false;
  const isDispatchSuperseded = () =>
    abortFenceGeneration !== undefined &&
    isTelegramAbortFenceSuperseded({
      key: dispatchFenceKey,
      generation: abortFenceGeneration,
    });
  const releaseAbortFence = () => {
    if (abortFenceGeneration === undefined) {
      return;
    }
    endTelegramAbortFence(dispatchFenceKey);
    abortFenceGeneration = undefined;
  };
  const draftMaxChars = Math.min(textLimit, 4096);
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "telegram",
    accountId: route.accountId,
  });
  const renderDraftPreview = (text: string) => ({
    text: renderTelegramHtmlText(text, { tableMode }),
    parseMode: "HTML" as const,
  });
  const accountBlockStreamingEnabled =
    resolveChannelStreamingBlockEnabled(telegramCfg) ??
    cfg.agents?.defaults?.blockStreamingDefault === "on";
  const resolvedReasoningLevel = resolveTelegramReasoningLevel({
    cfg,
    sessionKey: ctxPayload.SessionKey,
    agentId: route.agentId,
    telegramDeps,
  });
  const forceBlockStreamingForReasoning = resolvedReasoningLevel === "on";
  const streamReasoningDraft = resolvedReasoningLevel === "stream";
  const previewStreamingEnabled = streamMode !== "off";
  const canStreamAnswerDraft =
    previewStreamingEnabled && !accountBlockStreamingEnabled && !forceBlockStreamingForReasoning;
  const canStreamReasoningDraft = streamReasoningDraft;
  const draftReplyToMessageId =
    replyToMode !== "off" && typeof msg.message_id === "number" ? msg.message_id : undefined;
  const draftMinInitialChars = DRAFT_MIN_INITIAL_CHARS;
  // DM draft previews still duplicate briefly at materialize time.
  const useMessagePreviewTransportForDm = threadSpec?.scope === "dm" && canStreamAnswerDraft;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const archivedAnswerPreviews: ArchivedPreview[] = [];
  const archivedReasoningPreviewIds: number[] = [];
  const createDraftLane = (laneName: LaneName, enabled: boolean): DraftLaneState => {
    const stream = enabled
      ? (telegramDeps.createTelegramDraftStream ?? createTelegramDraftStream)({
          api: bot.api,
          chatId,
          maxChars: draftMaxChars,
          thread: threadSpec,
          previewTransport: useMessagePreviewTransportForDm ? "message" : "auto",
          replyToMessageId: draftReplyToMessageId,
          minInitialChars: draftMinInitialChars,
          renderText: renderDraftPreview,
          onSupersededPreview:
            laneName === "answer" || laneName === "reasoning"
              ? (preview) => {
                  if (laneName === "reasoning") {
                    if (!archivedReasoningPreviewIds.includes(preview.messageId)) {
                      archivedReasoningPreviewIds.push(preview.messageId);
                    }
                    return;
                  }
                  archivedAnswerPreviews.push({
                    messageId: preview.messageId,
                    textSnapshot: preview.textSnapshot,
                    deleteIfUnused: true,
                  });
                }
              : undefined,
          log: logVerbose,
          warn: logVerbose,
        })
      : undefined;
    return {
      stream,
      lastPartialText: "",
      hasStreamedMessage: false,
    };
  };
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: createDraftLane("answer", canStreamAnswerDraft),
    reasoning: createDraftLane("reasoning", canStreamReasoningDraft),
  };
  const activePreviewLifecycleByLane: Record<LaneName, LanePreviewLifecycle> = {
    answer: "transient",
    reasoning: "transient",
  };
  const retainPreviewOnCleanupByLane: Record<LaneName, boolean> = {
    answer: false,
    reasoning: false,
  };
  const answerLane = lanes.answer;
  const reasoningLane = lanes.reasoning;
  let splitReasoningOnNextStream = false;
  let skipNextAnswerMessageStartRotation = false;
  let pendingCompactionReplayBoundary = false;
  let draftLaneEventQueue = Promise.resolve();
  const reasoningStepState = createTelegramReasoningStepState();
  const enqueueDraftLaneEvent = (task: () => Promise<void>): Promise<void> => {
    const next = draftLaneEventQueue.then(async () => {
      if (isDispatchSuperseded()) {
        return;
      }
      await task();
    });
    draftLaneEventQueue = next.catch((err) => {
      logVerbose(`telegram: draft lane callback failed: ${String(err)}`);
    });
    return draftLaneEventQueue;
  };
  type SplitLaneSegment = { lane: LaneName; text: string };
  type SplitLaneSegmentsResult = {
    segments: SplitLaneSegment[];
    suppressedReasoningOnly: boolean;
  };
  const splitTextIntoLaneSegments = (text?: string): SplitLaneSegmentsResult => {
    const split = splitTelegramReasoningText(text);
    const segments: SplitLaneSegment[] = [];
    const suppressReasoning = resolvedReasoningLevel === "off";
    if (split.reasoningText && !suppressReasoning) {
      segments.push({ lane: "reasoning", text: split.reasoningText });
    }
    if (split.answerText) {
      segments.push({ lane: "answer", text: split.answerText });
    }
    return {
      segments,
      suppressedReasoningOnly:
        Boolean(split.reasoningText) && suppressReasoning && !split.answerText,
    };
  };
  const resetDraftLaneState = (lane: DraftLaneState) => {
    lane.lastPartialText = "";
    lane.hasStreamedMessage = false;
  };
  const rotateAnswerLaneForNewAssistantMessage = async () => {
    let didForceNewMessage = false;
    if (answerLane.hasStreamedMessage) {
      const materializedId = await answerLane.stream?.materialize?.();
      const previewMessageId = materializedId ?? answerLane.stream?.messageId();
      if (
        typeof previewMessageId === "number" &&
        activePreviewLifecycleByLane.answer === "transient"
      ) {
        archivedAnswerPreviews.push({
          messageId: previewMessageId,
          textSnapshot: answerLane.lastPartialText,
          deleteIfUnused: false,
        });
      }
      answerLane.stream?.forceNewMessage();
      didForceNewMessage = true;
    }
    resetDraftLaneState(answerLane);
    if (didForceNewMessage) {
      activePreviewLifecycleByLane.answer = "transient";
      retainPreviewOnCleanupByLane.answer = false;
    }
    return didForceNewMessage;
  };
  const updateDraftFromPartial = (lane: DraftLaneState, text: string | undefined) => {
    const laneStream = lane.stream;
    if (!laneStream || !text) {
      return;
    }
    if (text === lane.lastPartialText) {
      return;
    }
    lane.hasStreamedMessage = true;
    if (
      lane.lastPartialText &&
      lane.lastPartialText.startsWith(text) &&
      text.length < lane.lastPartialText.length
    ) {
      return;
    }
    lane.lastPartialText = text;
    laneStream.update(text);
  };
  const ingestDraftLaneSegments = async (text: string | undefined) => {
    const split = splitTextIntoLaneSegments(text);
    const hasAnswerSegment = split.segments.some((segment) => segment.lane === "answer");
    if (hasAnswerSegment && activePreviewLifecycleByLane.answer !== "transient") {
      skipNextAnswerMessageStartRotation = await rotateAnswerLaneForNewAssistantMessage();
    }
    for (const segment of split.segments) {
      if (segment.lane === "reasoning") {
        reasoningStepState.noteReasoningHint();
        reasoningStepState.noteReasoningDelivered();
      }
      updateDraftFromPartial(lanes[segment.lane], segment.text);
    }
  };
  const flushDraftLane = async (lane: DraftLaneState) => {
    if (!lane.stream) {
      return;
    }
    await lane.stream.flush();
  };

  const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(telegramCfg);
  const disableBlockStreaming = !previewStreamingEnabled
    ? true
    : forceBlockStreamingForReasoning
      ? false
      : typeof resolvedBlockStreamingEnabled === "boolean"
        ? !resolvedBlockStreamingEnabled
        : canStreamAnswerDraft
          ? true
          : undefined;

  const chunkMode = resolveChunkMode(cfg, "telegram", route.accountId);
  const shouldSupersedeAbortFence =
    ctxPayload.CommandAuthorized &&
    isAbortRequestText(ctxPayload.CommandBody ?? ctxPayload.RawBody ?? ctxPayload.Body ?? "");

  abortFenceGeneration = beginTelegramAbortFence({
    key: dispatchFenceKey,
    supersede: shouldSupersedeAbortFence,
  });

  const replyQuoteText =
    ctxPayload.ReplyToIsQuote && ctxPayload.ReplyToBody
      ? ctxPayload.ReplyToBody.trim() || undefined
      : undefined;
  const deliveryState = createLaneDeliveryStateTracker();
  const clearGroupHistory = () => {
    if (isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: groupHistories,
        historyKey,
        limit: historyLimit,
      });
    }
  };
  const deliveryBaseOptions = {
    chatId: String(chatId),
    accountId: route.accountId,
    sessionKeyForInternalHooks: ctxPayload.SessionKey,
    mirrorIsGroup: isGroup,
    mirrorGroupId: isGroup ? String(chatId) : undefined,
    token: opts.token,
    runtime,
    bot,
    mediaLocalRoots,
    replyToMode,
    textLimit,
    thread: threadSpec,
    tableMode,
    chunkMode,
    linkPreview: telegramCfg.linkPreview,
    replyQuoteText,
  };
  const silentErrorReplies = telegramCfg.silentErrorReplies === true;
  const isDmTopic = !isGroup && threadSpec.scope === "dm" && threadSpec.id != null;
  let queuedFinal = false;
  let hadErrorReplyFailureOrSkip = false;
  let isFirstTurnInSession = false;
  let dispatchError: unknown;

  try {
    const sticker = ctxPayload.Sticker;
    if (sticker?.fileId && sticker.fileUniqueId && ctxPayload.MediaPath) {
      const agentDir = resolveAgentDir(cfg, route.agentId);
      const stickerSupportsVision = await resolveStickerVisionSupport(cfg, route.agentId);
      let description = sticker.cachedDescription ?? null;
      if (!description) {
        description = await describeStickerImage({
          imagePath: ctxPayload.MediaPath,
          cfg,
          agentDir,
          agentId: route.agentId,
        });
      }
      if (description) {
        const stickerContext = [sticker.emoji, sticker.setName ? `from "${sticker.setName}"` : null]
          .filter(Boolean)
          .join(" ");
        const formattedDesc = `[Sticker${stickerContext ? ` ${stickerContext}` : ""}] ${description}`;

        sticker.cachedDescription = description;
        if (!stickerSupportsVision) {
          ctxPayload.Body = formattedDesc;
          ctxPayload.BodyForAgent = formattedDesc;
          pruneStickerMediaFromContext(ctxPayload, {
            stickerMediaIncluded: ctxPayload.StickerMediaIncluded,
          });
        }
        cacheSticker({
          fileId: sticker.fileId,
          fileUniqueId: sticker.fileUniqueId,
          emoji: sticker.emoji,
          setName: sticker.setName,
          description,
          cachedAt: new Date().toISOString(),
          receivedFrom: ctxPayload.From,
        });
        logVerbose(`telegram: cached sticker description for ${sticker.fileUniqueId}`);
      }
    }

    const applyTextToPayload = (payload: ReplyPayload, text: string): ReplyPayload => {
      if (payload.text === text) {
        return payload;
      }
      return { ...payload, text };
    };
    const sendPayload = async (payload: ReplyPayload) => {
      if (isDispatchSuperseded()) {
        return false;
      }
      const result = await (telegramDeps.deliverReplies ?? deliverReplies)({
        ...deliveryBaseOptions,
        replies: [payload],
        onVoiceRecording: sendRecordVoice,
        silent: silentErrorReplies && payload.isError === true,
        mediaLoader: telegramDeps.loadWebMedia,
      });
      if (result.delivered) {
        deliveryState.markDelivered();
      }
      return result.delivered;
    };
    const emitPreviewFinalizedHook = (result: LaneDeliveryResult) => {
      if (isDispatchSuperseded() || result.kind !== "preview-finalized") {
        return;
      }
      (telegramDeps.emitInternalMessageSentHook ?? emitInternalMessageSentHook)({
        sessionKeyForInternalHooks: deliveryBaseOptions.sessionKeyForInternalHooks,
        chatId: deliveryBaseOptions.chatId,
        accountId: deliveryBaseOptions.accountId,
        content: result.delivery.content,
        success: true,
        messageId: result.delivery.messageId,
        isGroup: deliveryBaseOptions.mirrorIsGroup,
        groupId: deliveryBaseOptions.mirrorGroupId,
      });
    };
    const deliverLaneText = createLaneTextDeliverer({
      lanes,
      archivedAnswerPreviews,
      activePreviewLifecycleByLane,
      retainPreviewOnCleanupByLane,
      draftMaxChars,
      applyTextToPayload,
      sendPayload,
      flushDraftLane,
      stopDraftLane: async (lane) => {
        await lane.stream?.stop();
      },
      editPreview: async ({ messageId, text, previewButtons }) => {
        if (isDispatchSuperseded()) {
          return;
        }
        await (telegramDeps.editMessageTelegram ?? editMessageTelegram)(chatId, messageId, text, {
          api: bot.api,
          cfg,
          accountId: route.accountId,
          linkPreview: telegramCfg.linkPreview,
          buttons: previewButtons,
        });
      },
      deletePreviewMessage: async (messageId) => {
        if (isDispatchSuperseded()) {
          return;
        }
        await bot.api.deleteMessage(chatId, messageId);
      },
      log: logVerbose,
      markDelivered: () => {
        deliveryState.markDelivered();
      },
    });

    if (isDmTopic) {
      try {
        const storePath = telegramDeps.resolveStorePath(cfg.session?.store, {
          agentId: route.agentId,
        });
        const store = (telegramDeps.loadSessionStore ?? loadSessionStore)(storePath, {
          skipCache: true,
        });
        const sessionKey = ctxPayload.SessionKey;
        if (sessionKey) {
          const entry = resolveSessionStoreEntry({ store, sessionKey }).existing;
          isFirstTurnInSession = !entry?.systemSent;
        } else {
          logVerbose("auto-topic-label: SessionKey is absent, skipping first-turn detection");
        }
      } catch (err) {
        logVerbose(`auto-topic-label: session store error: ${formatErrorMessage(err)}`);
      }
    }

    if (statusReactionController) {
      void statusReactionController.setThinking();
    }

    const { onModelSelected, ...replyPipeline } = (
      telegramDeps.createChannelReplyPipeline ?? createChannelReplyPipeline
    )({
      cfg,
      agentId: route.agentId,
      channel: "telegram",
      accountId: route.accountId,
      typing: {
        start: sendTyping,
        onStartError: (err) => {
          logTypingFailure({
            log: logVerbose,
            channel: "telegram",
            target: String(chatId),
            error: err,
          });
        },
      },
    });

    try {
      ({ queuedFinal } = await telegramDeps.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          ...replyPipeline,
          deliver: async (payload, info) => {
            if (isDispatchSuperseded()) {
              return;
            }
            const clearPendingCompactionReplayBoundaryOnVisibleBoundary = (didDeliver: boolean) => {
              if (didDeliver && info.kind !== "final") {
                pendingCompactionReplayBoundary = false;
              }
            };
            if (payload.isError === true) {
              hadErrorReplyFailureOrSkip = true;
            }
            if (info.kind === "final") {
              await enqueueDraftLaneEvent(async () => {});
            }
            if (
              shouldSuppressLocalTelegramExecApprovalPrompt({
                cfg,
                accountId: route.accountId,
                payload,
              })
            ) {
              queuedFinal = true;
              return;
            }
            const previewButtons = (
              payload.channelData?.telegram as { buttons?: TelegramInlineButtons } | undefined
            )?.buttons;
            const split = splitTextIntoLaneSegments(payload.text);
            const segments = split.segments;
            const reply = resolveSendableOutboundReplyParts(payload);
            const _hasMedia = reply.hasMedia;

            const flushBufferedFinalAnswer = async () => {
              const buffered = reasoningStepState.takeBufferedFinalAnswer();
              if (!buffered) {
                return;
              }
              const bufferedButtons = (
                buffered.payload.channelData?.telegram as
                  | { buttons?: TelegramInlineButtons }
                  | undefined
              )?.buttons;
              await deliverLaneText({
                laneName: "answer",
                text: buffered.text,
                payload: buffered.payload,
                infoKind: "final",
                previewButtons: bufferedButtons,
              });
              reasoningStepState.resetForNextStep();
            };

            for (const segment of segments) {
              if (
                segment.lane === "answer" &&
                info.kind === "final" &&
                reasoningStepState.shouldBufferFinalAnswer()
              ) {
                reasoningStepState.bufferFinalAnswer({
                  payload,
                  text: segment.text,
                });
                continue;
              }
              if (segment.lane === "reasoning") {
                reasoningStepState.noteReasoningHint();
              }
              const result = await deliverLaneText({
                laneName: segment.lane,
                text: segment.text,
                payload,
                infoKind: info.kind,
                previewButtons,
                allowPreviewUpdateForNonFinal: segment.lane === "reasoning",
              });
              if (info.kind === "final") {
                emitPreviewFinalizedHook(result);
              }
              if (segment.lane === "reasoning") {
                if (result.kind !== "skipped") {
                  reasoningStepState.noteReasoningDelivered();
                  await flushBufferedFinalAnswer();
                }
                continue;
              }
              if (info.kind === "final") {
                if (reasoningLane.hasStreamedMessage) {
                  activePreviewLifecycleByLane.reasoning = "complete";
                  retainPreviewOnCleanupByLane.reasoning = true;
                }
                reasoningStepState.resetForNextStep();
              }
            }
            if (segments.length > 0) {
              if (info.kind === "final") {
                pendingCompactionReplayBoundary = false;
              }
              return;
            }
            if (split.suppressedReasoningOnly) {
              if (reply.hasMedia) {
                const payloadWithoutSuppressedReasoning =
                  typeof payload.text === "string" ? { ...payload, text: "" } : payload;
                clearPendingCompactionReplayBoundaryOnVisibleBoundary(
                  await sendPayload(payloadWithoutSuppressedReasoning),
                );
              }
              if (info.kind === "final") {
                await flushBufferedFinalAnswer();
                pendingCompactionReplayBoundary = false;
              }
              return;
            }

            if (info.kind === "final") {
              await answerLane.stream?.stop();
              await reasoningLane.stream?.stop();
              reasoningStepState.resetForNextStep();
            }
            const canSendAsIs = reply.hasMedia || reply.text.length > 0;
            if (!canSendAsIs) {
              if (info.kind === "final") {
                await flushBufferedFinalAnswer();
                pendingCompactionReplayBoundary = false;
              }
              return;
            }
            clearPendingCompactionReplayBoundaryOnVisibleBoundary(await sendPayload(payload));
            if (info.kind === "final") {
              await flushBufferedFinalAnswer();
              pendingCompactionReplayBoundary = false;
            }
          },
          onSkip: (payload, info) => {
            if (payload.isError === true) {
              hadErrorReplyFailureOrSkip = true;
            }
            if (info.reason !== "silent") {
              deliveryState.markNonSilentSkip();
            }
          },
          onError: (err, info) => {
            const errorPolicy = resolveTelegramErrorPolicy({
              accountConfig: telegramCfg,
              groupConfig,
              topicConfig,
            });
            if (isSilentErrorPolicy(errorPolicy.policy)) {
              return;
            }
            if (
              errorPolicy.policy === "once" &&
              shouldSuppressTelegramError({
                scopeKey: buildTelegramErrorScopeKey({
                  accountId: route.accountId,
                  chatId,
                  threadId: threadSpec.id,
                }),
                cooldownMs: errorPolicy.cooldownMs,
                errorMessage: String(err),
              })
            ) {
              return;
            }
            deliveryState.markNonSilentFailure();
            runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
          },
        },
        replyOptions: {
          skillFilter,
          disableBlockStreaming,
          onPartialReply:
            answerLane.stream || reasoningLane.stream
              ? (payload) =>
                  enqueueDraftLaneEvent(async () => {
                    await ingestDraftLaneSegments(payload.text);
                  })
              : undefined,
          onReasoningStream: reasoningLane.stream
            ? (payload) =>
                enqueueDraftLaneEvent(async () => {
                  if (splitReasoningOnNextStream) {
                    reasoningLane.stream?.forceNewMessage();
                    resetDraftLaneState(reasoningLane);
                    splitReasoningOnNextStream = false;
                  }
                  await ingestDraftLaneSegments(payload.text);
                })
            : undefined,
          onAssistantMessageStart: answerLane.stream
            ? () =>
                enqueueDraftLaneEvent(async () => {
                  reasoningStepState.resetForNextStep();
                  if (skipNextAnswerMessageStartRotation) {
                    skipNextAnswerMessageStartRotation = false;
                    activePreviewLifecycleByLane.answer = "transient";
                    retainPreviewOnCleanupByLane.answer = false;
                    return;
                  }
                  if (pendingCompactionReplayBoundary) {
                    pendingCompactionReplayBoundary = false;
                    activePreviewLifecycleByLane.answer = "transient";
                    retainPreviewOnCleanupByLane.answer = false;
                    return;
                  }
                  await rotateAnswerLaneForNewAssistantMessage();
                  activePreviewLifecycleByLane.answer = "transient";
                  retainPreviewOnCleanupByLane.answer = false;
                })
            : undefined,
          onReasoningEnd: reasoningLane.stream
            ? () =>
                enqueueDraftLaneEvent(async () => {
                  splitReasoningOnNextStream = reasoningLane.hasStreamedMessage;
                })
            : undefined,
          onToolStart: statusReactionController
            ? async (payload) => {
                const toolName = payload.name?.trim();
                if (toolName) {
                  await statusReactionController.setTool(toolName);
                }
              }
            : undefined,
          onCompactionStart:
            statusReactionController || answerLane.stream
              ? async () => {
                  if (
                    answerLane.hasStreamedMessage &&
                    activePreviewLifecycleByLane.answer === "transient"
                  ) {
                    pendingCompactionReplayBoundary = true;
                  }
                  if (statusReactionController) {
                    await statusReactionController.setCompacting();
                  }
                }
              : undefined,
          onCompactionEnd: statusReactionController
            ? async () => {
                statusReactionController.cancelPending();
                await statusReactionController.setThinking();
              }
            : undefined,
          onModelSelected,
        },
      }));
    } catch (err) {
      dispatchError = err;
      runtime.error?.(danger(`telegram dispatch failed: ${String(err)}`));
    } finally {
      await draftLaneEventQueue;
      if (isDispatchSuperseded()) {
        if (answerLane.hasStreamedMessage || typeof answerLane.stream?.messageId() === "number") {
          retainPreviewOnCleanupByLane.answer = true;
        }
        for (const archivedPreview of archivedAnswerPreviews) {
          archivedPreview.deleteIfUnused = false;
        }
      }
      const streamCleanupStates = new Map<
        NonNullable<DraftLaneState["stream"]>,
        { shouldClear: boolean }
      >();
      const lanesToCleanup: Array<{ laneName: LaneName; lane: DraftLaneState }> = [
        { laneName: "answer", lane: answerLane },
        { laneName: "reasoning", lane: reasoningLane },
      ];
      for (const laneState of lanesToCleanup) {
        const stream = laneState.lane.stream;
        if (!stream) {
          continue;
        }
        const activePreviewMessageId = stream.messageId();
        const hasBoundaryFinalizedActivePreview =
          laneState.laneName === "answer" &&
          typeof activePreviewMessageId === "number" &&
          archivedAnswerPreviews.some(
            (p) => p.deleteIfUnused === false && p.messageId === activePreviewMessageId,
          );
        const shouldClear =
          !retainPreviewOnCleanupByLane[laneState.laneName] && !hasBoundaryFinalizedActivePreview;
        const existing = streamCleanupStates.get(stream);
        if (!existing) {
          streamCleanupStates.set(stream, { shouldClear });
          continue;
        }
        existing.shouldClear = existing.shouldClear && shouldClear;
      }
      for (const [stream, cleanupState] of streamCleanupStates) {
        if (isDispatchSuperseded()) {
          await (typeof stream.discard === "function" ? stream.discard() : stream.stop());
          continue;
        }
        await stream.stop();
        if (cleanupState.shouldClear) {
          await stream.clear();
        }
      }
      if (!isDispatchSuperseded()) {
        for (const archivedPreview of archivedAnswerPreviews) {
          if (archivedPreview.deleteIfUnused === false) {
            continue;
          }
          try {
            await bot.api.deleteMessage(chatId, archivedPreview.messageId);
          } catch (err) {
            logVerbose(
              `telegram: archived answer preview cleanup failed (${archivedPreview.messageId}): ${String(err)}`,
            );
          }
        }
        for (const messageId of archivedReasoningPreviewIds) {
          try {
            await bot.api.deleteMessage(chatId, messageId);
          } catch (err) {
            logVerbose(
              `telegram: archived reasoning preview cleanup failed (${messageId}): ${String(err)}`,
            );
          }
        }
      }
    }
  } finally {
    dispatchWasSuperseded = isDispatchSuperseded();
    releaseAbortFence();
  }
  if (dispatchWasSuperseded) {
    if (statusReactionController) {
      void Promise.resolve(statusReactionController.setDone()).catch((err: unknown) => {
        logVerbose(`telegram: status reaction finalize failed: ${String(err)}`);
      });
    } else {
      removeAckReactionAfterReply({
        removeAfterReply: removeAckAfterReply,
        ackReactionPromise,
        ackReactionValue: ackReactionPromise ? "ack" : null,
        remove: () =>
          (reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve()).then(() => {}),
        onError: (err) => {
          if (!msg.message_id) {
            return;
          }
          logAckFailure({
            log: logVerbose,
            channel: "telegram",
            target: `${chatId}/${msg.message_id}`,
            error: err,
          });
        },
      });
    }
    clearGroupHistory();
    return;
  }
  let sentFallback = false;
  const deliverySummary = deliveryState.snapshot();
  if (
    dispatchError ||
    (!deliverySummary.delivered &&
      (deliverySummary.skippedNonSilent > 0 || deliverySummary.failedNonSilent > 0))
  ) {
    const fallbackText = dispatchError
      ? "Something went wrong while processing your request. Please try again."
      : EMPTY_RESPONSE_FALLBACK;
    const result = await (telegramDeps.deliverReplies ?? deliverReplies)({
      replies: [{ text: fallbackText }],
      ...deliveryBaseOptions,
      silent: silentErrorReplies && (dispatchError != null || hadErrorReplyFailureOrSkip),
      mediaLoader: telegramDeps.loadWebMedia,
    });
    sentFallback = result.delivered;
  }

  const hasFinalResponse = queuedFinal || sentFallback;

  if (statusReactionController && !hasFinalResponse) {
    void Promise.resolve(statusReactionController.setError()).catch((err: unknown) => {
      logVerbose(`telegram: status reaction error finalize failed: ${String(err)}`);
    });
  }

  if (!hasFinalResponse) {
    clearGroupHistory();
    return;
  }

  // Fire-and-forget: auto-rename DM topic on first message.
  if (isDmTopic && isFirstTurnInSession) {
    const userMessage = (ctxPayload.RawBody ?? ctxPayload.Body ?? "").slice(0, 500);
    if (userMessage.trim()) {
      const agentDir = resolveAgentDir(cfg, route.agentId);
      const directAutoTopicLabel =
        !isGroup && groupConfig && "autoTopicLabel" in groupConfig
          ? groupConfig.autoTopicLabel
          : undefined;
      const accountAutoTopicLabel = telegramCfg?.autoTopicLabel;
      const autoTopicConfig = resolveAutoTopicLabelConfig(
        directAutoTopicLabel,
        accountAutoTopicLabel,
      );
      if (autoTopicConfig) {
        const topicThreadId = threadSpec.id!;
        void (async () => {
          try {
            const label = await generateTopicLabel({
              userMessage,
              prompt: autoTopicConfig.prompt,
              cfg,
              agentId: route.agentId,
              agentDir,
            });
            if (!label) {
              logVerbose("auto-topic-label: LLM returned empty label");
              return;
            }
            logVerbose(`auto-topic-label: generated label (len=${label.length})`);
            await bot.api.editForumTopic(chatId, topicThreadId, { name: label });
            logVerbose(`auto-topic-label: renamed topic ${chatId}/${topicThreadId}`);
          } catch (err) {
            logVerbose(`auto-topic-label: failed: ${formatErrorMessage(err)}`);
          }
        })();
      }
    }
  }

  if (statusReactionController) {
    void Promise.resolve(statusReactionController.setDone()).catch((err: unknown) => {
      logVerbose(`telegram: status reaction finalize failed: ${String(err)}`);
    });
  } else {
    removeAckReactionAfterReply({
      removeAfterReply: removeAckAfterReply,
      ackReactionPromise,
      ackReactionValue: ackReactionPromise ? "ack" : null,
      remove: () =>
        (reactionApi?.(chatId, msg.message_id ?? 0, []) ?? Promise.resolve()).then(() => {}),
      onError: (err) => {
        if (!msg.message_id) {
          return;
        }
        logAckFailure({
          log: logVerbose,
          channel: "telegram",
          target: `${chatId}/${msg.message_id}`,
          error: err,
        });
      },
    });
  }
  clearGroupHistory();
};
