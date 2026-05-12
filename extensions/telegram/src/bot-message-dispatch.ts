import path from "node:path";
import type { Bot } from "grammy";
import {
  appendSessionTranscriptMessage,
  emitSessionTranscriptUpdate,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  DEFAULT_TIMING,
  logAckFailure,
  logTypingFailure,
  removeAckReactionAfterReply,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  createChannelMessageReplyPipeline,
  deriveDurableFinalDeliveryRequirements,
} from "openclaw/plugin-sdk/channel-message";
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
} from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { runInboundReplyTurn } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForDelivery,
} from "openclaw/plugin-sdk/outbound-runtime";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
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
import { resolveTelegramConfigReasoningDefault } from "./agent-config.js";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
  resolveAgentDir,
  resolveDefaultModelForAgent,
} from "./bot-message-dispatch.agent.runtime.js";
import { deduplicateBlockSentMedia } from "./bot-message-dispatch.media-dedup.js";
import { pruneStickerMediaFromContext } from "./bot-message-dispatch.media.js";
import {
  generateTopicLabel,
  getAgentScopedMediaLocalRoots,
  loadSessionStore,
  resolveAutoTopicLabelConfig,
  resolveChunkMode,
  resolveMarkdownTableMode,
  resolveAndPersistSessionFile,
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
import { markdownToTelegramChunks, renderTelegramHtmlText } from "./format.js";
import { beginTelegramInboundTurnDeliveryCorrelation } from "./inbound-turn-delivery.js";
import {
  createLaneDeliveryStateTracker,
  createLaneTextDeliverer,
  type DraftLaneState,
  type LaneDeliveryResult,
  type LaneName,
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

type DraftPartialTextUpdate = {
  text: string;
  delta?: string;
  replace?: true;
};

function resolveDraftPartialText(
  previous: string,
  update: DraftPartialTextUpdate,
): string | undefined {
  const nextText =
    update.replace || update.delta === undefined ? update.text : `${previous}${update.delta}`;
  if (nextText === previous) {
    return undefined;
  }
  return nextText;
}

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

type TelegramTranscriptMirrorPayload = { text?: string; mediaUrls?: string[] };

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
  const configDefault = resolveTelegramConfigReasoningDefault(cfg, agentId);
  if (!sessionKey) {
    return configDefault;
  }
  try {
    const storePath = telegramDeps.resolveStorePath(cfg.session?.store, { agentId });
    const store = (telegramDeps.loadSessionStore ?? loadSessionStore)(storePath, {
      skipCache: true,
    });
    const entry = resolveSessionStoreEntry({ store, sessionKey }).existing;
    const level = entry?.reasoningLevel;
    if (level === "on" || level === "stream" || level === "off") {
      return level;
    }
  } catch {
    return "off";
  }
  return configDefault;
}

function resolveTelegramMirroredTranscriptText(
  payload: TelegramTranscriptMirrorPayload,
): string | null {
  const mediaUrls = payload.mediaUrls?.filter((url) => url.trim()) ?? [];
  if (mediaUrls.length > 0) {
    return mediaUrls
      .map((url) => {
        const pathname = url.split("#")[0]?.split("?")[0] ?? url;
        const base = path.basename(pathname);
        return base && base !== "." && base !== "/" ? base : "media";
      })
      .join(", ");
  }

  const text = payload.text?.trim();
  return text ? text : null;
}

async function mirrorTelegramAssistantReplyToTranscript(params: {
  cfg: OpenClawConfig;
  route: TelegramMessageContext["route"];
  sessionKey: string;
  telegramDeps: TelegramBotDeps;
  payload: TelegramTranscriptMirrorPayload;
}) {
  const text = resolveTelegramMirroredTranscriptText(params.payload);
  if (!text) {
    return;
  }
  const storePath = params.telegramDeps.resolveStorePath(params.cfg.session?.store, {
    agentId: params.route.agentId,
  });
  const store = (params.telegramDeps.loadSessionStore ?? loadSessionStore)(storePath, {
    skipCache: true,
  });
  const sessionEntry = resolveSessionStoreEntry({
    store,
    sessionKey: params.sessionKey,
  }).existing;
  if (!sessionEntry?.sessionId) {
    return;
  }
  const { sessionFile } = await resolveAndPersistSessionFile({
    sessionId: sessionEntry.sessionId,
    sessionKey: params.sessionKey,
    sessionStore: store,
    storePath,
    sessionEntry,
    agentId: params.route.agentId,
    sessionsDir: path.dirname(storePath),
  });
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses",
    provider: "openclaw",
    model: "delivery-mirror",
    usage: {
      input: 0,
      output: 0,
      total: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      cache: {
        read: 0,
        write: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
  const { messageId } = await appendSessionTranscriptMessage({
    transcriptPath: sessionFile,
    message,
    config: params.cfg,
  });
  emitSessionTranscriptUpdate({
    sessionFile,
    sessionKey: params.sessionKey,
    message,
    messageId,
  });
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
  const renderStreamText = (text: string) => ({
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
  const streamDeliveryEnabled = streamMode !== "off";
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
    streamDeliveryEnabled &&
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
  const createDraftLane = (laneName: LaneName, enabled: boolean): DraftLaneState => {
    const stream = enabled
      ? (telegramDeps.createTelegramDraftStream ?? createTelegramDraftStream)({
          api: bot.api,
          chatId,
          maxChars: draftMaxChars,
          thread: threadSpec,
          replyToMessageId: draftReplyToMessageId,
          minInitialChars: draftMinInitialChars,
          renderText: renderStreamText,
          onSupersededPreview: (superseded) => {
            if (superseded.retain) {
              return;
            }
            void bot.api.deleteMessage(chatId, superseded.messageId).catch((err: unknown) => {
              logVerbose(
                `telegram: superseded ${laneName} stream cleanup failed (${superseded.messageId}): ${String(err)}`,
              );
            });
          },
          log: logVerbose,
          warn: logVerbose,
        })
      : undefined;
    return {
      stream,
      lastPartialText: "",
      hasStreamedMessage: false,
      finalized: false,
    };
  };
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: createDraftLane("answer", canStreamAnswerDraft),
    reasoning: createDraftLane("reasoning", canStreamReasoningDraft),
  };
  const answerLane = lanes.answer;
  const reasoningLane = lanes.reasoning;
  const streamToolProgressEnabled =
    Boolean(answerLane.stream) && resolveChannelStreamingPreviewToolProgress(telegramCfg);
  let streamToolProgressSuppressed = false;
  let streamToolProgressLines: string[] = [];
  let lastAnswerPartialText = "";
  let activeAnswerDraftIsToolProgressOnly = false;
  function resetAnswerToolProgressDraft() {
    activeAnswerDraftIsToolProgressOnly = false;
  }
  async function prepareAnswerLaneForToolProgress() {
    if (activeAnswerDraftIsToolProgressOnly) {
      return;
    }
    if (answerLane.hasStreamedMessage) {
      await rotateLaneForNewMessage(answerLane);
    }
    activeAnswerDraftIsToolProgressOnly = true;
  }
  const renderProgressDraft = async (options?: { flush?: boolean }) => {
    if (!answerLane.stream || streamMode !== "progress") {
      return;
    }
    const streamText = formatChannelProgressDraftText({
      entry: telegramCfg,
      lines: streamToolProgressLines,
      seed: progressSeed,
      formatLine: formatProgressAsMarkdownCode,
    });
    if (!streamText || streamText === answerLane.lastPartialText) {
      return;
    }
    await prepareAnswerLaneForToolProgress();
    answerLane.lastPartialText = streamText;
    answerLane.hasStreamedMessage = true;
    answerLane.finalized = false;
    answerLane.stream.update(streamText);
    if (options?.flush) {
      await answerLane.stream.flush();
    }
  };
  const progressDraftGate = createChannelProgressDraftGate({
    onStart: () => renderProgressDraft({ flush: true }),
  });
  const pushStreamToolProgress = async (
    line?: string,
    options?: { toolName?: string; startImmediately?: boolean },
  ) => {
    if (!answerLane.stream) {
      return;
    }
    if (options?.toolName !== undefined && !isChannelProgressDraftWorkToolName(options.toolName)) {
      return;
    }
    const normalized = sanitizeProgressMarkdownText(line?.replace(/\s+/g, " ").trim() ?? "");
    if (streamMode !== "progress") {
      if (!streamToolProgressEnabled || streamToolProgressSuppressed || !normalized) {
        return;
      }
      const previous = streamToolProgressLines.at(-1);
      if (previous === normalized) {
        return;
      }
      streamToolProgressLines = [...streamToolProgressLines, normalized].slice(
        -resolveChannelProgressDraftMaxLines(telegramCfg),
      );
      const streamText = formatChannelProgressDraftText({
        entry: telegramCfg,
        lines: streamToolProgressLines,
        seed: progressSeed,
        formatLine: formatProgressAsMarkdownCode,
      });
      await prepareAnswerLaneForToolProgress();
      answerLane.lastPartialText = streamText;
      answerLane.hasStreamedMessage = true;
      answerLane.finalized = false;
      answerLane.stream.update(streamText);
      return;
    }
    if (streamToolProgressEnabled && !streamToolProgressSuppressed && normalized) {
      const previous = streamToolProgressLines.at(-1);
      if (previous !== normalized) {
        streamToolProgressLines = [...streamToolProgressLines, normalized].slice(
          -resolveChannelProgressDraftMaxLines(telegramCfg),
        );
      }
    }
    if (
      options?.startImmediately &&
      streamToolProgressEnabled &&
      !streamToolProgressSuppressed &&
      normalized
    ) {
      const alreadyStarted = progressDraftGate.hasStarted;
      await progressDraftGate.startNow();
      if (alreadyStarted && progressDraftGate.hasStarted) {
        await renderProgressDraft();
      }
      return;
    }
    const alreadyStarted = progressDraftGate.hasStarted;
    await progressDraftGate.noteWork();
    if (alreadyStarted && progressDraftGate.hasStarted) {
      await renderProgressDraft();
    }
  };
  let splitReasoningOnNextStream = false;
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
  type SplitLaneSegment = { lane: LaneName; update: DraftPartialTextUpdate };
  type SplitLaneSegmentsResult = {
    segments: SplitLaneSegment[];
    suppressedReasoningOnly: boolean;
  };
  const splitTextIntoLaneSegments = (
    update: { text?: string; delta?: string; replace?: true },
    isReasoning?: boolean,
  ): SplitLaneSegmentsResult => {
    const split = splitTelegramReasoningText(update.text, isReasoning);
    const splitSegments: Array<{ lane: LaneName; text: string }> = [];
    const useDelta = !update.replace && update.delta !== undefined;
    const segments: SplitLaneSegment[] = [];
    const suppressReasoning = resolvedReasoningLevel === "off";
    if (split.reasoningText && !suppressReasoning) {
      splitSegments.push({ lane: "reasoning", text: split.reasoningText });
    }
    if (split.answerText) {
      splitSegments.push({ lane: "answer", text: split.answerText });
    }
    for (const segment of splitSegments) {
      const canApplyDelta = useDelta && splitSegments.length === 1;
      segments.push({
        lane: segment.lane,
        update: {
          text: segment.text,
          ...(canApplyDelta ? { delta: update.delta } : {}),
          ...(update.replace ? { replace: true } : {}),
        },
      });
    }
    return {
      segments,
      suppressedReasoningOnly:
        Boolean(split.reasoningText) && suppressReasoning && !split.answerText,
    };
  };
  const resetDraftLaneState = (lane: DraftLaneState) => {
    lane.lastPartialText = "";
    if (lane === answerLane) {
      lastAnswerPartialText = "";
    }
    lane.hasStreamedMessage = false;
    lane.finalized = false;
    if (lane === answerLane) {
      resetAnswerToolProgressDraft();
    }
  };
  const rotateLaneForNewMessage = async (lane: DraftLaneState) => {
    if (!lane.hasStreamedMessage && typeof lane.stream?.messageId() !== "number") {
      resetDraftLaneState(lane);
      return;
    }
    await lane.stream?.stop();
    lane.stream?.forceNewMessage();
    resetDraftLaneState(lane);
  };
  const rotateAnswerLaneAfterToolProgress = async () => {
    if (!activeAnswerDraftIsToolProgressOnly) {
      return false;
    }
    await answerLane.stream?.stop();
    answerLane.stream?.forceNewMessage();
    resetDraftLaneState(answerLane);
    streamToolProgressSuppressed = true;
    streamToolProgressLines = [];
    return true;
  };
  const prepareAnswerLaneForText = async () => {
    if (await rotateAnswerLaneAfterToolProgress()) {
      return;
    }
    if (!answerLane.finalized) {
      return;
    }
    await rotateLaneForNewMessage(answerLane);
  };
  const updateDraftFromPartial = (lane: DraftLaneState, update: DraftPartialTextUpdate) => {
    const laneStream = lane.stream;
    if (!laneStream || !update.text) {
      return;
    }
    const previousText = lane === answerLane ? lastAnswerPartialText : lane.lastPartialText;
    const nextText = resolveDraftPartialText(previousText, update);
    if (!nextText) {
      return;
    }
    if (lane === answerLane) {
      if (streamMode === "progress") {
        return;
      }
      resetAnswerToolProgressDraft();
      streamToolProgressSuppressed = true;
      streamToolProgressLines = [];
    }
    lane.hasStreamedMessage = true;
    lane.finalized = false;
    if (lane === answerLane) {
      lastAnswerPartialText = nextText;
    }
    lane.lastPartialText = nextText;
    laneStream.update(nextText);
  };
  const ingestDraftLaneSegments = async (
    update: { text?: string; delta?: string; replace?: true },
    isReasoning?: boolean,
  ) => {
    const split = splitTextIntoLaneSegments(update, isReasoning);
    for (const segment of split.segments) {
      if (segment.lane === "answer") {
        await prepareAnswerLaneForText();
      }
      if (segment.lane === "reasoning") {
        reasoningStepState.noteReasoningHint();
        reasoningStepState.noteReasoningDelivered();
      }
      updateDraftFromPartial(lanes[segment.lane], segment.update);
    }
  };
  const flushDraftLane = async (lane: DraftLaneState) => {
    if (!lane.stream) {
      return;
    }
    await lane.stream.flush();
  };

  const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(telegramCfg);
  const disableBlockStreaming = !streamDeliveryEnabled
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
  const endTelegramInboundTurnDeliveryCorrelation = beginTelegramInboundTurnDeliveryCorrelation(
    ctxPayload.SessionKey,
    {
      outboundTo: String(chatId),
      outboundAccountId: route.accountId,
      markInboundTurnDelivered: () => deliveryState.markDelivered(),
    },
  );
  const clearGroupHistory = () => {
    if (isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: groupHistories,
        historyKey,
        limit: historyLimit,
      });
    }
  };
  const sessionKey = ctxPayload.SessionKey;
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
    transcriptMirror: sessionKey
      ? async (payload: TelegramTranscriptMirrorPayload) => {
          await mirrorTelegramAssistantReplyToTranscript({
            cfg,
            route,
            sessionKey,
            telegramDeps,
            payload,
          });
        }
      : undefined,
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
    const applyTextToFollowUpPayload = (payload: ReplyPayload, text: string): ReplyPayload => {
      const next = applyTextToPayload(payload, text);
      const {
        replyToId: _replyToId,
        replyToCurrent: _replyToCurrent,
        replyToTag: _replyToTag,
        ...followUp
      } = next;
      return followUp;
    };
    const splitFinalTextForStream = (text: string): string[] => {
      const markdownChunks =
        chunkMode === "newline"
          ? chunkMarkdownTextWithMode(text, draftMaxChars, chunkMode)
          : [text];
      return markdownChunks.flatMap((chunk) =>
        markdownToTelegramChunks(chunk, draftMaxChars, { tableMode }).map(
          (telegramChunk) => telegramChunk.text,
        ),
      );
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
    const usesNativeTelegramQuote = (payload: ReplyPayload): boolean => {
      if (replyQuoteText != null) {
        return true;
      }
      return payload.replyToId != null && replyQuoteByMessageId[payload.replyToId] != null;
    };
    const sendPayload = async (
      payload: ReplyPayload,
      options?: { durable?: boolean; silent?: boolean },
    ) => {
      if (isDispatchSuperseded()) {
        return false;
      }
      const deliverablePayload = applyQuoteReplyTarget(payload);
      const silent = options?.silent ?? (silentErrorReplies && payload.isError === true);
      const durableDelivery = telegramDeps.deliverInboundReplyWithMessageSendContext;
      if (options?.durable && durableDelivery) {
        const durable = await durableDelivery({
          cfg,
          channel: "telegram",
          to: String(chatId),
          accountId: route.accountId,
          agentId: route.agentId,
          ctxPayload,
          payload: deliverablePayload,
          info: { kind: "final" },
          replyToMode,
          threadId: threadSpec.id,
          formatting: {
            textLimit,
            tableMode,
            chunkMode,
          },
          silent,
          requiredCapabilities: deriveDurableFinalDeliveryRequirements({
            payload: deliverablePayload,
            replyToId: deliverablePayload.replyToId,
            threadId: threadSpec.id,
            silent,
            payloadTransport: true,
            extraCapabilities: {
              nativeQuote: usesNativeTelegramQuote(deliverablePayload),
            },
          }),
        });
        if (durable.status === "failed") {
          throw durable.error;
        }
        if (durable.status === "handled_visible") {
          deliveryState.markDelivered();
          return true;
        }
        if (durable.status === "handled_no_send") {
          return false;
        }
      }
      const result = await (telegramDeps.deliverReplies ?? deliverReplies)({
        ...deliveryBaseOptions,
        replies: [deliverablePayload],
        onVoiceRecording: sendRecordVoice,
        silent,
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
      if (deliveryBaseOptions.transcriptMirror && result.delivery.content) {
        void deliveryBaseOptions
          .transcriptMirror({ text: result.delivery.content })
          .catch((err: unknown) => {
            logVerbose(
              `telegram preview-finalized transcriptMirror failed: ${formatErrorMessage(err)}`,
            );
          });
      }
    };
    const deliverLaneText = createLaneTextDeliverer({
      lanes,
      draftMaxChars,
      applyTextToPayload,
      applyTextToFollowUpPayload,
      splitFinalTextForStream: splitFinalTextForStream,
      sendPayload,
      flushDraftLane,
      stopDraftLane: async (lane) => {
        await lane.stream?.stop();
      },
      clearDraftLane: async (lane) => {
        await lane.stream?.clear();
      },
      editStreamMessage: async ({ messageId, text, buttons }) => {
        if (isDispatchSuperseded()) {
          return;
        }
        await (telegramDeps.editMessageTelegram ?? editMessageTelegram)(chatId, messageId, text, {
          api: bot.api,
          cfg,
          accountId: route.accountId,
          linkPreview: telegramCfg.linkPreview,
          buttons,
        });
      },
      log: logVerbose,
      markDelivered: () => {
        deliveryState.markDelivered();
      },
    });
    const deliverProgressModeFinalAnswer = async (
      payload: ReplyPayload,
      text: string,
    ): Promise<LaneDeliveryResult> => {
      if (activeAnswerDraftIsToolProgressOnly) {
        await rotateAnswerLaneAfterToolProgress();
      } else {
        await answerLane.stream?.clear();
        resetDraftLaneState(answerLane);
      }
      const delivered = await sendPayload(applyTextToPayload(payload, text), { durable: true });
      answerLane.finalized = true;
      return delivered ? { kind: "sent" } : { kind: "skipped" };
    };

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
      telegramDeps.createChannelMessageReplyPipeline ?? createChannelMessageReplyPipeline
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
            runDispatch: () => {
              const sentBlockMediaUrls = new Set<string>();

              return telegramDeps.dispatchReplyWithBufferedBlockDispatcher({
                ctx: ctxPayload,
                cfg,
                dispatcherOptions: {
                  ...replyPipeline,
                  beforeDeliver: async (payload) => payload,
                  deliver: async (payload, info) => {
                    if (isDispatchSuperseded()) {
                      return;
                    }
                    if (payload.isError === true) {
                      hadErrorReplyFailureOrSkip = true;
                    }

                    const deduped =
                      info.kind === "final"
                        ? deduplicateBlockSentMedia(payload, sentBlockMediaUrls)
                        : payload;
                    if (deduped === undefined) {
                      return;
                    }
                    const effectivePayload = deduped;

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
                    const telegramButtons = (
                      effectivePayload.channelData?.telegram as
                        | { buttons?: TelegramInlineButtons }
                        | undefined
                    )?.buttons;
                    const split = splitTextIntoLaneSegments(
                      { text: effectivePayload.text },
                      payload.isReasoning,
                    );
                    const segments = split.segments;
                    const reply = resolveSendableOutboundReplyParts(effectivePayload);

                    const deliverFinalAnswerText = async (
                      answerPayload: ReplyPayload,
                      text: string,
                      buttons?: TelegramInlineButtons,
                    ) => {
                      if (streamMode === "progress") {
                        return deliverProgressModeFinalAnswer(answerPayload, text);
                      }
                      await rotateAnswerLaneAfterToolProgress();
                      return deliverLaneText({
                        laneName: "answer",
                        text,
                        payload: answerPayload,
                        infoKind: "final",
                        buttons,
                      });
                    };

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
                      await deliverFinalAnswerText(
                        buffered.payload,
                        buffered.text,
                        bufferedButtons,
                      );
                      reasoningStepState.resetForNextStep();
                    };

                    let blockDelivered = false;
                    for (const segment of segments) {
                      if (
                        segment.lane === "answer" &&
                        info.kind === "final" &&
                        reasoningStepState.shouldBufferFinalAnswer()
                      ) {
                        reasoningStepState.bufferFinalAnswer({
                          payload: effectivePayload,
                          text: segment.update.text,
                          bufferedGeneration: replyFenceGeneration,
                        });
                        continue;
                      }
                      if (segment.lane === "reasoning") {
                        reasoningStepState.noteReasoningHint();
                      }
                      if (segment.lane === "answer" && info.kind === "tool") {
                        await prepareAnswerLaneForToolProgress();
                      }
                      const result =
                        segment.lane === "answer" && info.kind === "final"
                          ? await deliverFinalAnswerText(
                              effectivePayload,
                              segment.update.text,
                              telegramButtons,
                            )
                          : await deliverLaneText({
                              laneName: segment.lane,
                              text: segment.update.text,
                              payload: effectivePayload,
                              infoKind: info.kind,
                              buttons: telegramButtons,
                            });
                      if (info.kind === "final") {
                        emitPreviewFinalizedHook(result);
                      }
                      blockDelivered = blockDelivered || result.kind !== "skipped";
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
                    const trackBlockMedia = (delivered: boolean) => {
                      if (delivered && info.kind === "block" && payload.mediaUrls?.length) {
                        for (const url of payload.mediaUrls) {
                          sentBlockMediaUrls.add(url);
                        }
                      }
                    };

                    if (segments.length > 0) {
                      trackBlockMedia(blockDelivered);
                      return;
                    }
                    if (split.suppressedReasoningOnly) {
                      let delivered = false;
                      if (reply.hasMedia) {
                        const payloadWithoutSuppressedReasoning =
                          typeof effectivePayload.text === "string"
                            ? { ...effectivePayload, text: "" }
                            : effectivePayload;
                        delivered = await sendPayload(payloadWithoutSuppressedReasoning, {
                          durable: info.kind === "final",
                        });
                      }
                      if (info.kind === "final") {
                        await flushBufferedFinalAnswer();
                      }
                      trackBlockMedia(delivered);
                      return;
                    }

                    if (info.kind === "final") {
                      await rotateAnswerLaneAfterToolProgress();
                      await answerLane.stream?.stop();
                      await reasoningLane.stream?.stop();
                      reasoningStepState.resetForNextStep();
                    }
                    const canSendAsIs = reply.hasMedia || reply.text.length > 0;
                    if (!canSendAsIs) {
                      if (info.kind === "final") {
                        await flushBufferedFinalAnswer();
                      }
                      return;
                    }
                    const delivered = await sendPayload(effectivePayload, {
                      durable: info.kind === "final",
                    });
                    if (info.kind === "final") {
                      await flushBufferedFinalAnswer();
                    }
                    trackBlockMedia(delivered);
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
                            await ingestDraftLaneSegments(payload);
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
                          await ingestDraftLaneSegments(payload, true);
                        })
                    : undefined,
                  onAssistantMessageStart: answerLane.stream
                    ? () =>
                        enqueueDraftLaneEvent(async () => {
                          reasoningStepState.resetForNextStep();
                          streamToolProgressSuppressed = false;
                          streamToolProgressLines = [];
                          if (answerLane.finalized) {
                            await rotateLaneForNewMessage(answerLane);
                          }
                        })
                    : undefined,
                  onReasoningEnd: reasoningLane.stream
                    ? () =>
                        enqueueDraftLaneEvent(async () => {
                          splitReasoningOnNextStream = reasoningLane.hasStreamedMessage;
                          streamToolProgressSuppressed = false;
                          streamToolProgressLines = [];
                        })
                    : undefined,
                  suppressDefaultToolProgressMessages:
                    !streamDeliveryEnabled || Boolean(answerLane.stream),
                  allowProgressCallbacksWhenSourceDeliverySuppressed: Boolean(answerLane.stream),
                  onToolStart: async (payload) => {
                    const toolName = payload.name?.trim();
                    const progressPromise = pushStreamToolProgress(
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
                      { toolName, startImmediately: true },
                    );
                    if (statusReactionController && toolName) {
                      await statusReactionController.setTool(toolName);
                    }
                    await progressPromise;
                  },
                  onItemEvent: async (payload) => {
                    await pushStreamToolProgress(
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
                    await pushStreamToolProgress(
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
                    await pushStreamToolProgress(
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
                    await pushStreamToolProgress(
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
                    await pushStreamToolProgress(
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
                  onCompactionStart: statusReactionController
                    ? async () => {
                        await statusReactionController.setCompacting();
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
              });
            },
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
      const lanesToCleanup: Array<{ laneName: LaneName; lane: DraftLaneState }> = [
        { laneName: "answer", lane: answerLane },
        { laneName: "reasoning", lane: reasoningLane },
      ];
      for (const { lane } of lanesToCleanup) {
        const stream = lane.stream;
        if (!stream) {
          continue;
        }
        if (isDispatchSuperseded()) {
          await (typeof stream.discard === "function" ? stream.discard() : stream.stop());
          continue;
        }
        if (lane.finalized) {
          await stream.stop();
        } else {
          await stream.clear();
        }
      }
    }
  } finally {
    dispatchWasSuperseded = isDispatchSuperseded();
    releaseReplyFence();
    endTelegramInboundTurnDeliveryCorrelation();
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
    !suppressSilentReplyFallback &&
    !queuedFinal &&
    isGroup
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

  const hasFinalResponse =
    deliverySummary.delivered || sentFallback || suppressSilentReplyFallback || queuedFinal;

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
