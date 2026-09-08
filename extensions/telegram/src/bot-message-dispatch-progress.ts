import {
  createChannelProgressDraftCompositor,
  resolveChannelProgressDraftMaxLineChars,
  resolveChannelProgressDraftMaxLines,
  type ChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-outbound";
import type { TelegramBotDeps } from "./bot-deps.js";
import { resetLaneState, rotateAnswerLaneAfterToolProgress } from "./bot-message-dispatch-draft.js";
import type {
  TelegramDispatchTurn as Turn,
  TelegramDispatchTurnConfig as TurnConfig,
  TelegramProgressStateSlice,
} from "./bot-message-dispatch.types.js";
import type { DraftLaneState } from "./lane-delivery-text-deliverer.js";
import { renderTelegramProgressDraftPreview } from "./progress-draft-preview.js";

type BufferedDispatchParams = Parameters<
  TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"]
>[0];
type ReplyOptions = NonNullable<BufferedDispatchParams["replyOptions"]>;
type CallbackPayload<K extends keyof ReplyOptions> =
  NonNullable<ReplyOptions[K]> extends (...args: infer Args) => unknown ? Args[0] : never;

function buildTelegramThinkingProgressLine(progressTokens: number): ChannelProgressDraftLine {
  const label = `Thinking… (~${Math.round(progressTokens)} tokens)`;
  return {
    id: "reasoning:token-progress",
    kind: "item",
    icon: "🧠",
    label,
    text: `🧠 ${label}`,
    prefix: false,
  };
}

function buildTelegramTextToolProgressLine(text: string, id?: string): ChannelProgressDraftLine {
  return {
    ...(id ? { id } : {}),
    kind: "item",
    label: "",
    text,
    prefix: false,
  };
}

type TelegramProgressDraftState = {
  answerLane: DraftLaneState;
  streamReasoningInProgressDraft: boolean;
};

const TELEGRAM_COMPACTION_PROGRESS_ID = "context-compaction";

function buildTelegramCompactionProgressLine(
  phase: "start" | "complete" | "incomplete",
): ChannelProgressDraftLine {
  const label = {
    start: "Compacting context...",
    complete: "Compaction complete",
    incomplete: "Compaction incomplete",
  }[phase];
  return {
    id: TELEGRAM_COMPACTION_PROGRESS_ID,
    kind: "item",
    icon: "🧹",
    label,
    text: `🧹 ${label}`,
    prefix: false,
  };
}

export function createProgressState(
  config: TurnConfig,
  draftState: TelegramProgressDraftState,
  prepareAnswerLaneForToolProgress: () => Promise<void>,
): TelegramProgressStateSlice {
  const progressState = {
    finalAnswerDeliveryStarted: false,
    finalAnswerDelivered: false,
    verboseProgressActive: () => false,
  };
  const progressCompositor = createChannelProgressDraftCompositor({
    entry: config.telegramCfg,
    mode: config.streamMode,
    active: Boolean(draftState.answerLane.stream),
    seed: `${config.context.route.accountId}:${config.context.chatId}:${config.context.threadSpec.id ?? ""}`,
    reasoningGate: draftState.streamReasoningInProgressDraft,
    reasoningLinePrefix: "🧠 ",
    commentaryLinePrefix: "💬 ",
    commentaryItalics: false,
    updateOnLineChange: true,
    shouldStartNow: (line) => typeof line !== "string" && line?.kind === "tool",
    update: async (streamText, options) => {
      await prepareAnswerLaneForToolProgress();
      draftState.answerLane.lastPartialText = streamText;
      draftState.answerLane.hasStreamedMessage = true;
      draftState.answerLane.finalized = false;
      draftState.answerLane.stream?.updatePreview(
        renderTelegramProgressDraftPreview(options.snapshot, {
          richMessages: config.telegramCfg.richMessages === true,
          maxLines: resolveChannelProgressDraftMaxLines(config.telegramCfg),
          maxLineChars: resolveChannelProgressDraftMaxLineChars(config.telegramCfg),
        }),
      );
      if (options.flush) {
        await draftState.answerLane.stream?.flush();
      }
    },
    deleteCurrent: async () => {
      // clear waits for in-flight sends and stops the stream. Reopen only after
      // that stop so a cleared card cannot consume the next progress update.
      await draftState.answerLane.stream?.clear();
      draftState.answerLane.stream?.forceNewMessage();
      draftState.answerLane.lastPartialText = "";
      draftState.answerLane.hasStreamedMessage = false;
      draftState.answerLane.finalized = false;
    },
  });
  return Object.assign(progressState, {
    progressCompositor,
    commentaryProgressEnabled: progressCompositor.commentaryProgressEnabled,
    progressPreambleEnabled:
      config.streamMode === "progress" && draftState.answerLane.stream ? true : undefined,
  });
}

export function canPushToolProgress(turn: Turn): boolean {
  return Boolean(
    turn.answerLane.stream &&
    !turn.verboseProgressActive() &&
    !turn.answerLane.finalized &&
    !turn.finalAnswerDeliveryStarted &&
    !turn.finalAnswerDelivered,
  );
}

function canPushCompactionProgress(turn: Turn): boolean {
  return Boolean(
    turn.answerLane.stream &&
    !turn.answerLane.finalized &&
    !turn.finalAnswerDeliveryStarted &&
    !turn.finalAnswerDelivered,
  );
}

async function pushProgressEvent(turn: Turn, event: () => Promise<boolean>): Promise<boolean> {
  return canPushToolProgress(turn) ? await event() : false;
}

export async function pushToolProgress(
  turn: Turn,
  line?: string | ChannelProgressDraftLine,
  options?: { toolName?: string; startImmediately?: boolean; id?: string },
): Promise<boolean> {
  if (!canPushToolProgress(turn)) {
    return false;
  }
  // Structured rows own detail; formatted callbacks only fill a missing keyed row.
  if (
    options?.id &&
    turn.progressCompositor
      .getSnapshot()
      .lines.some((entry) => typeof entry === "object" && entry.id === options.id)
  ) {
    return true;
  }
  return await turn.progressCompositor.pushToolProgress(
    typeof line === "string" ? buildTelegramTextToolProgressLine(line, options?.id) : line,
    options,
  );
}

export async function pushReasoningProgress(
  turn: Turn,
  payload: { text?: string; isReasoningSnapshot?: boolean },
): Promise<boolean> {
  return await turn.progressCompositor.pushReasoningProgress(payload.text, {
    snapshot: payload.isReasoningSnapshot === true,
  });
}

export async function pushThinkingTokenProgress(
  turn: Turn,
  progressTokens: number,
): Promise<boolean> {
  return await pushToolProgress(turn, buildTelegramThinkingProgressLine(progressTokens), {
    startImmediately: true,
  });
}

export function markFinalStarted(turn: Turn): void {
  turn.finalAnswerDeliveryStarted = true;
  turn.progressCompositor.markFinalReplyStarted();
}

export function markFinalDelivered(turn: Turn): void {
  turn.finalAnswerDelivered = true;
  turn.progressCompositor.markFinalReplyDelivered();
}

export async function teardownProgressWindow(turn: Turn): Promise<void> {
  if (turn.activeAnswerDraftIsToolProgressOnly) {
    await rotateAnswerLaneAfterToolProgress(turn);
    return;
  }
  await turn.answerLane.stream?.clear();
  resetLaneState(turn, turn.answerLane);
}

export async function handleToolStart(
  turn: Turn,
  payload: CallbackPayload<"onToolStart">,
): Promise<boolean> {
  const toolName = payload.name?.trim();
  const progressPromise = pushProgressEvent(turn, () =>
    turn.progressCompositor.pushToolEvent(payload),
  );
  if (turn.statusReactionController && toolName) {
    await turn.statusReactionController.setTool(toolName);
  }
  return await progressPromise;
}

export async function handleCompactionStart(turn: Turn): Promise<boolean> {
  const progress = canPushCompactionProgress(turn)
    ? turn.progressCompositor.pushToolProgress(buildTelegramCompactionProgressLine("start"), {
        startImmediately: true,
        flush: true,
      })
    : Promise.resolve(false);
  await turn.statusReactionController?.setCompacting();
  return await progress;
}

export async function handleCompactionEnd(
  turn: Turn,
  payload?: CallbackPayload<"onCompactionEnd">,
): Promise<boolean> {
  const progress = canPushCompactionProgress(turn)
    ? turn.progressCompositor.pushToolProgress(
        buildTelegramCompactionProgressLine(
          payload?.completed === false ? "incomplete" : "complete",
        ),
        { startImmediately: true, flush: true },
      )
    : Promise.resolve(false);
  turn.statusReactionController?.cancelPending();
  await turn.statusReactionController?.setThinking();
  return await progress;
}

export async function handleItemEvent(
  turn: Turn,
  payload: CallbackPayload<"onItemEvent">,
): Promise<boolean> {
  if (payload.kind === "preamble") {
    let rendered = false;
    if (turn.streamMode === "progress") {
      rendered = await turn.progressCompositor.pushPreambleHeadline(payload.progressText, {
        itemId: payload.itemId,
      });
    }
    if (turn.streamMode === "progress" && turn.progressCompositor.commentaryProgressEnabled) {
      rendered ||= await turn.progressCompositor.pushCommentaryProgress(payload.progressText, {
        itemId: payload.itemId,
      });
    }
    return rendered;
  }
  return await pushProgressEvent(turn, () => turn.progressCompositor.pushItemEvent(payload));
}

export async function handlePlanUpdate(
  turn: Turn,
  payload: CallbackPayload<"onPlanUpdate">,
): Promise<boolean> {
  return payload.phase === "update" && canPushToolProgress(turn)
    ? await turn.progressCompositor.pushPlanProgress(payload.steps, {
        explanation: payload.explanation,
      })
    : false;
}

export async function handleApprovalEvent(
  turn: Turn,
  payload: CallbackPayload<"onApprovalEvent">,
): Promise<boolean> {
  return await pushProgressEvent(turn, () => turn.progressCompositor.pushApprovalEvent(payload));
}

export async function handleCommandOutput(
  turn: Turn,
  payload: CallbackPayload<"onCommandOutput">,
): Promise<boolean> {
  return await pushProgressEvent(turn, () =>
    turn.progressCompositor.pushCommandOutputEvent(payload),
  );
}

export async function handlePatchSummary(
  turn: Turn,
  payload: CallbackPayload<"onPatchSummary">,
): Promise<boolean> {
  return await pushProgressEvent(turn, () => turn.progressCompositor.pushPatchEvent(payload));
}
