// Telegram plugin module owns the ephemeral progress window and collapse summary.
import {
  buildChannelProgressDraftLine,
  buildChannelProgressDraftLineForEntry,
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
    formatLine: (text) => (compositor.hasStatusHeadline ? text : formatTelegramProgressLine(text)),
    reasoningGate: params.streamReasoningInProgressDraft,
    reasoningLinePrefix: "🧠 ",
    commentaryLinePrefix: "💬 ",
    commentaryItalics: false,
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
          compositor.hasStatusHeadline,
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
  const pushToolProgress = async (
    line?: string | ChannelProgressDraftLine,
    options?: { toolName?: string; startImmediately?: boolean },
  ) => {
    if (!canPushToolProgress()) {
      return false;
    }
    return await compositor.pushToolProgress(line, options);
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
        resolveChannelStreamingPreviewToolProgress(params.telegramCfg) &&
        isChannelProgressDraftWorkToolName(toolName);
      if (windowRendersTool) {
        summary.noteToolCall();
      } else {
        summary.closeReasoningBurst();
        summary.closeCommentaryBurst();
      }
    }
    const progressPromise = pushToolProgress(
      buildChannelProgressDraftLineForEntry(
        params.telegramCfg,
        {
          event: "tool",
          itemId: payload.itemId,
          toolCallId: payload.toolCallId,
          name: toolName,
          phase: payload.phase,
          args: payload.args,
        },
        payload.detailMode ? { detailMode: payload.detailMode } : undefined,
      ),
      { toolName, startImmediately: true },
    );
    if (params.statusReactionController && toolName) {
      await params.statusReactionController.setTool(toolName);
    }
    await progressPromise;
  };
  const handleItemEvent = async (payload: CallbackPayload<"onItemEvent">) => {
    if (payload.kind === "preamble") {
      if (verboseProgressActive()) {
        return;
      }
      if (params.streamMode === "progress") {
        await compositor.pushPreambleHeadline(payload.progressText, { itemId: payload.itemId });
      }
      if (params.streamMode === "progress" && compositor.commentaryProgressEnabled) {
        const accepted = await compositor.pushCommentaryProgress(payload.progressText, {
          itemId: payload.itemId,
        });
        if (accepted) {
          summary.noteCommentary(payload.itemId, payload.progressText);
        }
      }
      return;
    }
    await pushToolProgress(
      buildChannelProgressDraftLineForEntry(params.telegramCfg, {
        event: "item",
        itemId: payload.itemId,
        toolCallId: payload.toolCallId,
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
  };
  const handlePlanUpdate = async (payload: CallbackPayload<"onPlanUpdate">) => {
    if (payload.phase === "update") {
      await pushToolProgress(
        buildChannelProgressDraftLine({
          event: "plan",
          phase: payload.phase,
          title: payload.title,
          explanation: payload.explanation,
          steps: payload.steps,
        }),
      );
    }
  };
  const handleApprovalEvent = async (payload: CallbackPayload<"onApprovalEvent">) => {
    if (payload.phase === "requested") {
      await pushToolProgress(
        buildChannelProgressDraftLine({
          event: "approval",
          phase: payload.phase,
          title: payload.title,
          command: payload.command,
          reason: payload.reason,
          message: payload.message,
        }),
      );
    }
  };
  const handleCommandOutput = async (payload: CallbackPayload<"onCommandOutput">) => {
    if (payload.phase === "end") {
      await pushToolProgress(
        buildChannelProgressDraftLineForEntry(params.telegramCfg, {
          event: "command-output",
          itemId: payload.itemId,
          toolCallId: payload.toolCallId,
          phase: payload.phase,
          title: payload.title,
          name: payload.name,
          status: payload.status,
          exitCode: payload.exitCode,
        }),
      );
    }
  };
  const handlePatchSummary = async (payload: CallbackPayload<"onPatchSummary">) => {
    if (payload.phase === "end") {
      await pushToolProgress(
        buildChannelProgressDraftLine({
          event: "patch",
          itemId: payload.itemId,
          toolCallId: payload.toolCallId,
          phase: payload.phase,
          title: payload.title,
          name: payload.name,
          added: payload.added,
          modified: payload.modified,
          deleted: payload.deleted,
          summary: payload.summary,
        }),
      );
    }
  };

  return {
    applyCollapseSummary,
    canPushToolProgress,
    cancel: () => compositor.cancel(),
    closeReasoningBurst: () => summary.closeReasoningBurst(),
    commentaryProgressEnabled: compositor.commentaryProgressEnabled,
    finalAnswerDelivered: () => finalAnswerDelivered,
    finalAnswerDeliveryStarted: () => finalAnswerDeliveryStarted,
    handleApprovalEvent,
    handleCommandOutput,
    handleItemEvent,
    handlePatchSummary,
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
