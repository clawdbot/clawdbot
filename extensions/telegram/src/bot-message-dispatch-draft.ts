import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { BlockReplyContext } from "openclaw/plugin-sdk/reply-runtime";
import { createSubsystemLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type {
  TelegramDispatchTurn as Turn,
  TelegramDispatchTurnConfig as TurnConfig,
  TelegramDraftPartialTextUpdate,
  TelegramDraftStateSlice,
  TelegramQueuedAnswerBlockRotation,
  TelegramSplitLaneSegmentsResult,
  TelegramAnswerBlockDelivery,
} from "./bot-message-dispatch.types.js";
import { resolveTelegramDraftStreamingChunking } from "./draft-chunking.js";
import { createTelegramDraftStream, type TelegramDraftPreview } from "./draft-stream.js";
import { renderTelegramHtmlText } from "./format.js";
import type { DraftLaneState, LaneName } from "./lane-delivery-text-deliverer.js";
import { TELEGRAM_TEXT_CHUNK_LIMIT } from "./outbound-adapter.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import { splitTelegramReasoningText } from "./reasoning-lane-coordinator.js";
import { buildTelegramRichMarkdown, TELEGRAM_RICH_TEXT_LIMIT } from "./rich-message.js";
import { reportTelegramProviderDelivery } from "./send-outbound.js";
import { recordSentMessage } from "./sent-message-cache.js";

const draftLogger = createSubsystemLogger("telegram/draft-stream");
const DRAFT_MIN_INITIAL_CHARS = 30;

function resolveDraftPartialText(
  previous: string,
  update: TelegramDraftPartialTextUpdate,
): string | undefined {
  const nextText =
    update.replace || update.isReasoningSnapshot || update.delta === undefined
      ? update.text
      : `${previous}${update.delta}`;
  return nextText === previous ? undefined : nextText;
}

function renderStreamText(
  turn: Pick<Turn, "tableMode" | "telegramCfg">,
  text: string,
): TelegramDraftPreview {
  return turn.telegramCfg.richMessages === true
    ? {
        text,
        richMessage: buildTelegramRichMarkdown(text, {
          tableMode: turn.tableMode,
          skipEntityDetection: turn.telegramCfg.linkPreview === false,
        }),
      }
    : {
        text: renderTelegramHtmlText(text, { tableMode: turn.tableMode }),
        parseMode: "HTML",
        markdownSource: { text, tableMode: turn.tableMode },
      };
}

export function createDraftState(params: TurnConfig): TelegramDraftStateSlice {
  const isRoomEvent = params.context.ctxPayload.InboundEventKind === "room_event";
  const forceBlockStreamingForReasoning =
    params.resolvedReasoningLevel === "on" && params.streamMode !== "progress";
  const streamDeliveryEnabled = !isRoomEvent && params.streamMode !== "off";
  const previewAvailable =
    params.allowProviderPreview &&
    streamDeliveryEnabled &&
    !(params.replyToMode !== "off" && params.replyQuoteText != null) &&
    !forceBlockStreamingForReasoning;
  const accountBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(params.telegramCfg, {
    previewAvailable,
    blockStreamingDefault: params.cfg.agents?.defaults?.blockStreamingDefault,
  });
  const canStreamAnswerDraft = previewAvailable && !accountBlockStreamingEnabled;
  const streamReasoningDraft = params.resolvedReasoningLevel === "stream";
  const streamReasoningInProgressDraft =
    streamReasoningDraft && params.streamMode === "progress" && canStreamAnswerDraft;
  const canStreamReasoningDraft =
    params.allowProviderPreview &&
    !isRoomEvent &&
    streamReasoningDraft &&
    !streamReasoningInProgressDraft;
  const draftMaxChars =
    params.streamMode === "block"
      ? Math.min(
          resolveTelegramDraftStreamingChunking(params.cfg, params.context.route.accountId)
            .maxChars,
          params.textLimit,
        )
      : Math.min(
          params.textLimit,
          params.telegramCfg.richMessages === true
            ? TELEGRAM_RICH_TEXT_LIMIT
            : TELEGRAM_TEXT_CHUNK_LIMIT,
        );
  const renderDraftText = (text: string): TelegramDraftPreview => renderStreamText(params, text);

  const createDraftLane = (laneName: LaneName, enabled: boolean): DraftLaneState => {
    const stream = enabled
      ? (params.telegramDeps.createTelegramDraftStream ?? createTelegramDraftStream)({
          api: params.bot.api,
          chatId: params.context.chatId,
          maxChars: draftMaxChars,
          thread: params.context.threadSpec,
          replyToMessageId: params.draftReplyToMessageId,
          replyToMode: params.replyToMode,
          richMessages: params.telegramCfg.richMessages,
          linkPreview: params.telegramCfg.linkPreview,
          minInitialChars: DRAFT_MIN_INITIAL_CHARS,
          renderText: renderDraftText,
          onRetainedPage: (page) => {
            lanes[laneName].retainedPromptContextPages.push({
              messageId: page.messageId,
              text: page.textSnapshot,
            });
          },
          ...(params.context.threadSpec.id !== undefined
            ? {
                validateProviderMessage: async (message) => {
                  await reportTelegramProviderDelivery({
                    message,
                    messageId: message.message_id,
                    fallbackChatId: params.context.chatId,
                    successfulSendThread: params.context.threadSpec,
                  });
                },
              }
            : {}),
          onProviderMessage: async (message) => {
            recordSentMessage(params.context.chatId, message.message_id, params.cfg, {
              accountId: params.context.route.accountId,
              agentId: params.opts.ownerAgentId,
            });
            await (
              params.telegramDeps.recordOutboundMessageForPromptContext ??
              recordOutboundMessageForPromptContext
            )({
              cfg: params.cfg,
              ownerAgentId: params.opts.ownerAgentId,
              account: {
                accountId: params.context.route.accountId,
                ...(params.telegramCfg.name !== undefined ? { name: params.telegramCfg.name } : {}),
              },
              chatId: params.context.chatId,
              message,
              messageId: message.message_id,
              ...(params.context.threadSpec.id !== undefined
                ? { messageThreadId: params.context.threadSpec.id }
                : {}),
              successfulSendThread: params.context.threadSpec,
            });
          },
          log: logVerbose,
          // Draft delivery failures must stay operator-visible: verbose-only
          // logging hid preview send/edit/cleanup errors, so a dead progress
          // stream looked like the bot silently ignoring the user.
          warn: (message) =>
            draftLogger.warn(message, {
              lane: laneName,
              chatId: params.context.chatId,
              threadId: params.context.threadSpec.id,
            }),
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
  const resolvedBlockStreamingEnabled = resolveChannelStreamingBlockEnabled(params.telegramCfg);
  const disableBlockStreaming = !streamDeliveryEnabled
    ? true
    : forceBlockStreamingForReasoning
      ? false
      : typeof resolvedBlockStreamingEnabled === "boolean"
        ? !resolvedBlockStreamingEnabled
        : canStreamAnswerDraft
          ? true
          : undefined;

  return {
    answerLane: lanes.answer,
    reasoningLane: lanes.reasoning,
    lanes,
    streamDeliveryEnabled,
    streamReasoningInProgressDraft,
    disableBlockStreaming,
    durableReasoningPayloadsEnabled:
      params.resolvedReasoningLevel === "on" || Boolean(lanes.reasoning.stream),
    lastAnswerPartialText: "",
    activeAnswerDraftIsToolProgressOnly: false,
    activeAnswerBlockAssistantMessageIndex: undefined as number | undefined,
    activeAnswerBlockDelivery: undefined as TelegramAnswerBlockDelivery | undefined,
    queuedAnswerBlockRotations: [] as TelegramQueuedAnswerBlockRotation[],
    queuedAnswerBlockAssistantMessageIndex: undefined as number | undefined,
    pendingAnswerBlockAssistantMessageIndex: undefined as number | undefined,
    rotateAnswerLaneWhenQueuedBlocksSettle: false,
    draftEventQueue: Promise.resolve(),
  };
}

export function resetLaneState(turn: Turn, lane: DraftLaneState): void {
  lane.lastPartialText = "";
  if (lane === turn.answerLane) {
    turn.lastAnswerPartialText = "";
  }
  lane.hasStreamedMessage = false;
  lane.finalized = false;
  lane.retainedPromptContextPages = [];
  if (lane === turn.answerLane) {
    turn.activeAnswerDraftIsToolProgressOnly = false;
    turn.pendingAnswerBlockAssistantMessageIndex = undefined;
    turn.activeAnswerBlockDelivery = undefined;
  }
}

export function repositionLaneForNewMessage(turn: Turn, lane: DraftLaneState): void {
  // Reposition instead of delete-then-repost: the replacement must land
  // before deferred cleanup or Telegram can jump and retain a stale preview.
  lane.stream?.rotateToNewMessageDeferringDelete();
  resetLaneState(turn, lane);
}

export async function rotateLaneForNewMessage(turn: Turn, lane: DraftLaneState): Promise<void> {
  if (!lane.hasStreamedMessage && typeof lane.stream?.messageId() !== "number") {
    resetLaneState(turn, lane);
    return;
  }
  // Settle pending edits before changing stream identity; reset only after the
  // new Telegram message is selected or delivery state can describe the old one.
  await lane.stream?.stop();
  lane.stream?.forceNewMessage();
  resetLaneState(turn, lane);
}

export async function rotateAnswerLaneForNewMessage(turn: Turn) {
  // An accepted block must become durable before rotation; otherwise cleanup
  // can discard its only visible preview.
  await turn.materializeAnswerLaneBeforeRotation();
  await rotateLaneForNewMessage(turn, turn.answerLane);
}

export async function rotateAnswerLaneAfterToolProgress(turn: Turn): Promise<boolean> {
  if (!turn.activeAnswerDraftIsToolProgressOnly) {
    return false;
  }
  repositionLaneForNewMessage(turn, turn.answerLane);
  turn.progressCompositor.resetActivity({ suppressed: true });
  turn.rotateAnswerLaneWhenQueuedBlocksSettle = false;
  return true;
}

export async function rotateAnswerLaneAfterQueuedBlocksSettle(turn: Turn): Promise<boolean> {
  if (!turn.rotateAnswerLaneWhenQueuedBlocksSettle || turn.queuedAnswerBlockRotations.length > 0) {
    return false;
  }
  turn.rotateAnswerLaneWhenQueuedBlocksSettle = false;
  if (!turn.answerLane.hasStreamedMessage || turn.activeAnswerDraftIsToolProgressOnly) {
    return false;
  }
  await rotateAnswerLaneForNewMessage(turn);
  return true;
}

export async function prepareAnswerLaneForText(turn: Turn): Promise<boolean> {
  if (turn.streamMode === "progress") {
    return false;
  }
  if (await rotateAnswerLaneAfterToolProgress(turn)) {
    return true;
  }
  if (await rotateAnswerLaneAfterQueuedBlocksSettle(turn)) {
    return true;
  }
  if (!turn.answerLane.finalized) {
    return false;
  }
  turn.answerLane.stream?.forceNewMessage();
  resetLaneState(turn, turn.answerLane);
  turn.rotateAnswerLaneWhenQueuedBlocksSettle = false;
  return true;
}

export async function prepareAnswerLaneForToolProgress(turn: Turn): Promise<void> {
  if (turn.answerLane.finalized) {
    turn.answerLane.stream?.forceNewMessage();
    resetLaneState(turn, turn.answerLane);
  }
  if (turn.activeAnswerDraftIsToolProgressOnly) {
    return;
  }
  if (turn.streamMode !== "progress" && turn.answerLane.hasStreamedMessage) {
    await rotateAnswerLaneForNewMessage(turn);
  }
  turn.activeAnswerDraftIsToolProgressOnly = true;
}

export function splitTextIntoLaneSegments(
  turn: Turn,
  update: { text?: string; delta?: string; replace?: true; isReasoningSnapshot?: boolean },
  isReasoning?: boolean,
): TelegramSplitLaneSegmentsResult {
  const split = splitTelegramReasoningText(update.text, isReasoning);
  const splitSegments: Array<{ lane: LaneName; text: string }> = [];
  const useDelta =
    !update.replace && update.isReasoningSnapshot !== true && update.delta !== undefined;
  const suppressReasoning = turn.resolvedReasoningLevel === "off";
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
      isReasoning === true && !split.answerText && (suppressReasoning || !split.reasoningText),
  };
}

function updateTelegramDraftFromPartial(
  turn: Turn,
  lane: DraftLaneState,
  update: TelegramDraftPartialTextUpdate,
  schedule = true,
): string | undefined {
  if (!lane.stream || !update.text) {
    return undefined;
  }
  const previousText = lane === turn.answerLane ? turn.lastAnswerPartialText : lane.lastPartialText;
  const nextText = resolveDraftPartialText(previousText, update);
  if (!nextText || (lane === turn.answerLane && turn.streamMode === "progress")) {
    return undefined;
  }
  if (lane === turn.answerLane) {
    turn.activeAnswerDraftIsToolProgressOnly = false;
    turn.progressCompositor.resetActivity({ suppressed: true });
    turn.lastAnswerPartialText = nextText;
  }
  lane.hasStreamedMessage = true;
  lane.finalized = false;
  lane.lastPartialText = nextText;
  if (schedule) {
    lane.stream.update(nextText);
  }
  return nextText;
}

export async function ingestDraftLaneSegments(
  turn: Turn,
  update: { text?: string; delta?: string; replace?: true; isReasoningSnapshot?: boolean },
  isReasoning?: boolean,
): Promise<void> {
  if (isReasoning !== true) {
    const stream = turn.answerLane.stream;
    if (!stream) {
      return;
    }
    const rotationPending =
      turn.streamMode !== "progress" &&
      (turn.activeAnswerDraftIsToolProgressOnly ||
        turn.answerLane.finalized ||
        (turn.rotateAnswerLaneWhenQueuedBlocksSettle &&
          turn.queuedAnswerBlockRotations.length === 0 &&
          turn.answerLane.hasStreamedMessage));
    if (rotationPending) {
      const text = update.text;
      if (!text) {
        return;
      }
      await prepareAnswerLaneForText(turn);
      updateTelegramDraftFromPartial(turn, turn.answerLane, { text, replace: true });
      return;
    }
    let didMaterialize = false;
    let materialized: string | undefined;
    stream.updateLazy(() => {
      if (!didMaterialize) {
        const text = update.text;
        // Partial text is cumulative, so the newest snapshot remains authoritative when
        // intermediate delta-bearing payloads are coalesced before this flush.
        materialized = text
          ? updateTelegramDraftFromPartial(turn, turn.answerLane, { text, replace: true }, false)
          : undefined;
        didMaterialize = true;
      }
      return materialized;
    });
    return;
  }
  const split = splitTextIntoLaneSegments(turn, update, isReasoning);
  for (const segment of split.segments) {
    if (segment.lane === "answer") {
      await prepareAnswerLaneForText(turn);
    }
    if (segment.lane === "reasoning") {
      turn.reasoningStepState.noteReasoningHint();
      turn.reasoningStepState.noteReasoningDelivered();
    }
    updateTelegramDraftFromPartial(turn, turn.lanes[segment.lane], segment.update);
  }
}

export function enqueueDraftEvent(turn: Turn, task: () => Promise<void>): Promise<void> {
  // Ownership can change while this serialized mutation waits. Re-check at
  // execution time so superseded work cannot update or rotate visible drafts.
  const next = turn.draftEventQueue.then(async () => {
    if (!turn.isSuperseded()) {
      await task();
    }
  });
  turn.draftEventQueue = next.catch((err: unknown) => {
    logVerbose(`telegram: draft lane callback failed: ${String(err)}`);
  });
  return turn.draftEventQueue;
}

function recomputeTelegramQueuedAnswerBlockRotations(turn: Turn): void {
  let previous =
    turn.activeAnswerBlockAssistantMessageIndex ?? turn.pendingAnswerBlockAssistantMessageIndex;
  turn.queuedAnswerBlockAssistantMessageIndex = undefined;
  for (const entry of turn.queuedAnswerBlockRotations) {
    if (entry.assistantMessageIndex === undefined) {
      continue;
    }
    entry.shouldRotateBeforeDelivery =
      previous !== undefined && entry.assistantMessageIndex !== previous;
    previous = entry.assistantMessageIndex;
    turn.queuedAnswerBlockAssistantMessageIndex = entry.assistantMessageIndex;
  }
}

function telegramQueuedRotationMatches(
  entry: TelegramQueuedAnswerBlockRotation,
  payload: ReplyPayload,
  assistantMessageIndex?: number,
): boolean {
  return assistantMessageIndex !== undefined && entry.assistantMessageIndex !== undefined
    ? assistantMessageIndex === entry.assistantMessageIndex
    : entry.text !== undefined && payload.text !== undefined && entry.text === payload.text;
}

export async function prepareQueuedAnswerBlock(
  turn: Turn,
  payload: ReplyPayload,
  blockContext?: BlockReplyContext,
): Promise<void> {
  if (
    !splitTextIntoLaneSegments(turn, { text: payload.text }, payload.isReasoning).segments.some(
      (segment) => segment.lane === "answer",
    )
  ) {
    return;
  }
  if (turn.streamMode !== "progress") {
    turn.progressCompositor.resetActivity();
  }
  const assistantMessageIndex = blockContext?.assistantMessageIndex;
  if (assistantMessageIndex === undefined) {
    turn.queuedAnswerBlockRotations.push({
      text: payload.text,
      shouldRotateBeforeDelivery: false,
    });
    return;
  }
  const previous =
    turn.queuedAnswerBlockAssistantMessageIndex ??
    turn.activeAnswerBlockAssistantMessageIndex ??
    turn.pendingAnswerBlockAssistantMessageIndex;
  turn.queuedAnswerBlockRotations.push({
    assistantMessageIndex,
    text: payload.text,
    shouldRotateBeforeDelivery: previous !== undefined && assistantMessageIndex !== previous,
  });
  turn.queuedAnswerBlockAssistantMessageIndex = assistantMessageIndex;
}

export function takeQueuedAnswerBlockRotation(
  turn: Turn,
  payload: ReplyPayload,
  assistantMessageIndex?: number,
): boolean {
  if (turn.queuedAnswerBlockRotations.length === 0) {
    return false;
  }
  const matchIndex = turn.queuedAnswerBlockRotations.findIndex((entry) =>
    telegramQueuedRotationMatches(entry, payload, assistantMessageIndex),
  );
  const matched = turn.queuedAnswerBlockRotations.splice(0, Math.max(matchIndex, 0) + 1).at(-1);
  if (matched?.assistantMessageIndex !== undefined) {
    turn.activeAnswerBlockAssistantMessageIndex = matched.assistantMessageIndex;
    turn.pendingAnswerBlockAssistantMessageIndex = undefined;
  }
  recomputeTelegramQueuedAnswerBlockRotations(turn);
  return matched?.shouldRotateBeforeDelivery ?? false;
}

export function dropQueuedAnswerBlockRotation(
  turn: Turn,
  payload: ReplyPayload,
  assistantMessageIndex?: number,
): void {
  let matchIndex = turn.queuedAnswerBlockRotations.findIndex((entry) =>
    telegramQueuedRotationMatches(entry, payload, assistantMessageIndex),
  );
  if (matchIndex < 0 && assistantMessageIndex === undefined) {
    matchIndex = turn.queuedAnswerBlockRotations.findIndex(
      (entry) => entry.assistantMessageIndex === undefined,
    );
  }
  if (matchIndex < 0) {
    return;
  }
  const [matched] = turn.queuedAnswerBlockRotations.splice(matchIndex, 1);
  if (
    matchIndex === 0 &&
    matched?.assistantMessageIndex !== undefined &&
    turn.rotateAnswerLaneWhenQueuedBlocksSettle &&
    turn.activeAnswerBlockAssistantMessageIndex === undefined &&
    turn.answerLane.hasStreamedMessage
  ) {
    turn.pendingAnswerBlockAssistantMessageIndex = matched.assistantMessageIndex;
  }
  recomputeTelegramQueuedAnswerBlockRotations(turn);
}

export function isQueuedAnswerBlock(
  turn: Turn,
  payload: ReplyPayload,
  assistantMessageIndex?: number,
): boolean {
  return turn.queuedAnswerBlockRotations.some((entry) =>
    telegramQueuedRotationMatches(entry, payload, assistantMessageIndex),
  );
}

export function beginDraftQueuedFollowup(turn: Turn): void {
  for (const lane of [turn.answerLane, turn.reasoningLane]) {
    if (!lane.stream) {
      continue;
    }
    lane.stream.forceNewMessage();
    resetLaneState(turn, lane);
  }
}

export async function cleanupDrafts(turn: Turn, superseded: boolean): Promise<void> {
  for (const lane of [turn.answerLane, turn.reasoningLane]) {
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
}

export const waitForDraftEvents = (turn: Turn) => turn.draftEventQueue;

export const flushDraftLane = (_turn: Turn, lane: DraftLaneState) => lane.stream?.flush();
