import type { Bot } from "grammy";
import {
  DEFAULT_TIMING,
  logAckFailure,
  logTypingFailure,
  removeAckReactionAfterReply,
} from "openclaw/plugin-sdk/channel-feedback";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import {
  createChannelProgressDraftGate,
  formatChannelProgressDraftLine,
  formatChannelProgressDraftLineForEntry,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  resolveChannelProgressDraftMaxLines,
  resolveChannelStreamingBlockEnabled,
  resolveChannelStreamingPreviewToolProgress,
} from "openclaw/plugin-sdk/channel-streaming";
import { isAbortRequestText } from "openclaw/plugin-sdk/command-primitives-runtime";
import type {
  OpenClawConfig,
  ReplyToMode,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { runInboundReplyTurn } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForDelivery,
} from "openclaw/plugin-sdk/outbound-runtime";
import { clearHistoryEntriesIfEnabled } from "openclaw/plugin-sdk/reply-history";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  createSubsystemLogger,
  danger,
  logVerbose,
  sleepWithAbort,
} from "openclaw/plugin-sdk/runtime-env";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
  resolveAgentDir,
  resolveDefaultModelForAgent,
} from "./bot-message-dispatch.agent.runtime.js";
import { pruneStickerMediaFromContext } from "./bot-message-dispatch.media.js";
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
import { getTelegramTextParts, resolveTelegramReplyId } from "./bot/helpers.js";
import {
  addTelegramNativeQuoteCandidate,
  buildTelegramNativeQuoteCandidate,
  type TelegramNativeQuoteCandidateByMessageId,
} from "./bot/native-quote.js";
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

export { pruneStickerMediaFromContext } from "./bot-message-dispatch.media.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";
const silentReplyDispatchLogger = createSubsystemLogger("telegram/silent-reply-dispatch");

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

type TelegramReplyFenceState = {
  generation: number;
  activeDispatches: number;
};

// Newer accepted turns and authorized aborts can arrive ahead of older same-session reply work.
const telegramReplyFenceByKey = new Map<string, TelegramReplyFenceState>();

function normalizeTelegramFenceKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveTelegramReplyFenceKey(params: {
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

function beginTelegramReplyFence(params: { key: string; supersede: boolean }): number {
  const existing = telegramReplyFenceByKey.get(params.key);
  const state: TelegramReplyFenceState = existing ?? {
    generation: 0,
    activeDispatches: 0,
  };
  if (params.supersede) {
    state.generation += 1;
  }
  state.activeDispatches += 1;
  telegramReplyFenceByKey.set(params.key, state);
  return state.generation;
}

function isTelegramReplyFenceSuperseded(params: { key: string; generation: number }): boolean {
  return (telegramReplyFenceByKey.get(params.key)?.generation ?? 0) !== params.generation;
}

function endTelegramReplyFence(key: string): void {
  const state = telegramReplyFenceByKey.get(key);
  if (!state) {
    return;
  }
  state.activeDispatches -= 1;
  if (state.activeDispatches <= 0) {
    telegramReplyFenceByKey.delete(key);
  }
}

function shouldSupersedeTelegramReplyFence(ctxPayload: {
  Body?: string;
  RawBody?: string;
  CommandBody?: string;
  CommandAuthorized: boolean;
}): boolean {
  const dispatchText = ctxPayload.CommandBody ?? ctxPayload.RawBody ?? ctxPayload.Body ?? "";
  return !isAbortRequestText(dispatchText) || ctxPayload.CommandAuthorized;
}

export function getTelegramReplyFenceSizeForTests(): number {
  return telegramReplyFenceByKey.size;
}

export function resetTelegramReplyFenceForTests(): void {
  telegramReplyFenceByKey.clear();
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

const MAX_PROGRESS_MARKDOWN_TEXT_CHARS = 300;

function clipProgressMarkdownText(text: string): string {
  if (text.length <= MAX_PROGRESS_MARKDOWN_TEXT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_PROGRESS_MARKDOWN_TEXT_CHARS - 1).trimEnd()}…`;
}

function sanitizeProgressMarkdownText(text: string): string {
  return text.replaceAll("`", "'");
}

function formatProgressAsMarkdownCode(text: string): string {
  const clipped = clipProgressMarkdownText(text);
  return `\`${sanitizeProgressMarkdownText(clipped)}\``;
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
  telegramDeps: injectedTelegramDeps,
  opts,
}: DispatchTelegramMessageParams) => {
  const telegramDeps =
    injectedTelegramDeps ?? (await import("./bot-deps.js")).defaultTelegramBotDeps;
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
  const statusReactionTiming = {
    ...DEFAULT_TIMING,
    ...cfg.messages?.statusReactions?.timing,
  };
  const clearTelegramStatusReaction = async () => {
    if (!msg.message_id || !reactionApi) {
      return;
    }
    await reactionApi(chatId, msg.message_id, []);
  };
  const finalizeTelegramStatusReaction = async (params: {
    outcome: "done" | "error";
    hasFinalResponse: boolean;
  }) => {
    if (!statusReactionController) {
      return;
    }
    if (params.outcome === "done") {
      await statusReactionController.setDone();
      if (removeAckAfterReply) {
        await sleepWithAbort(statusReactionTiming.doneHoldMs);
        await clearTelegramStatusReaction();
      } else {
        await statusReactionController.restoreInitial();
      }
      return;
    }
    await statusReactionController.setError();
    if (params.hasFinalResponse) {
      if (removeAckAfterReply) {
        await sleepWithAbort(statusReactionTiming.errorHoldMs);
        await clearTelegramStatusReaction();
      } else {
        await statusReactionController.restoreInitial();
      }
      return;
    }
    if (removeAckAfterReply) {
      await sleepWithAbort(statusReactionTiming.errorHoldMs);
    }
    await statusReactionController.restoreInitial();
  };
  const replyFenceKey = resolveTelegramReplyFenceKey({
    ctxPayload,
    chatId,
    threadSpec,
  });
  let replyFenceGeneration: number | undefined;
  let dispatchWasSuperseded = false;
  const isDispatchSuperseded = () =>
    replyFenceGeneration !== undefined &&
    isTelegramReplyFenceSuperseded({
      key: replyFenceKey,
      generation: replyFenceGeneration,
    });
  const releaseReplyFence = () => {
    if (replyFenceGeneration === undefined) {
      return;
    }
    endTelegramReplyFence(replyFenceKey);
    replyFenceGeneration = undefined;
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
  const rawReplyQuoteText =
    ctxPayload.ReplyToIsQuote && typeof ctxPayload.ReplyToQuoteText === "string"
      ? ctxPayload.ReplyToQuoteText
      : undefined;
  const replyQuoteText = ctxPayload.ReplyToIsQuote
    ? rawReplyQuoteText?.trim()
      ? rawReplyQuoteText
      : ctxPayload.ReplyToBody?.trim() || undefined
    : undefined;
  const replyQuoteMessageId =
    replyQuoteText && !ctxPayload.ReplyToIsExternal
      ? resolveTelegramReplyId(ctxPayload.ReplyToId)
      : undefined;
  const replyQuoteByMessageId: TelegramNativeQuoteCandidateByMessageId = {};
  if (replyToMode !== "off") {
    if (replyQuoteText && replyQuoteMessageId != null) {
      addTelegramNativeQuoteCandidate(replyQuoteByMessageId, replyQuoteMessageId, {
        text: replyQuoteText,
        ...(typeof ctxPayload.ReplyToQuotePosition === "number"
          ? { position: ctxPayload.ReplyToQuotePosition }
          : {}),
        ...(Array.isArray(ctxPayload.ReplyToQuoteEntities)
          ? { entities: ctxPayload.ReplyToQuoteEntities }
          : {}),
      });
    }

    addTelegramNativeQuoteCandidate(
      replyQuoteByMessageId,
      ctxPayload.MessageSid ?? msg.message_id,
      buildTelegramNativeQuoteCandidate(getTelegramTextParts(msg)),
    );

    if (!ctxPayload.ReplyToIsExternal && typeof ctxPayload.ReplyToQuoteSourceText === "string") {
      addTelegramNativeQuoteCandidate(
        replyQuoteByMessageId,
        ctxPayload.ReplyToId,
        buildTelegramNativeQuoteCandidate({
          text: ctxPayload.ReplyToQuoteSourceText,
          entities: Array.isArray(ctxPayload.ReplyToQuoteSourceEntities)
            ? ctxPayload.ReplyToQuoteSourceEntities
            : undefined,
        }),
      );
    }
  }
  const hasTelegramQuoteReply = replyToMode !== "off" && replyQuoteText != null;
  const canStreamAnswerDraft =
    previewStreamingEnabled &&
    !hasTelegramQuoteReply &&
    !accountBlockStreamingEnabled &&
    !forceBlockStreamingForReasoning;
  const canStreamReasoningDraft = streamReasoningDraft;
  const draftReplyToMessageId =
    replyToMode !== "off" && typeof msg.message_id === "number"
      ? (replyQuoteMessageId ?? msg.message_id)
      : undefined;
  const draftMinInitialChars = streamMode === "progress" ? 0 : DRAFT_MIN_INITIAL_CHARS;
  const progressSeed = `${route.accountId}:${chatId}:${threadSpec.id ?? ""}`;
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
                    visibleSinceMs: preview.visibleSinceMs,
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
  const previewToolProgressEnabled =
    Boolean(answerLane.stream) && resolveChannelStreamingPreviewToolProgress(telegramCfg);
  let previewToolProgressSuppressed = false;
  let previewToolProgressLines: string[] = [];
  const renderProgressDraft = async (options?: { flush?: boolean }) => {
    if (!answerLane.stream || streamMode !== "progress") {
      return;
    }
    const previewText = formatChannelProgressDraftText({
      entry: telegramCfg,
      lines: previewToolProgressLines,
      seed: progressSeed,
      formatLine: formatProgressAsMarkdownCode,
    });
    if (!previewText || previewText === answerLane.lastPartialText) {
      return;
    }
    answerLane.lastPartialText = previewText;
    answerLane.hasStreamedMessage = true;
    answerLane.stream.update(previewText);
    if (options?.flush) {
      await answerLane.stream.flush();
    }
  };
  const progressDraftGate = createChannelProgressDraftGate({
    onStart: () => renderProgressDraft({ flush: true }),
  });
  const pushPreviewToolProgress = async (line?: string, options?: { toolName?: string }) => {
    if (!answerLane.stream) {
      return;
    }
    if (options?.toolName !== undefined && !isChannelProgressDraftWorkToolName(options.toolName)) {
      return;
    }
    const normalized = sanitizeProgressMarkdownText(line?.replace(/\s+/g, " ").trim() ?? "");
    if (streamMode !== "progress") {
      if (!previewToolProgressEnabled || previewToolProgressSuppressed || !normalized) {
        return;
      }
      const previous = previewToolProgressLines.at(-1);
      if (previous === normalized) {
        return;
      }
      previewToolProgressLines = [...previewToolProgressLines, normalized].slice(
        -resolveChannelProgressDraftMaxLines(telegramCfg),
      );
      const previewText = formatChannelProgressDraftText({
        entry: telegramCfg,
        lines: previewToolProgressLines,
        seed: progressSeed,
        formatLine: formatProgressAsMarkdownCode,
      });
      answerLane.lastPartialText = previewText;
      answerLane.hasStreamedMessage = true;
      answerLane.stream.update(previewText);
      return;
    }
    if (previewToolProgressEnabled && !previewToolProgressSuppressed && normalized) {
      const previous = previewToolProgressLines.at(-1);
      if (previous !== normalized) {
        previewToolProgressLines = [...previewToolProgressLines, normalized].slice(
          -resolveChannelProgressDraftMaxLines(telegramCfg),
        );
      }
    }
    const alreadyStarted = progressDraftGate.hasStarted;
    await progressDraftGate.noteWork();
    if (alreadyStarted && progressDraftGate.hasStarted) {
      await renderProgressDraft();
    }
  };
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
          visibleSinceMs: answerLane.stream?.visibleSinceMs?.(),
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
    if (lane === answerLane) {
      if (streamMode === "progress") {
        return;
      }
      previewToolProgressSuppressed = true;
      previewToolProgressLines = [];
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

  replyFenceGeneration = beginTelegramReplyFence({
    key: replyFenceKey,
    supersede: shouldSupersedeTelegramReplyFence(ctxPayload),
  });

  const implicitQuoteReplyTargetId =
    replyQuoteMessageId != null ? String(replyQuoteMessageId) : undefined;
  const currentMessageIdForQuoteReply =
    implicitQuoteReplyTargetId && ctxPayload.MessageSid ? ctxPayload.MessageSid : undefined;
  const replyQuotePosition =
    typeof ctxPayload.ReplyToQuotePosition === "number"
      ? ctxPayload.ReplyToQuotePosition
      : undefined;
  const replyQuoteEntities = Array.isArray(ctxPayload.ReplyToQuoteEntities)
    ? ctxPayload.ReplyToQuoteEntities
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
    replyQuoteMessageId,
    replyQuoteText,
    replyQuotePosition,
    replyQuoteEntities,
    replyQuoteByMessageId,
  };
  const silentErrorReplies = telegramCfg.silentErrorReplies === true;
  const isDmTopic = !isGroup && threadSpec.scope === "dm" && threadSpec.id != null;
  let queuedFinal = false;
  let suppressSilentReplyFallback = false;
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
    const applyQuoteReplyTarget = (payload: ReplyPayload): ReplyPayload => {
      if (
        !implicitQuoteReplyTargetId ||
        !currentMessageIdForQuoteReply ||
        payload.replyToId !== currentMessageIdForQuoteReply ||
        payload.replyToTag ||
        payload.replyToCurrent
      ) {
        return payload;
      }
      return { ...payload, replyToId: implicitQuoteReplyTargetId };
    };
    let lastVisibleNonPreviewDeliveryAtMs: number | undefined;
    const sendPayload = async (payload: ReplyPayload) => {
      if (isDispatchSuperseded()) {
        return false;
      }
      const result = await (telegramDeps.deliverReplies ?? deliverReplies)({
        ...deliveryBaseOptions,
        replies: [applyQuoteReplyTarget(payload)],
        onVoiceRecording: sendRecordVoice,
        silent: silentErrorReplies && payload.isError === true,
        mediaLoader: telegramDeps.loadWebMedia,
      });
      if (result.delivered) {
        deliveryState.markDelivered();
        lastVisibleNonPreviewDeliveryAtMs = Date.now();
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
      getLastVisibleNonPreviewDeliveryAtMs: () => lastVisibleNonPreviewDeliveryAtMs,
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
      const turnResult = await runInboundReplyTurn({
        channel: "telegram",
        accountId: route.accountId,
        raw: context,
        adapter: {
          ingest: () => ({
            id: ctxPayload.MessageSid ?? `${chatId}:${Date.now()}`,
            timestamp: typeof ctxPayload.Timestamp === "number" ? ctxPayload.Timestamp : undefined,
            rawText: ctxPayload.RawBody ?? "",
            textForAgent: ctxPayload.BodyForAgent,
            textForCommands: ctxPayload.CommandBody,
            raw: context,
          }),
          resolveTurn: () => ({
            channel: "telegram",
            accountId: route.accountId,
            routeSessionKey: route.sessionKey,
            storePath: context.turn.storePath,
            ctxPayload,
            recordInboundSession: context.turn.recordInboundSession,
            record: context.turn.record,
            runDispatch: () =>
              telegramDeps.dispatchReplyWithBufferedBlockDispatcher({
                ctx: ctxPayload,
                cfg,
                dispatcherOptions: {
                  ...replyPipeline,
                  beforeDeliver: async (payload) => payload,
                  deliver: async (payload, info) => {
                    if (isDispatchSuperseded()) {
                      return;
                    }
                    const clearPendingCompactionReplayBoundaryOnVisibleBoundary = (
                      didDeliver: boolean,
                    ) => {
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
                      payload.channelData?.telegram as
                        | { buttons?: TelegramInlineButtons }
                        | undefined
                    )?.buttons;
                    const split = splitTextIntoLaneSegments(payload.text);
                    const segments = split.segments;
                    const reply = resolveSendableOutboundReplyParts(payload);
                    const _hasMedia = reply.hasMedia;

                    const flushBufferedFinalAnswer = async () => {
                      const buffered =
                        reasoningStepState.takeBufferedFinalAnswer(replyFenceGeneration);
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
                          bufferedGeneration: replyFenceGeneration,
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
                    clearPendingCompactionReplayBoundaryOnVisibleBoundary(
                      await sendPayload(payload),
                    );
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
                          previewToolProgressSuppressed = false;
                          previewToolProgressLines = [];
                          if (skipNextAnswerMessageStartRotation) {
                            skipNextAnswerMessageStartRotation = false;
                            activePreviewLifecycleByLane.answer = "transient";
                            retainPreviewOnCleanupByLane.answer = false;
                            return;
                          }
                          if (streamMode === "progress") {
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
                          previewToolProgressSuppressed = false;
                          previewToolProgressLines = [];
                        })
                    : undefined,
                  suppressDefaultToolProgressMessages:
                    !previewStreamingEnabled || Boolean(answerLane.stream),
                  onToolStart: async (payload) => {
                    const toolName = payload.name?.trim();
                    if (statusReactionController && toolName) {
                      await statusReactionController.setTool(toolName);
                    }
                    await pushPreviewToolProgress(
                      formatChannelProgressDraftLineForEntry(
                        telegramCfg,
                        {
                          event: "tool",
                          name: toolName,
                          phase: payload.phase,
                          args: payload.args,
                        },
                        payload.detailMode ? { detailMode: payload.detailMode } : undefined,
                      ),
                      { toolName },
                    );
                  },
                  onItemEvent: async (payload) => {
                    await pushPreviewToolProgress(
                      formatChannelProgressDraftLineForEntry(telegramCfg, {
                        event: "item",
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
                    await pushPreviewToolProgress(
                      formatChannelProgressDraftLine({
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
                    await pushPreviewToolProgress(
                      formatChannelProgressDraftLine({
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
                    await pushPreviewToolProgress(
                      formatChannelProgressDraftLine({
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
                    await pushPreviewToolProgress(
                      formatChannelProgressDraftLine({
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
              }),
          }),
        },
      });
      if (!turnResult.dispatched) {
        return;
      }
      ({ queuedFinal } = turnResult.dispatchResult);
      suppressSilentReplyFallback =
        turnResult.dispatchResult.sourceReplyDeliveryMode === "message_tool_only";
    } catch (err) {
      dispatchError = err;
      runtime.error?.(danger(`telegram dispatch failed: ${String(err)}`));
    } finally {
      await draftLaneEventQueue;
      progressDraftGate.cancel();
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
    releaseReplyFence();
  }
  if (dispatchWasSuperseded) {
    if (statusReactionController) {
      void finalizeTelegramStatusReaction({ outcome: "done", hasFinalResponse: true }).catch(
        (err: unknown) => {
          logVerbose(`telegram: status reaction finalize failed: ${String(err)}`);
        },
      );
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

  if (
    !sentFallback &&
    !dispatchError &&
    !deliverySummary.delivered &&
    !suppressSilentReplyFallback
  ) {
    const policySessionKey =
      ctxPayload.CommandSource === "native"
        ? (ctxPayload.CommandTargetSessionKey ?? ctxPayload.SessionKey)
        : ctxPayload.SessionKey;
    const silentReplyFallback = projectOutboundPayloadPlanForDelivery(
      createOutboundPayloadPlan([{ text: "NO_REPLY" }], {
        cfg,
        sessionKey: policySessionKey,
        surface: "telegram",
      }),
    );
    if (silentReplyFallback.length > 0) {
      const result = await (telegramDeps.deliverReplies ?? deliverReplies)({
        replies: silentReplyFallback,
        ...deliveryBaseOptions,
        silent: false,
        mediaLoader: telegramDeps.loadWebMedia,
      });
      sentFallback = result.delivered;
    }
    silentReplyDispatchLogger.debug("telegram turn ended without visible final response", {
      hasSessionKey: Boolean(policySessionKey),
      hasChatId: chatId != null,
      queuedFinal,
      sentFallback,
    });
  }

  const hasFinalResponse = deliverySummary.delivered || sentFallback || suppressSilentReplyFallback;

  if (statusReactionController && !hasFinalResponse) {
    void finalizeTelegramStatusReaction({ outcome: "error", hasFinalResponse: false }).catch(
      (err: unknown) => {
        logVerbose(`telegram: status reaction error finalize failed: ${String(err)}`);
      },
    );
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
    const statusReactionOutcome = dispatchError || sentFallback ? "error" : "done";
    void finalizeTelegramStatusReaction({
      outcome: statusReactionOutcome,
      hasFinalResponse: true,
    }).catch((err: unknown) => {
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
