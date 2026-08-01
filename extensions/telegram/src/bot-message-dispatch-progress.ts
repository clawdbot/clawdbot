import {
  createChannelProgressDraftCompositor,
  isChannelProgressDraftWorkToolName,
  resolveChannelStreamingPreviewToolProgress,
  type ChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-outbound";
import type { TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramDraftController } from "./bot-message-dispatch-draft.js";
import type { TelegramStreamMode } from "./bot/types.js";
import {
  formatTelegramProgressLine,
  renderTelegramProgressDraftPreview,
} from "./progress-draft-preview.js";
import {
  createTelegramProgressSummaryTracker,
  formatTelegramProgressSummaryLine,
} from "./progress-summary.js";

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

function buildTelegramTextToolProgressLine(text: string): ChannelProgressDraftLine {
  return {
    kind: "item",
    label: "",
    text,
    prefix: false,
  };
}

export function createTelegramProgressController(params: {
  accountId: string;
  chatId: TelegramMessageContext["chatId"];
  draft: TelegramDraftController;
  statusReactionController: TelegramMessageContext["statusReactionController"];
  streamMode: TelegramStreamMode;
  streamReasoningInProgressDraft: boolean;
  telegramCfg: TelegramAccountConfig;
  threadId?: number;
}) {
  const { answerLane } = params.draft;
  const summaryStartedAt = Date.now();
  const summary = createTelegramProgressSummaryTracker();
  let summaryDelivered = false;
  let draftEverRendered = false;
  let finalAnswerDeliveryStarted = false;
  let finalAnswerDelivered = false;
  let sawProgressFinal = false;
  let verboseProgressActive: () => boolean = () => false;

  const compositor = createChannelProgressDraftCompositor({
    entry: params.telegramCfg,
    mode: params.streamMode,
    active: Boolean(answerLane.stream),
    seed: `${params.accountId}:${params.chatId}:${params.threadId ?? ""}`,
    formatLine: (text) =>
      compositor.hasStatusHeadline || compositor.hasPlanProgress
        ? text
        : formatTelegramProgressLine(text),
    reasoningGate: params.streamReasoningInProgressDraft,
    reasoningLinePrefix: "🧠 ",
    commentaryLinePrefix: "💬 ",
    commentaryItalics: false,
    updateOnLineChange: true,
    shouldStartNow: (line) => typeof line !== "string" && line?.kind === "tool",
    // renderTelegramProgressDraftPreview draws the work lines from `lines` in
    // headline/checklist mode, so they must not also arrive inside the text.
    rendersRollingLinesNatively: true,
    update: async (streamText, options) => {
      draftEverRendered = true;
      await params.draft.prepareAnswerLaneForToolProgress();
      answerLane.lastPartialText = streamText;
      answerLane.hasStreamedMessage = true;
      answerLane.finalized = false;
      answerLane.stream?.updatePreview(
        renderTelegramProgressDraftPreview(
          streamText,
          options?.lines ?? [],
          params.telegramCfg.richMessages === true,
          compositor.hasStatusHeadline || compositor.hasPlanProgress,
        ),
      );
      if (options?.flush) {
        await answerLane.stream?.flush();
      }
    },
  });

  params.draft.setProgressLifecycle({
    reset: () => compositor.reset(),
    suppress: () => compositor.suppress(),
  });

  const canPushToolProgress = () =>
    Boolean(
      answerLane.stream &&
      !verboseProgressActive() &&
      !answerLane.finalized &&
      !finalAnswerDeliveryStarted &&
      !finalAnswerDelivered,
    );
  const pushEvent = async (fn: () => Promise<boolean>) =>
    canPushToolProgress() ? await fn() : false;
  const pushToolProgress = async (
    line?: string | ChannelProgressDraftLine,
    options?: { toolName?: string; startImmediately?: boolean },
  ) => {
    if (!canPushToolProgress()) {
      return false;
    }
    return await compositor.pushToolProgress(
      typeof line === "string" ? buildTelegramTextToolProgressLine(line) : line,
      options,
    );
  };
  const pushReasoningProgress = async (payload: {
    text?: string;
    isReasoningSnapshot?: boolean;
  }) => {
    if (params.streamReasoningInProgressDraft && payload.text) {
      summary.noteReasoningActivity();
    }
    return await compositor.pushReasoningProgress(payload.text, {
      snapshot: payload.isReasoningSnapshot === true,
    });
  };
  const pushThinkingTokenProgress = async (progressTokens: number) => {
    const rendered = await pushToolProgress(buildTelegramThinkingProgressLine(progressTokens), {
      startImmediately: true,
    });
    if (rendered) {
      summary.noteReasoningActivity();
    }
    return rendered;
  };

  const markFinalStarted = () => {
    finalAnswerDeliveryStarted = true;
    compositor.markFinalReplyStarted();
  };
  const markFinalDelivered = () => {
    finalAnswerDelivered = true;
    sawProgressFinal = true;
    compositor.markFinalReplyDelivered();
  };
  const resolveCollapseSummaryLine = (): string | undefined => {
    if (summaryDelivered) {
      return undefined;
    }
    summaryDelivered = true;
    if (!draftEverRendered) {
      return undefined;
    }
    return (
      formatTelegramProgressSummaryLine(summary.counts(), Date.now() - summaryStartedAt) ||
      undefined
    );
  };
  const applyCollapseSummary = async (
    line: string,
    postCosmeticSummary: (line: string) => Promise<void>,
  ) => {
    const messageId = await answerLane.stream?.finalizeToPreview(
      params.draft.renderStreamText(line),
    );
    if (typeof messageId !== "number") {
      await postCosmeticSummary(line);
    }
  };
  const resetAnswerLaneAfterCollapse = () => {
    if (params.draft.isAnswerToolProgressOnly()) {
      params.draft.resetAnswerToolProgressDraft();
      compositor.suppress();
      params.draft.setRotateWhenQueuedBlocksSettle(false);
    }
    answerLane.stream?.forceNewMessage();
    params.draft.resetLaneState(answerLane);
  };
  const teardownWindow = async () => {
    if (params.draft.isAnswerToolProgressOnly()) {
      await params.draft.rotateAnswerLaneAfterToolProgress();
      return;
    }
    await answerLane.stream?.clear();
    params.draft.resetLaneState(answerLane);
  };

  const handleToolStart = async (payload: CallbackPayload<"onToolStart">) => {
    const toolName = payload.name?.trim();
    if (payload.phase === "start") {
      const windowRendersTool =
        canPushToolProgress() &&
        resolveChannelStreamingPreviewToolProgress(params.telegramCfg, true, params.streamMode) &&
        isChannelProgressDraftWorkToolName(toolName);
      if (windowRendersTool) {
        summary.noteToolCall();
      } else {
        summary.closeReasoningBurst();
        summary.closeCommentaryBurst();
      }
    }
    const progressPromise = pushEvent(() => compositor.pushToolEvent(payload));
    if (params.statusReactionController && toolName) {
      await params.statusReactionController.setTool(toolName);
    }
    return await progressPromise;
  };
  const handleItemEvent = async (payload: CallbackPayload<"onItemEvent">) => {
    if (payload.kind === "preamble") {
      if (verboseProgressActive()) {
        return false;
      }
      let rendered = false;
      if (params.streamMode === "progress") {
        rendered = await compositor.pushPreambleHeadline(payload.progressText, {
          itemId: payload.itemId,
        });
      }
      if (params.streamMode === "progress" && compositor.commentaryProgressEnabled) {
        const accepted = await compositor.pushCommentaryProgress(payload.progressText, {
          itemId: payload.itemId,
        });
        if (accepted) {
          summary.noteCommentary(payload.itemId, payload.progressText);
        }
        rendered ||= accepted;
      }
      return rendered;
    }
    return await pushEvent(() => compositor.pushItemEvent(payload));
  };
  const handlePlanUpdate = async (payload: CallbackPayload<"onPlanUpdate">) => {
    if (payload.phase === "update" && canPushToolProgress()) {
      return await compositor.pushPlanProgress(payload.steps, {
        explanation: payload.explanation,
      });
    }
    return false;
  };
  return {
    applyCollapseSummary,
    beginQueuedFollowup: () => {
      finalAnswerDeliveryStarted = false;
      finalAnswerDelivered = false;
      sawProgressFinal = false;
      compositor.beginNewTurn({ force: true });
    },
    canPushToolProgress,
    cancel: () => compositor.cancel(),
    closeReasoningBurst: () => summary.closeReasoningBurst(),
    commentaryProgressEnabled: compositor.commentaryProgressEnabled,
    finalAnswerDelivered: () => finalAnswerDelivered,
    finalAnswerDeliveryStarted: () => finalAnswerDeliveryStarted,
    handleApprovalEvent: (payload: CallbackPayload<"onApprovalEvent">) =>
      pushEvent(() => compositor.pushApprovalEvent(payload)),
    handleCommandOutput: (payload: CallbackPayload<"onCommandOutput">) =>
      pushEvent(() => compositor.pushCommandOutputEvent(payload)),
    handleItemEvent,
    handlePatchSummary: (payload: CallbackPayload<"onPatchSummary">) =>
      pushEvent(() => compositor.pushPatchEvent(payload)),
    handlePlanUpdate,
    handleToolStart,
    markFinalDelivered,
    markFinalStarted,
    markSawFinal: () => {
      sawProgressFinal = true;
    },
    progressPreambleEnabled:
      params.streamMode === "progress" && answerLane.stream ? true : undefined,
    pushReasoningProgress,
    pushThinkingTokenProgress,
    pushToolProgress,
    reset: () => compositor.reset(),
    resetAnswerLaneAfterCollapse,
    resolveCollapseSummaryLine,
    sawProgressFinal: () => sawProgressFinal,
    setFinalAnswerDelivered: (value: boolean) => {
      finalAnswerDelivered = value;
    },
    setSummaryDelivered: () => {
      summaryDelivered = true;
    },
    setVerboseProgressActive: (isActive: () => boolean) => {
      verboseProgressActive = isActive;
    },
    suppress: () => compositor.suppress(),
    teardownWindow,
    verboseProgressActive: () => verboseProgressActive(),
  };
}

export type TelegramProgressController = ReturnType<typeof createTelegramProgressController>;
