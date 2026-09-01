import {
  type AgentPlanStep,
  buildChannelProgressDraftLineForEntry,
  createChannelProgressDraftCompositor,
  formatChannelProgressDraftLine,
  formatChannelProgressDraftText,
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
  type DraftDisposition = "active" | "retained" | "consumed";
  let draftDisposition: DraftDisposition = "active";

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
  let previewPlan: AgentPlanStep[] | undefined;
  let previewPlanExplanation: string | undefined;
  let previewPlanSuppressed = false;
  const progressConfigEntry = accountConfig ?? cfg.channels?.matrix;
  const progressSeed = `${accountId}:${roomId}`;
  const renderPreviewPlan = (): string =>
    formatChannelProgressDraftText({
      entry: progressConfigEntry,
      lines: [...progressDraft.getSnapshot().lines],
      seed: progressSeed,
      formatLine: formatMatrixToolProgressMarkdownCode,
      bullet: "-",
      narration: previewPlanExplanation,
      plan: previewPlan,
    });
  const progressDraft = createChannelProgressDraftCompositor({
    entry: progressConfigEntry,
    mode: streaming === "quiet" ? "partial" : streaming,
    active: Boolean(draftStream),
    seed: progressSeed,
    formatLine: formatMatrixToolProgressMarkdownCode,
    buildProgressEventLine: (input, options) =>
      input.event === "approval"
        ? formatChannelProgressDraftLine(input, options)
        : buildChannelProgressDraftLineForEntry(progressConfigEntry, input, options),
    update: async (text, options) => {
      const previewText =
        !progressDraftStreaming && (previewPlan || previewPlanExplanation)
          ? renderPreviewPlan()
          : text.replace(/^• /gmu, "- ");
      if (!draftStream) {
        return false;
      }
      draftStream.update(previewText);
      if (options?.flush) {
        await draftStream.flush();
      }
      // A queued update is not visible until Matrix has accepted a draft event.
      return Boolean(draftStream.eventId());
    },
  });

  const resetPreviewToolProgress = () => {
    previewPlan = undefined;
    previewPlanExplanation = undefined;
    previewPlanSuppressed = false;
    progressDraft.reset();
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
        return await progressDraft.pushToolEvent(payload);
      },
      onItemEvent: async (payload) => {
        return await progressDraft.pushItemEvent(payload);
      },
      onPlanUpdate: async (payload) => {
        if (payload.phase !== "update") {
          return false;
        }
        if (progressDraftStreaming) {
          return await progressDraft.pushPlanProgress(payload.steps, {
            explanation: payload.explanation,
          });
        }
        if (!draftStream || previewPlanSuppressed) {
          return false;
        }
        previewPlan = payload.steps?.length
          ? payload.steps.map((step) => ({ ...step }))
          : undefined;
        previewPlanExplanation = payload.explanation?.replace(/\s+/g, " ").trim() || undefined;
        const text = renderPreviewPlan();
        if (text) {
          draftStream.update(text);
        }
        return false;
      },
      onApprovalEvent: async (payload) => {
        return await progressDraft.pushApprovalEvent(payload);
      },
      onCommandOutput: async (payload) => {
        return await progressDraft.pushCommandOutputEvent(payload);
      },
      onPatchSummary: async (payload) => {
        return await progressDraft.pushPatchEvent(payload);
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
    draftDisposition = "active";
    currentDraftMessageGeneration = 0;
    currentDraftBlockOffset = 0;
    latestDraftFullText = "";
    pendingDraftBoundaries.length = 0;
    latestQueuedDraftBoundaryOffsets.clear();
    currentDraftReplyToId = draftReplyToId;
    progressDraft.beginNewTurn({ force: true });
    resetPreviewToolProgress();
  };

  return {
    draftStream,
    cancelProgressDraft: () => progressDraft.cancel(),
    buildPreviewToolProgressReplyOptions,
    queueDraftBlockBoundary,
    advanceDraftBlockBoundary,
    resetDraftBlockOffsets,
    resetPreviewToolProgress,
    resetDraftDeliveryState,
    updateDraftFromLatestFullText,
    draftDisposition: () => draftDisposition,
    beginDraftGeneration: () => {
      draftDisposition = "active";
    },
    markDraftConsumed: () => {
      draftDisposition = "consumed";
    },
    markDraftRetained: () => {
      draftDisposition = "retained";
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
        return false;
      }
      latestDraftFullText = text;
      if (text.trim()) {
        previewPlanSuppressed = true;
        previewPlan = undefined;
        previewPlanExplanation = undefined;
        progressDraft.suppress();
      }
      updateDraftFromLatestFullText();
      return false;
    },
  };
}
