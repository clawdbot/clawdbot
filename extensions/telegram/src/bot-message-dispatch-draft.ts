// Telegram plugin module owns answer/reasoning draft lanes and rotation state.
import type { Bot } from "grammy";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-outbound";
import type {
  OpenClawConfig,
  ReplyToMode,
  TelegramAccountConfig,
} from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { BlockReplyContext } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramBotDeps } from "./bot-deps.js";
import { resolveMarkdownTableMode } from "./bot-message-dispatch.runtime.js";
import type {
  TelegramReasoningLevel,
  TelegramAnswerBlockDelivery,
} from "./bot-message-dispatch.types.js";
import type { TelegramThreadSpec } from "./bot/helpers.js";
import type { TelegramStreamMode } from "./bot/types.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";
import { createTelegramDraftStream, type TelegramDraftPreview } from "./draft-stream.js";
import { renderTelegramHtmlText } from "./format.js";
import type { DraftLaneState, LaneName } from "./lane-delivery.js";
import { TELEGRAM_TEXT_CHUNK_LIMIT } from "./outbound-adapter.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import { splitTelegramReasoningText } from "./reasoning-lane-coordinator.js";
import { buildTelegramRichMarkdown, TELEGRAM_RICH_TEXT_LIMIT } from "./rich-message.js";

const DRAFT_MIN_INITIAL_CHARS = 30;

type DraftPartialTextUpdate = {
  text: string;
  delta?: string;
  replace?: true;
  isReasoningSnapshot?: boolean;
};

type SplitLaneSegment = { lane: LaneName; update: DraftPartialTextUpdate };
type SplitLaneSegmentsResult = {
  segments: SplitLaneSegment[];
  suppressedReasoningOnly: boolean;
};

type QueuedAnswerBlockRotation = {
  assistantMessageIndex?: number;
  text?: string;
  shouldRotateBeforeDelivery: boolean;
};

function resolveDraftPartialText(
  previous: string,
  update: DraftPartialTextUpdate,
): string | undefined {
  const nextText =
    update.replace || update.isReasoningSnapshot || update.delta === undefined
      ? update.text
      : `${previous}${update.delta}`;
  return nextText === previous ? undefined : nextText;
}

export function createTelegramDraftController(params: {
  accountId: string;
  bot: Bot;
  cfg: OpenClawConfig;
  chatId: number;
  draftReplyToMessageId?: number;
  forceBlockStreamingForReasoning: boolean;
  hasTelegramQuoteReply: boolean;
  isDispatchSuperseded: () => boolean;
  isRoomEvent: boolean;
  replyToMode: ReplyToMode;
  resolvedReasoningLevel: TelegramReasoningLevel;
  streamMode: TelegramStreamMode;
  tableMode: ReturnType<typeof resolveMarkdownTableMode>;
  telegramCfg: TelegramAccountConfig;
  telegramDeps: TelegramBotDeps;
  textLimit: number;
  threadSpec: TelegramThreadSpec;
}) {
  const streamDeliveryEnabled = !params.isRoomEvent && params.streamMode !== "off";
  const accountBlockStreamingEnabled =
    resolveChannelStreamingBlockEnabled(params.telegramCfg) ??
    params.cfg.agents?.defaults?.blockStreamingDefault === "on";
  const canStreamAnswerDraft =
    streamDeliveryEnabled &&
    !params.hasTelegramQuoteReply &&
    !accountBlockStreamingEnabled &&
    !params.forceBlockStreamingForReasoning;
  const streamReasoningDraft = params.resolvedReasoningLevel === "stream";
  const streamReasoningInProgressDraft =
    streamReasoningDraft && params.streamMode === "progress" && canStreamAnswerDraft;
  const canStreamReasoningDraft =
    !params.isRoomEvent && streamReasoningDraft && !streamReasoningInProgressDraft;
  const draftMaxChars =
    params.streamMode === "block"
      ? Math.min(
          resolveTelegramDraftStreamingChunking(params.cfg, params.accountId).maxChars,
          params.textLimit,
        )
      : Math.min(
          params.textLimit,
          params.telegramCfg.richMessages === true
            ? TELEGRAM_RICH_TEXT_LIMIT
            : TELEGRAM_TEXT_CHUNK_LIMIT,
        );
  const renderStreamText = (text: string): TelegramDraftPreview =>
    params.telegramCfg.richMessages === true
      ? {
          text,
          richMessage: buildTelegramRichMarkdown(text, {
            tableMode: params.tableMode,
            skipEntityDetection: params.telegramCfg.linkPreview === false,
          }),
        }
      : {
          text: renderTelegramHtmlText(text, { tableMode: params.tableMode }),
          parseMode: "HTML",
          markdownSource: { text, tableMode: params.tableMode },
        };

  const createDraftLane = (laneName: LaneName, enabled: boolean): DraftLaneState => {
    const stream = enabled
      ? (params.telegramDeps.createTelegramDraftStream ?? createTelegramDraftStream)({
          api: params.bot.api,
          chatId: params.chatId,
          maxChars: draftMaxChars,
          thread: params.threadSpec,
          replyToMessageId: params.draftReplyToMessageId,
          replyToMode: params.replyToMode,
          richMessages: params.telegramCfg.richMessages,
          linkPreview: params.telegramCfg.linkPreview,
          minInitialChars: params.streamMode === "progress" ? 0 : DRAFT_MIN_INITIAL_CHARS,
          renderText: renderStreamText,
          onRetainedPage: (page) => {
            lanes[laneName].retainedPromptContextPages.push({
              messageId: page.messageId,
              text: page.textSnapshot,
            });
          },
          onProviderMessage: async (message) => {
            await (
              params.telegramDeps.recordOutboundMessageForPromptContext ??
              recordOutboundMessageForPromptContext
            )({
              cfg: params.cfg,
              account: {
                accountId: params.accountId,
                ...(params.telegramCfg.name !== undefined ? { name: params.telegramCfg.name } : {}),
              },
              chatId: params.chatId,
              message,
              messageId: message.message_id,
              ...(params.threadSpec.id !== undefined
                ? { messageThreadId: params.threadSpec.id }
                : {}),
              successfulSendThread: params.threadSpec,
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
      retainedPromptContextPages: [],
    };
  };
  const lanes: Record<LaneName, DraftLaneState> = {
    answer: createDraftLane("answer", canStreamAnswerDraft),
    reasoning: createDraftLane("reasoning", canStreamReasoningDraft),
  };
  const answerLane = lanes.answer;
  const reasoningLane = lanes.reasoning;
  let lastAnswerPartialText = "";
  let activeAnswerDraftIsToolProgressOnly = false;
  let activeAnswerBlockAssistantMessageIndex: number | undefined;
  let activeAnswerBlockDelivery: TelegramAnswerBlockDelivery | undefined;
  let materializeAnswerLaneBeforeRotation: (() => Promise<void>) | undefined;
  const queuedAnswerBlockRotations: QueuedAnswerBlockRotation[] = [];
  let queuedAnswerBlockAssistantMessageIndex: number | undefined;
  let pendingAnswerBlockAssistantMessageIndex: number | undefined;
  let rotateAnswerLaneWhenQueuedBlocksSettle = false;
  let eventQueue = Promise.resolve();
  let resetProgress = () => {};
  let suppressProgress = () => {};
  let noteReasoningHint = () => {};
  let noteReasoningDelivered = () => {};

  const resetAnswerToolProgressDraft = () => {
    activeAnswerDraftIsToolProgressOnly = false;
  };
  const resetLaneState = (lane: DraftLaneState) => {
    lane.lastPartialText = "";
    if (lane === answerLane) {
      lastAnswerPartialText = "";
    }
    lane.hasStreamedMessage = false;
    lane.finalized = false;
    lane.retainedPromptContextPages = [];
    if (lane === answerLane) {
      resetAnswerToolProgressDraft();
      pendingAnswerBlockAssistantMessageIndex = undefined;
      activeAnswerBlockDelivery = undefined;
    }
  };
  const repositionLaneForNewMessage = (lane: DraftLaneState) => {
    // Reposition instead of delete-then-repost: the replacement must land
    // before deferred cleanup or Telegram can jump and retain a stale preview.
    lane.stream?.rotateToNewMessageDeferringDelete();
    resetLaneState(lane);
  };
  const rotateLaneForNewMessage = async (lane: DraftLaneState) => {
    if (!lane.hasStreamedMessage && typeof lane.stream?.messageId() !== "number") {
      resetLaneState(lane);
      return;
    }
    await lane.stream?.stop();
    lane.stream?.forceNewMessage();
    resetLaneState(lane);
  };
  const rotateAnswerLaneForNewMessage = async () => {
    await materializeAnswerLaneBeforeRotation?.();
    await rotateLaneForNewMessage(answerLane);
  };
  const rotateAnswerLaneAfterToolProgress = async () => {
    if (!activeAnswerDraftIsToolProgressOnly) {
      return false;
    }
    repositionLaneForNewMessage(answerLane);
    suppressProgress();
    rotateAnswerLaneWhenQueuedBlocksSettle = false;
    return true;
  };
  const rotateAnswerLaneAfterQueuedBlocksSettle = async () => {
    if (!rotateAnswerLaneWhenQueuedBlocksSettle || queuedAnswerBlockRotations.length > 0) {
      return false;
    }
    rotateAnswerLaneWhenQueuedBlocksSettle = false;
    if (!answerLane.hasStreamedMessage || activeAnswerDraftIsToolProgressOnly) {
      return false;
    }
    await rotateAnswerLaneForNewMessage();
    return true;
  };
  const prepareAnswerLaneForText = async (): Promise<boolean> => {
    // Progress mode owns one stationary activity window; answer text never rotates it.
    if (params.streamMode === "progress") {
      return false;
    }
    if (await rotateAnswerLaneAfterToolProgress()) {
      return true;
    }
    if (await rotateAnswerLaneAfterQueuedBlocksSettle()) {
      return true;
    }
    if (!answerLane.finalized) {
      return false;
    }
    answerLane.stream?.forceNewMessage();
    resetLaneState(answerLane);
    rotateAnswerLaneWhenQueuedBlocksSettle = false;
    return true;
  };
  const prepareAnswerLaneForToolProgress = async () => {
    if (answerLane.finalized) {
      answerLane.stream?.forceNewMessage();
      resetLaneState(answerLane);
    }
    if (activeAnswerDraftIsToolProgressOnly) {
      return;
    }
    if (params.streamMode !== "progress" && answerLane.hasStreamedMessage) {
      await rotateAnswerLaneForNewMessage();
    }
    activeAnswerDraftIsToolProgressOnly = true;
  };

  const splitTextIntoLaneSegments = (
    update: { text?: string; delta?: string; replace?: true; isReasoningSnapshot?: boolean },
    isReasoning?: boolean,
  ): SplitLaneSegmentsResult => {
    const split = splitTelegramReasoningText(update.text, isReasoning);
    const splitSegments: Array<{ lane: LaneName; text: string }> = [];
    const useDelta =
      !update.replace && update.isReasoningSnapshot !== true && update.delta !== undefined;
    const suppressReasoning = params.resolvedReasoningLevel === "off";
    if (split.reasoningText && !suppressReasoning) {
      splitSegments.push({ lane: "reasoning", text: split.reasoningText });
    }
    if (split.answerText) {
      splitSegments.push({ lane: "answer", text: split.answerText });
    }
    return {
      segments: splitSegments.map((segment) => ({
        lane: segment.lane,
        update: {
          text: segment.text,
          ...(!useDelta || splitSegments.length !== 1 ? {} : { delta: update.delta }),
          ...(update.replace ? { replace: true as const } : {}),
          ...(update.isReasoningSnapshot ? { isReasoningSnapshot: true } : {}),
        },
      })),
      suppressedReasoningOnly:
        Boolean(split.reasoningText) && suppressReasoning && !split.answerText,
    };
  };
  const updateDraftFromPartial = (lane: DraftLaneState, update: DraftPartialTextUpdate) => {
    if (!lane.stream || !update.text) {
      return;
    }
    const previousText = lane === answerLane ? lastAnswerPartialText : lane.lastPartialText;
    const nextText = resolveDraftPartialText(previousText, update);
    if (!nextText || (lane === answerLane && params.streamMode === "progress")) {
      return;
    }
    if (lane === answerLane) {
      resetAnswerToolProgressDraft();
      suppressProgress();
      lastAnswerPartialText = nextText;
    }
    lane.hasStreamedMessage = true;
    lane.finalized = false;
    lane.lastPartialText = nextText;
    lane.stream.update(nextText);
  };
  const ingestDraftLaneSegments = async (
    update: { text?: string; delta?: string; replace?: true; isReasoningSnapshot?: boolean },
    isReasoning?: boolean,
  ) => {
    const split = splitTextIntoLaneSegments(update, isReasoning);
    for (const segment of split.segments) {
      if (segment.lane === "answer") {
        await prepareAnswerLaneForText();
      }
      if (segment.lane === "reasoning") {
        noteReasoningHint();
        noteReasoningDelivered();
      }
      updateDraftFromPartial(lanes[segment.lane], segment.update);
    }
  };
  const enqueueEvent = (task: () => Promise<void>): Promise<void> => {
    const next = eventQueue.then(async () => {
      if (!params.isDispatchSuperseded()) {
        await task();
      }
    });
    eventQueue = next.catch((err: unknown) => {
      logVerbose(`telegram: draft lane callback failed: ${String(err)}`);
    });
    return eventQueue;
  };

  const recomputeQueuedAnswerBlockRotations = () => {
    let previous =
      activeAnswerBlockAssistantMessageIndex ?? pendingAnswerBlockAssistantMessageIndex;
    queuedAnswerBlockAssistantMessageIndex = undefined;
    for (const entry of queuedAnswerBlockRotations) {
      if (entry.assistantMessageIndex === undefined) {
        continue;
      }
      entry.shouldRotateBeforeDelivery =
        previous !== undefined && entry.assistantMessageIndex !== previous;
      previous = entry.assistantMessageIndex;
      queuedAnswerBlockAssistantMessageIndex = entry.assistantMessageIndex;
    }
  };
  const rotationMatches = (
    entry: QueuedAnswerBlockRotation,
    payload: ReplyPayload,
    assistantMessageIndex?: number,
  ) =>
    assistantMessageIndex !== undefined && entry.assistantMessageIndex !== undefined
      ? assistantMessageIndex === entry.assistantMessageIndex
      : entry.text !== undefined && payload.text !== undefined && entry.text === payload.text;
  const prepareQueuedAnswerBlock = async (
    payload: ReplyPayload,
    blockContext?: BlockReplyContext,
  ) => {
    if (
      !splitTextIntoLaneSegments({ text: payload.text }, payload.isReasoning).segments.some(
        (segment) => segment.lane === "answer",
      )
    ) {
      return;
    }
    resetProgress();
    const assistantMessageIndex = blockContext?.assistantMessageIndex;
    if (assistantMessageIndex === undefined) {
      queuedAnswerBlockRotations.push({ text: payload.text, shouldRotateBeforeDelivery: false });
      return;
    }
    const previous =
      queuedAnswerBlockAssistantMessageIndex ??
      activeAnswerBlockAssistantMessageIndex ??
      pendingAnswerBlockAssistantMessageIndex;
    queuedAnswerBlockRotations.push({
      assistantMessageIndex,
      text: payload.text,
      shouldRotateBeforeDelivery: previous !== undefined && assistantMessageIndex !== previous,
    });
    queuedAnswerBlockAssistantMessageIndex = assistantMessageIndex;
  };
  const takeQueuedAnswerBlockRotation = (payload: ReplyPayload, index?: number): boolean => {
    if (queuedAnswerBlockRotations.length === 0) {
      return false;
    }
    const matchIndex = queuedAnswerBlockRotations.findIndex((entry) =>
      rotationMatches(entry, payload, index),
    );
    const matched = queuedAnswerBlockRotations.splice(0, Math.max(matchIndex, 0) + 1).at(-1);
    if (matched?.assistantMessageIndex !== undefined) {
      activeAnswerBlockAssistantMessageIndex = matched.assistantMessageIndex;
      pendingAnswerBlockAssistantMessageIndex = undefined;
    }
    recomputeQueuedAnswerBlockRotations();
    return matched?.shouldRotateBeforeDelivery ?? false;
  };
  const dropQueuedAnswerBlockRotation = (payload: ReplyPayload, index?: number) => {
    let matchIndex = queuedAnswerBlockRotations.findIndex((entry) =>
      rotationMatches(entry, payload, index),
    );
    if (matchIndex < 0 && index === undefined) {
      matchIndex = queuedAnswerBlockRotations.findIndex(
        (entry) => entry.assistantMessageIndex === undefined,
      );
    }
    if (matchIndex < 0) {
      return;
    }
    const [matched] = queuedAnswerBlockRotations.splice(matchIndex, 1);
    if (
      matchIndex === 0 &&
      matched?.assistantMessageIndex !== undefined &&
      rotateAnswerLaneWhenQueuedBlocksSettle &&
      activeAnswerBlockAssistantMessageIndex === undefined &&
      answerLane.hasStreamedMessage
    ) {
      pendingAnswerBlockAssistantMessageIndex = matched.assistantMessageIndex;
    }
    recomputeQueuedAnswerBlockRotations();
  };

  const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(params.telegramCfg);
  const disableBlockStreaming = !streamDeliveryEnabled
    ? true
    : params.forceBlockStreamingForReasoning
      ? false
      : typeof resolvedBlockStreamingEnabled === "boolean"
        ? !resolvedBlockStreamingEnabled
        : canStreamAnswerDraft
          ? true
          : undefined;

  return {
    answerLane,
    reasoningLane,
    lanes,
    canPushAnswerDraft: () => Boolean(answerLane.stream),
    cleanup: async (superseded: boolean) => {
      for (const lane of [answerLane, reasoningLane]) {
        const stream = lane.stream;
        if (!stream) {
          continue;
        }
        if (superseded) {
          await (typeof stream.discard === "function" ? stream.discard() : stream.stop());
        } else if (lane.finalized) {
          await stream.stop();
        } else {
          await stream.clear();
        }
      }
    },
    disableBlockStreaming,
    durableReasoningPayloadsEnabled:
      params.resolvedReasoningLevel === "on" || Boolean(reasoningLane.stream),
    enqueueEvent,
    ingestDraftLaneSegments,
    isAnswerToolProgressOnly: () => activeAnswerDraftIsToolProgressOnly,
    isQueuedAnswerBlock: (payload: ReplyPayload, index?: number) =>
      queuedAnswerBlockRotations.some((entry) => rotationMatches(entry, payload, index)),
    lastAnswerPartialText: () => lastAnswerPartialText,
    prepareAnswerLaneForText,
    prepareAnswerLaneForToolProgress,
    prepareQueuedAnswerBlock,
    dropQueuedAnswerBlockRotation,
    takeQueuedAnswerBlockRotation,
    renderStreamText,
    repositionLaneForNewMessage,
    resetAnswerToolProgressDraft,
    resetLaneState,
    rotateAnswerLaneAfterQueuedBlocksSettle,
    rotateAnswerLaneAfterToolProgress,
    rotateAnswerLaneForNewMessage,
    rotateLaneForNewMessage,
    setActiveAnswerBlockDelivery: (delivery?: TelegramAnswerBlockDelivery) => {
      activeAnswerBlockDelivery = delivery;
    },
    activeAnswerBlockDelivery: () => activeAnswerBlockDelivery,
    setMaterializeBeforeRotation: (materialize: () => Promise<void>) => {
      materializeAnswerLaneBeforeRotation = materialize;
    },
    setProgressLifecycle: (lifecycle: { reset: () => void; suppress: () => void }) => {
      resetProgress = lifecycle.reset;
      suppressProgress = lifecycle.suppress;
    },
    setReasoningStepCallbacks: (callbacks: { noteHint: () => void; noteDelivered: () => void }) => {
      noteReasoningHint = callbacks.noteHint;
      noteReasoningDelivered = callbacks.noteDelivered;
    },
    setRotateWhenQueuedBlocksSettle: (value: boolean) => {
      rotateAnswerLaneWhenQueuedBlocksSettle = value;
    },
    splitTextIntoLaneSegments,
    streamDeliveryEnabled,
    streamReasoningInProgressDraft,
    waitForEvents: async () => await eventQueue,
    flushLane: async (lane: DraftLaneState) => await lane.stream?.flush(),
  };
}

export type TelegramDraftController = ReturnType<typeof createTelegramDraftController>;
