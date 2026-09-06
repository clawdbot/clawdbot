import { createChannelProgressDraftCompositor } from "openclaw/plugin-sdk/channel-outbound";
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
  // FIFO of generations captured at the moment each tool result was actually
  // queued for delivery (see onToolResultQueued in handler-reply-dispatcher.ts),
  // not read fresh inside deliver() -- the shared dispatcher's send queue can
  // delay a tool's own deliver() call well past when a fast-following
  // assistant message already bumped currentDraftMessageGeneration, which
  // would otherwise make deliver()'s own late read of "current" indistinguishable
  // from "this tool's own". Queued deliveries settle in submission order (the
  // shared dispatcher's sendChain preserves it), so a plain FIFO correctly
  // pairs each deliver() call with its own tool result's real dispatch-time
  // generation.
  const pendingToolDispatchGenerations: number[] = [];
  const pendingDraftBoundaries: PendingDraftBoundary[] = [];
  const latestQueuedDraftBoundaryOffsets = new Map<number, number>();
  let currentDraftReplyToId = draftReplyToId;
  const progressConfigEntry = accountConfig ?? cfg.channels?.matrix;
  const progressSeed = `${accountId}:${roomId}`;
  const progressDraft = createChannelProgressDraftCompositor({
    entry: progressConfigEntry,
    mode: streaming === "quiet" ? "partial" : streaming,
    active: Boolean(draftStream),
    seed: progressSeed,
    formatLine: formatMatrixToolProgressMarkdownCode,
    update: async (text, options) => {
      const previewText = text.replace(/^• /gmu, "- ");
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
    deleteCurrent: () => draftStream?.deleteCurrentMessage(),
  });

  const buildPreviewToolProgressReplyOptions = (): Partial<GetReplyOptions> => {
    if (!shouldSuppressDefaultToolProgressMessages) {
      return {};
    }
    return {
      suppressDefaultToolProgressMessages: true,
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
        return await progressDraft.pushPlanProgress(payload.steps, {
          explanation: payload.explanation,
        });
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

  /**
   * Flush and finalize a still-active draft generation before it's
   * abandoned. Returns whether the stream is safe to reset for a fresh
   * generation.
   *
   * No-ops (returns true) unless disposition is "active": the block/final
   * settlement branch already marks the draft consumed or retained once it
   * finalizes-in-place or redacts/replaces it, including the editFinal path
   * that edits the real final text directly and bypasses draftStream's own
   * send cache. Re-running finalizeLive() there would use that stale cached
   * text and silently republish it over the already-delivered final content.
   *
   * Returns false when mustDeliverFinalNormally() is true afterward (the
   * flush or the live-marker edit itself failed): the event id and that
   * failure state must stay intact so a later final/block delivery's
   * existing redact-or-replace handling can find and clean up this preview.
   * Resetting here would strand it, live and orphaned, with nothing left
   * pointing at it.
   */
  const settleDraftGeneration = async (): Promise<boolean> => {
    if (!draftStream || draftDisposition !== "active") {
      return true;
    }
    // Flush before abandoning this draft generation: a bare reset() drops any
    // still-pending throttled edit and permanently orphans the draft event at
    // whatever partial text was last actually sent — live marker and all —
    // since no later delivery kind reopens or redacts it once the model has
    // moved on (e.g. into a tool call, or a newly admitted followup).
    await draftStream.stop();
    await draftStream.finalizeLive();
    return !draftStream.mustDeliverFinalNormally();
  };

  /** Records the generation active at the moment a tool result was actually
   * queued for delivery (see onToolResultQueued). Called synchronously,
   * before the shared dispatcher's send queue can introduce any delay. */
  const pushPendingToolDispatchGeneration = () => {
    pendingToolDispatchGenerations.push(currentDraftMessageGeneration);
  };

  /** Consumes the oldest queued dispatch-time generation, in submission
   * order. Falls back to the live generation (today's pre-fix behavior,
   * never worse) if the queue is empty -- e.g. a tool result delivered
   * through a path that bypasses onToolResultQueued entirely. */
  const takeNextPendingToolDispatchGeneration = (): number => {
    const queued = pendingToolDispatchGenerations.shift();
    return queued ?? currentDraftMessageGeneration;
  };

  /**
   * Settles the draft on behalf of a tool dispatch, but only if the draft is
   * still on the exact generation that was active when the tool call was
   * issued. Matrix delivery of the tool's own payload can be enqueued
   * without awaiting completion, so a fast-following assistant message can
   * already have started (and be streaming its own new partial text into
   * this same draft) by the time this settlement callback finally runs.
   * Finalizing and resetting in that case would stop and clear a generation
   * that isn't this tool call's to own, corrupting or losing the newer
   * text; leave it alone and let that newer generation's own eventual
   * delivery settle it instead.
   */
  const settleDraftForToolDispatch = async (expectedGeneration: number) => {
    if (!draftStream || currentDraftMessageGeneration !== expectedGeneration) {
      return;
    }
    if (!(await settleDraftGeneration())) {
      return;
    }
    // stop() marks the stream final, which makes every later update() a
    // no-op — reset it so the next text segment gets a fresh draft message,
    // but keep the current reply target: a tool dispatch must not reset
    // threading the way a new logical block would (the draft still owes its
    // reply to whatever the in-flight turn originally targeted).
    draftStream.reset({ keepReplyTarget: true });
  };

  const resetDraftDeliveryState = async () => {
    if (await settleDraftGeneration()) {
      draftStream?.reset();
    }
    draftDisposition = "active";
    currentDraftMessageGeneration = 0;
    currentDraftBlockOffset = 0;
    latestDraftFullText = "";
    pendingDraftBoundaries.length = 0;
    latestQueuedDraftBoundaryOffsets.clear();
    // pendingToolDispatchGenerations is deliberately NOT cleared here: a tool
    // dispatched before this reset (e.g. from the turn a just-admitted queued
    // followup interrupts) can still be sitting in the shared dispatcher's
    // send queue, with its own real entry still due. Its ordering relative to
    // this turn's own future pushes is unaffected by resetting the *draft's*
    // generation/display state -- deliver()/onError still consume entries in
    // the same order they were queued, so clearing here would only strand
    // that still-pending tool's deliver() with an empty queue, making it fall
    // back to (by then wrong) "current" generation and risk finalizing a
    // newer, unrelated draft. See takeNextPendingToolDispatchGeneration.
    currentDraftReplyToId = draftReplyToId;
    progressDraft.beginNewTurn({ force: true });
  };

  return {
    draftStream,
    cancelProgressDraft: () => progressDraft.cancel(),
    buildPreviewToolProgressReplyOptions,
    currentGeneration: () => currentDraftMessageGeneration,
    queueDraftBlockBoundary,
    advanceDraftBlockBoundary,
    resetDraftBlockOffsets,
    beginAssistantMessage: () => progressDraft.beginAssistantMessage(),
    resetDraftDeliveryState,
    settleDraftGeneration,
    settleDraftForToolDispatch,
    pushPendingToolDispatchGeneration,
    takeNextPendingToolDispatchGeneration,
    updateDraftFromLatestFullText,
    draftDisposition: () => draftDisposition,
    beginDraftGeneration: () => {
      draftDisposition = "active";
      progressDraft.resetActivity();
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
        progressDraft.resetActivity({ suppressed: true });
      }
      updateDraftFromLatestFullText();
      return false;
    },
  };
}
