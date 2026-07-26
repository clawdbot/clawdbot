import {
  type AgentPlanStep,
  buildChannelProgressDraftLineForEntry,
  type ChannelProgressDraftLine,
  createChannelProgressDraftGate,
  formatChannelProgressDraftLine,
  formatChannelProgressDraftText,
  isChannelProgressDraftWorkToolName,
  mergeChannelProgressDraftLine,
  normalizeChannelProgressDraftLineIdentity,
  resolveChannelProgressDraftMaxLines,
} from "openclaw/plugin-sdk/channel-outbound";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import type { CoreConfig, MatrixConfig, MatrixStreamingMode, ReplyToMode } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { formatMatrixToolProgressMarkdownCode } from "./handler-helpers.js";
import { loadMatrixDraftStream, type MatrixDraftStreamHandle } from "./handler-runtime.js";
import type { BlockReplyContext, ReplyPayload } from "./runtime-api.js";

export async function createMatrixDraftController(params: {
  streaming: MatrixStreamingMode;
  previewToolProgressEnabled: boolean;
  replyToMode: ReplyToMode;
  messageId: string;
  threadTarget?: string;
  accountConfig?: MatrixConfig;
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  client: MatrixClient;
  logVerboseMessage: (message: string) => void;
}) {
  const {
    streaming,
    previewToolProgressEnabled,
    replyToMode,
    messageId,
    threadTarget,
    accountConfig,
    cfg,
    accountId,
    roomId,
    client,
    logVerboseMessage,
  } = params;
  let draftConsumed = false;

  const draftStreamingEnabled = streaming !== "off";
  const quietDraftStreaming = streaming === "quiet" || streaming === "progress";
  const progressDraftStreaming = streaming === "progress";
  const draftReplyToId = replyToMode !== "off" && !threadTarget ? messageId : undefined;
  const draftStream: MatrixDraftStreamHandle | undefined = draftStreamingEnabled
    ? await loadMatrixDraftStream().then(({ createMatrixDraftStream }) =>
        createMatrixDraftStream({
          roomId,
          client,
          cfg,
          mode: quietDraftStreaming ? "quiet" : "partial",
          threadId: threadTarget,
          replyToId: draftReplyToId,
          preserveReplyId: replyToMode === "all",
          accountId,
          log: logVerboseMessage,
        }),
      )
    : undefined;
  const shouldStreamPreviewToolProgress = Boolean(draftStream) && previewToolProgressEnabled;
  const shouldSuppressDefaultToolProgressMessages =
    Boolean(draftStream) && (shouldStreamPreviewToolProgress || params.streaming === "progress");
  type PendingDraftBoundary = {
    messageGeneration: number;
    endOffset: number;
  };
  // Track the current draft block start plus any queued block-end offsets
  // inside the model's cumulative partial text so multiple block
  // boundaries can drain in order even when Matrix delivery lags behind.
  let currentDraftMessageGeneration = 0;
  let currentDraftBlockOffset = 0;
  let latestDraftFullText = "";
  const pendingDraftBoundaries: PendingDraftBoundary[] = [];
  const latestQueuedDraftBoundaryOffsets = new Map<number, number>();
  let currentDraftReplyToId = draftReplyToId;
  let previewToolProgressSuppressed = false;
  let previewToolProgressLines: Array<string | ChannelProgressDraftLine> = [];
  let latestPlan: AgentPlanStep[] | undefined;
  let latestPlanExplanation: string | undefined;
  const progressConfigEntry = accountConfig ?? cfg.channels?.matrix;
  const progressSeed = `${accountId}:${roomId}`;
  // Set after the first final payload consumes or discards the draft event
  // so subsequent finals go through normal delivery.

  const renderProgressDraft = () => {
    if (!draftStream) {
      return;
    }
    const previewText = formatChannelProgressDraftText({
      entry: progressConfigEntry,
      lines: previewToolProgressLines,
      seed: progressSeed,
      formatLine: formatMatrixToolProgressMarkdownCode,
      bullet: "-",
      narration: latestPlanExplanation,
      plan: latestPlan,
    });
    if (!previewText) {
      return;
    }
    draftStream.update(previewText);
  };
  const progressDraftGate = createChannelProgressDraftGate({
    onStart: renderProgressDraft,
  });

  const pushPreviewToolProgress = async (
    line?: string | ChannelProgressDraftLine,
    options?: { toolName?: string },
  ) => {
    if (!draftStream) {
      return;
    }
    if (options?.toolName !== undefined && !isChannelProgressDraftWorkToolName(options.toolName)) {
      return;
    }
    const normalized = normalizeChannelProgressDraftLineIdentity(line);
    const progressLine = typeof line === "object" && line !== undefined ? line : normalized;
    if (!progressDraftStreaming) {
      if (!shouldStreamPreviewToolProgress || previewToolProgressSuppressed || !normalized) {
        return;
      }
      const nextLines = mergeChannelProgressDraftLine(previewToolProgressLines, progressLine, {
        maxLines: resolveChannelProgressDraftMaxLines(progressConfigEntry),
      });
      if (nextLines === previewToolProgressLines) {
        return;
      }
      previewToolProgressLines = nextLines;
      draftStream.update(
        formatChannelProgressDraftText({
          entry: progressConfigEntry,
          lines: previewToolProgressLines,
          seed: progressSeed,
          formatLine: formatMatrixToolProgressMarkdownCode,
          bullet: "-",
          narration: latestPlanExplanation,
          plan: latestPlan,
        }),
      );
      return;
    }
    if (shouldStreamPreviewToolProgress && !previewToolProgressSuppressed && normalized) {
      previewToolProgressLines = mergeChannelProgressDraftLine(
        previewToolProgressLines,
        progressLine,
        {
          maxLines: resolveChannelProgressDraftMaxLines(progressConfigEntry),
        },
      );
    }
    const alreadyStarted = progressDraftGate.hasStarted;
    const progressActive = await progressDraftGate.noteWork();
    if ((alreadyStarted || progressActive) && progressDraftGate.hasStarted) {
      renderProgressDraft();
    }
  };

  const pushPlanProgress = async (steps?: AgentPlanStep[], explanation?: string) => {
    latestPlan = steps?.length ? steps.map((entry) => ({ ...entry })) : undefined;
    latestPlanExplanation = explanation?.replace(/\s+/g, " ").trim() || undefined;
    if (!draftStream || previewToolProgressSuppressed) {
      return;
    }
    if (!progressDraftStreaming) {
      renderProgressDraft();
      return;
    }
    const alreadyStarted = progressDraftGate.hasStarted;
    await progressDraftGate.startNow();
    if (alreadyStarted && progressDraftGate.hasStarted) {
      // An empty-render clear keeps the prior draft visible on purpose:
      // deleting mid-turn drops the edit anchor, and zero-step snapshots
      // only arrive from label:false configs with retracting producers.
      renderProgressDraft();
    }
  };

  const suppressPreviewToolProgressForAnswerText = (text: string | undefined) => {
    if (!text?.trim()) {
      return;
    }
    previewToolProgressSuppressed = true;
    previewToolProgressLines = [];
    latestPlan = undefined;
    latestPlanExplanation = undefined;
  };

  const resetPreviewToolProgress = () => {
    previewToolProgressSuppressed = false;
    previewToolProgressLines = [];
    latestPlan = undefined;
    latestPlanExplanation = undefined;
  };

  const buildPreviewToolProgressReplyOptions = (): Partial<GetReplyOptions> => {
    if (!shouldSuppressDefaultToolProgressMessages) {
      return {};
    }
    const options: Partial<GetReplyOptions> = {
      suppressDefaultToolProgressMessages: true,
    };
    if (!shouldStreamPreviewToolProgress) {
      return options;
    }
    return {
      ...options,
      onToolStart: async (payload) => {
        const toolName = payload.name?.trim();
        await pushPreviewToolProgress(
          buildChannelProgressDraftLineForEntry(
            progressConfigEntry,
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
          { toolName },
        );
      },
      onItemEvent: async (payload) => {
        await pushPreviewToolProgress(
          buildChannelProgressDraftLineForEntry(progressConfigEntry, {
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
      },
      onPlanUpdate: async (payload) => {
        if (payload.phase !== "update") {
          return;
        }
        await pushPlanProgress(payload.steps, payload.explanation);
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
          buildChannelProgressDraftLineForEntry(progressConfigEntry, {
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
      },
      onPatchSummary: async (payload) => {
        if (payload.phase !== "end") {
          return;
        }
        await pushPreviewToolProgress(
          buildChannelProgressDraftLineForEntry(progressConfigEntry, {
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
      },
    };
  };

  const getDisplayableDraftText = () => {
    const nextDraftBoundaryOffset = pendingDraftBoundaries.find(
      (boundary) => boundary.messageGeneration === currentDraftMessageGeneration,
    )?.endOffset;
    if (nextDraftBoundaryOffset === undefined) {
      return latestDraftFullText.slice(currentDraftBlockOffset);
    }
    return latestDraftFullText.slice(currentDraftBlockOffset, nextDraftBoundaryOffset);
  };

  const updateDraftFromLatestFullText = () => {
    const blockText = getDisplayableDraftText();
    if (blockText) {
      draftStream?.update(blockText);
    }
  };

  const queueDraftBlockBoundary = (payload: ReplyPayload, context?: BlockReplyContext) => {
    const payloadTextLength = payload.text?.length ?? 0;
    const messageGeneration = context?.assistantMessageIndex ?? currentDraftMessageGeneration;
    const lastQueuedDraftBoundaryOffset =
      latestQueuedDraftBoundaryOffsets.get(messageGeneration) ?? 0;
    // Logical block boundaries must follow emitted block text, not whichever
    // later partial preview has already arrived by the time the async
    // boundary callback drains.
    const nextDraftBoundaryOffset = lastQueuedDraftBoundaryOffset + payloadTextLength;
    latestQueuedDraftBoundaryOffsets.set(messageGeneration, nextDraftBoundaryOffset);
    pendingDraftBoundaries.push({
      messageGeneration,
      endOffset: nextDraftBoundaryOffset,
    });
  };

  const advanceDraftBlockBoundary = (options?: { fallbackToLatestEnd?: boolean }) => {
    const completedBoundary = pendingDraftBoundaries.shift();
    if (completedBoundary) {
      if (
        !pendingDraftBoundaries.some(
          (entry) => entry.messageGeneration === completedBoundary.messageGeneration,
        )
      ) {
        latestQueuedDraftBoundaryOffsets.delete(completedBoundary.messageGeneration);
      }
      if (completedBoundary.messageGeneration === currentDraftMessageGeneration) {
        currentDraftBlockOffset = completedBoundary.endOffset;
      }
      return;
    }
    if (options?.fallbackToLatestEnd) {
      currentDraftBlockOffset = latestDraftFullText.length;
    }
  };

  const resetDraftBlockOffsets = () => {
    currentDraftMessageGeneration += 1;
    currentDraftBlockOffset = 0;
    latestDraftFullText = "";
  };

  const resetDraftDeliveryState = async () => {
    await draftStream?.discardPending();
    draftStream?.reset();
    draftConsumed = false;
    currentDraftMessageGeneration = 0;
    currentDraftBlockOffset = 0;
    latestDraftFullText = "";
    pendingDraftBoundaries.length = 0;
    latestQueuedDraftBoundaryOffsets.clear();
    currentDraftReplyToId = draftReplyToId;
    progressDraftGate.reset();
    resetPreviewToolProgress();
  };

  return {
    draftStream,
    progressDraftGate,
    buildPreviewToolProgressReplyOptions,
    queueDraftBlockBoundary,
    advanceDraftBlockBoundary,
    resetDraftBlockOffsets,
    resetPreviewToolProgress,
    resetDraftDeliveryState,
    updateDraftFromLatestFullText,
    isDraftConsumed: () => draftConsumed,
    markDraftConsumed: () => {
      draftConsumed = true;
    },
    clearDraftConsumed: () => {
      draftConsumed = false;
    },
    currentReplyToId: () => currentDraftReplyToId,
    setCurrentReplyToId: (replyToId: string | undefined) => {
      currentDraftReplyToId = replyToId;
    },
    resetReplyToIdForNextBlock: () => {
      currentDraftReplyToId = replyToMode === "all" ? draftReplyToId : undefined;
    },
    onPartialReply: (text: string) => {
      if (progressDraftStreaming) {
        return;
      }
      latestDraftFullText = text;
      suppressPreviewToolProgressForAnswerText(text);
      updateDraftFromLatestFullText();
    },
  };
}
