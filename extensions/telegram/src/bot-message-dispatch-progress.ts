import {
  createChannelProgressDraftCompositor,
  type ChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-outbound";
import type { TelegramBotDeps } from "./bot-deps.js";
import { resetLaneState, rotateAnswerLaneAfterToolProgress } from "./bot-message-dispatch-draft.js";
import type {
  TelegramDispatchTurn as Turn,
  TelegramDispatchTurnConfig as TurnConfig,
  TelegramProgressStateSlice,
} from "./bot-message-dispatch.types.js";
import type { DraftLaneState } from "./lane-delivery.js";
import {
  formatTelegramProgressLine,
  renderTelegramProgressDraftPreview,
} from "./progress-draft-preview.js";

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
    formatLine: (text) =>
      progressCompositor.hasStatusHeadline || progressCompositor.hasPlanProgress
        ? text
        : formatTelegramProgressLine(text),
    reasoningGate: draftState.streamReasoningInProgressDraft,
    reasoningLinePrefix: "🧠 ",
    commentaryLinePrefix: "💬 ",
    commentaryItalics: false,
    updateOnLineChange: true,
    shouldStartNow: (line) => typeof line !== "string" && line?.kind === "tool",
    // renderTelegramProgressDraftPreview draws the work lines from `lines` in
    // headline/checklist mode, so they must not also arrive inside the text.
    rendersRollingLinesNatively: true,
    update: async (streamText, options) => {
      await prepareAnswerLaneForToolProgress();
      draftState.answerLane.lastPartialText = streamText;
      draftState.answerLane.hasStreamedMessage = true;
      draftState.answerLane.finalized = false;
      draftState.answerLane.stream?.updatePreview(
        renderTelegramProgressDraftPreview(
          streamText,
          options?.lines ?? [],
          config.telegramCfg.richMessages === true,
          progressCompositor.hasStatusHeadline || progressCompositor.hasPlanProgress,
        ),
      );
      if (options?.flush) {
        await draftState.answerLane.stream?.flush();
      }
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

export async function handleItemEvent(
  turn: Turn,
  payload: CallbackPayload<"onItemEvent">,
): Promise<boolean> {
  if (payload.kind === "preamble") {
    if (turn.verboseProgressActive()) {
      return false;
    }
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
