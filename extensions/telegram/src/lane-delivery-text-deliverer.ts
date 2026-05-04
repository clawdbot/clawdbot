import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { TelegramInlineButtons } from "./button-types.js";
import type { TelegramDraftStream } from "./draft-stream.js";
import {
  isRecoverableTelegramNetworkError,
  isSafeToRetrySendError,
  isTelegramClientRejection,
} from "./network-errors.js";

const MESSAGE_NOT_MODIFIED_RE =
  /400:\s*Bad Request:\s*message is not modified|MESSAGE_NOT_MODIFIED/i;
const MESSAGE_NOT_FOUND_RE =
  /400:\s*Bad Request:\s*message to edit not found|MESSAGE_ID_INVALID|message can't be edited/i;
const LONG_LIVED_PREVIEW_FRESH_FINAL_AFTER_MS = 60_000;

function extractErrorText(err: unknown): string {
  return typeof err === "string"
    ? err
    : err instanceof Error
      ? err.message
      : typeof err === "object" && err && "description" in err
        ? typeof err.description === "string"
          ? err.description
          : ""
        : "";
}

function isMessageNotModifiedError(err: unknown): boolean {
  return MESSAGE_NOT_MODIFIED_RE.test(extractErrorText(err));
}

/**
 * Returns true when Telegram rejects an edit because the target message can no
 * longer be resolved or edited. The caller still needs preview context to
 * decide whether to retain a different visible preview or fall back to send.
 */
function isMissingPreviewMessageError(err: unknown): boolean {
  return MESSAGE_NOT_FOUND_RE.test(extractErrorText(err));
}

function isIncompleteFinalPreviewPrefix(previewText: string, finalText: string): boolean {
  const preview = previewText.trimEnd();
  const final = finalText.trimEnd();
  return preview.length > 0 && preview.length < final.length && final.startsWith(preview);
}

export type LaneName = "answer" | "reasoning";

export type DraftLaneState = {
  stream: TelegramDraftStream | undefined;
  lastPartialText: string;
  hasStreamedMessage: boolean;
};

export type ArchivedPreview = {
  messageId: number;
  textSnapshot: string;
  visibleSinceMs?: number;
  // Boundary-finalized previews should remain visible even if no matching
  // final edit arrives; superseded previews can be safely deleted.
  deleteIfUnused?: boolean;
};

export type LanePreviewLifecycle = "transient" | "complete";

export type LaneDeliveryResult =
  | {
      kind: "preview-finalized";
      delivery: {
        content: string;
        messageId?: number;
      };
    }
  | { kind: "preview-retained" | "preview-updated" | "sent" | "skipped" };

type CreateLaneTextDelivererParams = {
  lanes: Record<LaneName, DraftLaneState>;
  archivedAnswerPreviews: ArchivedPreview[];
  activePreviewLifecycleByLane: Record<LaneName, LanePreviewLifecycle>;
  retainPreviewOnCleanupByLane: Record<LaneName, boolean>;
  draftMaxChars: number;
  applyTextToPayload: (payload: ReplyPayload, text: string) => ReplyPayload;
  sendPayload: (payload: ReplyPayload) => Promise<boolean>;
  flushDraftLane: (lane: DraftLaneState) => Promise<void>;
  stopDraftLane: (lane: DraftLaneState) => Promise<void>;
  editPreview: (params: {
    laneName: LaneName;
    messageId: number;
    text: string;
    context: "final" | "update";
    previewButtons?: TelegramInlineButtons;
  }) => Promise<void>;
  deletePreviewMessage: (messageId: number) => Promise<void>;
  log: (message: string) => void;
  markDelivered: () => void;
  now?: () => number;
  // Force fresh final when a visible non-preview message has been delivered
  // since the active preview was created, even if the preview is younger
  // than the long-lived threshold (#76529).
  getLastVisibleNonPreviewDeliveryAtMs?: () => number | undefined;
};

type DeliverLaneTextParams = {
  laneName: LaneName;
  text: string;
  payload: ReplyPayload;
  infoKind: string;
  previewButtons?: TelegramInlineButtons;
  allowPreviewUpdateForNonFinal?: boolean;
};

type TryUpdatePreviewParams = {
  lane: DraftLaneState;
  laneName: LaneName;
  text: string;
  previewButtons?: TelegramInlineButtons;
  stopBeforeEdit?: boolean;
  updateLaneSnapshot?: boolean;
  skipRegressive: "always" | "existingOnly";
  context: "final" | "update";
  previewMessageId?: number;
  previewTextSnapshot?: string;
};

type PreviewEditResult = "edited" | "retained" | "regressive-skipped" | "fallback";

type ConsumeArchivedAnswerPreviewParams = {
  lane: DraftLaneState;
  text: string;
  payload: ReplyPayload;
  previewButtons?: TelegramInlineButtons;
  canEditViaPreview: boolean;
};

type PreviewUpdateContext = "final" | "update";
type RegressiveSkipMode = "always" | "existingOnly";

type ResolvePreviewTargetParams = {
  lane: DraftLaneState;
  previewMessageIdOverride?: number;
  stopBeforeEdit: boolean;
  context: PreviewUpdateContext;
};

type PreviewTargetResolution = {
  hadPreviewMessage: boolean;
  previewMessageId: number | undefined;
  stopCreatesFirstPreview: boolean;
};

function result(
  kind: LaneDeliveryResult["kind"],
  delivery?: Extract<LaneDeliveryResult, { kind: "preview-finalized" }>["delivery"],
): LaneDeliveryResult {
  if (kind === "preview-finalized") {
    return { kind, delivery: delivery! };
  }
  return { kind };
}

function shouldSkipRegressivePreviewUpdate(args: {
  currentPreviewText: string | undefined;
  text: string;
  skipRegressive: RegressiveSkipMode;
  hadPreviewMessage: boolean;
}): boolean {
  const currentPreviewText = args.currentPreviewText;
  if (currentPreviewText === undefined) {
    return false;
  }
  return (
    currentPreviewText.startsWith(args.text) &&
    args.text.length < currentPreviewText.length &&
    (args.skipRegressive === "always" || args.hadPreviewMessage)
  );
}

function isLongLivedPreview(visibleSinceMs: number | undefined, nowMs: number): boolean {
  return (
    typeof visibleSinceMs === "number" &&
    Number.isFinite(visibleSinceMs) &&
    nowMs - visibleSinceMs >= LONG_LIVED_PREVIEW_FRESH_FINAL_AFTER_MS
  );
}

function resolvePreviewTarget(params: ResolvePreviewTargetParams): PreviewTargetResolution {
  const lanePreviewMessageId = params.lane.stream?.messageId();
  const previewMessageId =
    typeof params.previewMessageIdOverride === "number"
      ? params.previewMessageIdOverride
      : lanePreviewMessageId;
  const hadPreviewMessage =
    typeof params.previewMessageIdOverride === "number" || typeof lanePreviewMessageId === "number";
  return {
    hadPreviewMessage,
    previewMessageId: typeof previewMessageId === "number" ? previewMessageId : undefined,
    stopCreatesFirstPreview:
      params.stopBeforeEdit && !hadPreviewMessage && params.context === "final",
  };
}

export function createLaneTextDeliverer(params: CreateLaneTextDelivererParams) {
  const getLanePreviewText = (lane: DraftLaneState) => lane.lastPartialText;
  const readNow = () => params.now?.() ?? Date.now();
  const markActivePreviewComplete = (laneName: LaneName) => {
    params.activePreviewLifecycleByLane[laneName] = "complete";
    params.retainPreviewOnCleanupByLane[laneName] = true;
  };
  const isMessagePreviewLane = (lane: DraftLaneState) => lane.stream != null;
  const wasVisiblyOverwrittenSince = (visibleSinceMs: number | undefined): boolean => {
    if (typeof visibleSinceMs !== "number") {
      return false;
    }
    const lastNonPreviewAt = params.getLastVisibleNonPreviewDeliveryAtMs?.();
    return typeof lastNonPreviewAt === "number" && lastNonPreviewAt > visibleSinceMs;
  };
  const shouldUseFreshFinalForLane = (lane: DraftLaneState) => {
    if (!isMessagePreviewLane(lane)) {
      return false;
    }
    const visibleSinceMs = lane.stream?.visibleSinceMs?.();
    return (
      isLongLivedPreview(visibleSinceMs, readNow()) || wasVisiblyOverwrittenSince(visibleSinceMs)
    );
  };
  const shouldUseFreshFinalForPreview = (lane: DraftLaneState, visibleSinceMs?: number) =>
    isMessagePreviewLane(lane) &&
    (isLongLivedPreview(visibleSinceMs, readNow()) || wasVisiblyOverwrittenSince(visibleSinceMs));
  const clearActivePreviewAfterFreshFinal = async (lane: DraftLaneState, laneName: LaneName) => {
    try {
      await lane.stream?.clear();
    } catch (err) {
      params.log(`telegram: ${laneName} fresh final preview cleanup failed: ${String(err)}`);
    }
    lane.lastPartialText = "";
    lane.hasStreamedMessage = false;
    lane.stream?.forceNewMessage();
  };
  const tryEditPreviewMessage = async (args: {
    laneName: LaneName;
    messageId: number;
    text: string;
    context: "final" | "update";
    previewButtons?: TelegramInlineButtons;
    updateLaneSnapshot: boolean;
    lane: DraftLaneState;
    finalTextAlreadyLanded: boolean;
    retainAlternatePreviewOnMissingTarget: boolean;
    targetPreviewText: string;
  }): Promise<PreviewEditResult> => {
    try {
      await params.editPreview({
        laneName: args.laneName,
        messageId: args.messageId,
        text: args.text,
        previewButtons: args.previewButtons,
        context: args.context,
      });
      if (args.updateLaneSnapshot) {
        args.lane.lastPartialText = args.text;
      }
      params.markDelivered();
      return "edited";
    } catch (err) {
      if (isMessageNotModifiedError(err)) {
        params.log(
          `telegram: ${args.laneName} preview ${args.context} edit returned "message is not modified"; treating as delivered`,
        );
        params.markDelivered();
        return "edited";
      }
      if (args.context === "final") {
        if (args.finalTextAlreadyLanded) {
          params.log(
            `telegram: ${args.laneName} preview final edit failed after stop flush; keeping existing preview (${String(err)})`,
          );
          params.markDelivered();
          return "retained";
        }
        if (isSafeToRetrySendError(err)) {
          params.log(
            `telegram: ${args.laneName} preview final edit failed before reaching Telegram; falling back to standard send (${String(err)})`,
          );
          return "fallback";
        }
        if (isMissingPreviewMessageError(err)) {
          if (args.retainAlternatePreviewOnMissingTarget) {
            params.log(
              `telegram: ${args.laneName} preview final edit target missing; keeping alternate preview without fallback (${String(err)})`,
            );
            params.markDelivered();
            return "retained";
          }
          params.log(
            `telegram: ${args.laneName} preview final edit target missing with no alternate preview; falling back to standard send (${String(err)})`,
          );
          return "fallback";
        }
        if (isRecoverableTelegramNetworkError(err, { allowMessageMatch: true })) {
          params.log(
            `telegram: ${args.laneName} preview final edit may have landed despite network error; keeping existing preview (${String(err)})`,
          );
          params.markDelivered();
          return "retained";
        }
        if (isTelegramClientRejection(err)) {
          params.log(
            `telegram: ${args.laneName} preview final edit rejected by Telegram (client error); falling back to standard send (${String(err)})`,
          );
          return "fallback";
        }
        if (isIncompleteFinalPreviewPrefix(args.targetPreviewText, args.text)) {
          params.log(
            `telegram: ${args.laneName} preview final edit failed and existing preview is an incomplete prefix; falling back to standard send (${String(err)})`,
          );
          return "fallback";
        }
        // Default: ambiguous error — retain when fallback may duplicate a final
        // edit that already landed or when the preview is not known-incomplete.
        params.log(
          `telegram: ${args.laneName} preview final edit failed with ambiguous error; keeping existing preview to avoid duplicate (${String(err)})`,
        );
        params.markDelivered();
        return "retained";
      }
      params.log(
        `telegram: ${args.laneName} preview ${args.context} edit failed; falling back to standard send (${String(err)})`,
      );
      return "fallback";
    }
  };

  const tryUpdatePreviewForLane = async ({
    lane,
    laneName,
    text,
    previewButtons,
    stopBeforeEdit = false,
    updateLaneSnapshot = false,
    skipRegressive,
    context,
    previewMessageId: previewMessageIdOverride,
    previewTextSnapshot,
  }: TryUpdatePreviewParams): Promise<PreviewEditResult> => {
    const editPreview = (
      messageId: number,
      finalTextAlreadyLanded: boolean,
      retainAlternatePreviewOnMissingTarget: boolean,
      targetPreviewText: string,
    ) =>
      tryEditPreviewMessage({
        laneName,
        messageId,
        text,
        context,
        previewButtons,
        updateLaneSnapshot,
        lane,
        finalTextAlreadyLanded,
        retainAlternatePreviewOnMissingTarget,
        targetPreviewText,
      });
    const finalizePreview = (
      previewMessageId: number,
      finalTextAlreadyLanded: boolean,
      hadPreviewMessage: boolean,
      retainAlternatePreviewOnMissingTarget = false,
    ): PreviewEditResult | Promise<PreviewEditResult> => {
      const currentPreviewText = previewTextSnapshot ?? getLanePreviewText(lane);
      const shouldSkipRegressive = shouldSkipRegressivePreviewUpdate({
        currentPreviewText,
        text,
        skipRegressive,
        hadPreviewMessage,
      });
      if (shouldSkipRegressive) {
        params.markDelivered();
        return "regressive-skipped";
      }
      return editPreview(
        previewMessageId,
        finalTextAlreadyLanded,
        retainAlternatePreviewOnMissingTarget,
        currentPreviewText,
      );
    };
    if (!lane.stream) {
      return "fallback";
    }
    const previewTargetBeforeStop = resolvePreviewTarget({
      lane,
      previewMessageIdOverride,
      stopBeforeEdit,
      context,
    });
    if (previewTargetBeforeStop.stopCreatesFirstPreview && lane.hasStreamedMessage) {
      // Final stop() can create the first visible preview message.
      // Prime pending text so the stop flush sends the final text snapshot.
      lane.stream.update(text);
      await params.stopDraftLane(lane);
      const previewTargetAfterStop = resolvePreviewTarget({
        lane,
        stopBeforeEdit: false,
        context,
      });
      if (typeof previewTargetAfterStop.previewMessageId !== "number") {
        return "fallback";
      }
      return finalizePreview(previewTargetAfterStop.previewMessageId, true, false);
    }
    if (stopBeforeEdit) {
      await params.stopDraftLane(lane);
    }
    const previewTargetAfterStop = resolvePreviewTarget({
      lane,
      previewMessageIdOverride,
      stopBeforeEdit: false,
      context,
    });
    if (typeof previewTargetAfterStop.previewMessageId !== "number") {
      // Only retain for final delivery when a prior preview is already visible
      // to the user — otherwise falling back is safer than silence. For updates,
      // always fall back so the caller can attempt sendPayload without stale
      // markDelivered() state.
      if (context === "final" && lane.hasStreamedMessage && lane.stream?.sendMayHaveLanded?.()) {
        params.log(
          `telegram: ${laneName} preview send may have landed despite missing message id; keeping to avoid duplicate`,
        );
        params.markDelivered();
        return "retained";
      }
      return "fallback";
    }
    const activePreviewMessageId = lane.stream?.messageId();
    return finalizePreview(
      previewTargetAfterStop.previewMessageId,
      false,
      previewTargetAfterStop.hadPreviewMessage,
      typeof activePreviewMessageId === "number" &&
        activePreviewMessageId !== previewTargetAfterStop.previewMessageId,
    );
  };

  const consumeArchivedAnswerPreviewForFinal = async ({
    lane,
    text,
    payload,
    previewButtons,
    canEditViaPreview,
  }: ConsumeArchivedAnswerPreviewParams): Promise<LaneDeliveryResult | undefined> => {
    const archivedPreview = params.archivedAnswerPreviews.shift();
    if (!archivedPreview) {
      return undefined;
    }
    if (canEditViaPreview && shouldUseFreshFinalForPreview(lane, archivedPreview.visibleSinceMs)) {
      const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
      if (delivered) {
        try {
          await params.deletePreviewMessage(archivedPreview.messageId);
        } catch (err) {
          params.log(
            `telegram: archived answer preview cleanup failed (${archivedPreview.messageId}): ${String(err)}`,
          );
        }
        return result("sent");
      }
    }
    if (canEditViaPreview) {
      const finalized = await tryUpdatePreviewForLane({
        lane,
        laneName: "answer",
        text,
        previewButtons,
        stopBeforeEdit: false,
        skipRegressive: "existingOnly",
        context: "final",
        previewMessageId: archivedPreview.messageId,
        previewTextSnapshot: archivedPreview.textSnapshot,
      });
      if (finalized === "edited") {
        return result("preview-finalized", {
          content: text,
          messageId: archivedPreview.messageId,
        });
      }
      if (finalized === "regressive-skipped") {
        return result("preview-finalized", {
          content: archivedPreview.textSnapshot,
          messageId: archivedPreview.messageId,
        });
      }
      if (finalized === "retained") {
        params.retainPreviewOnCleanupByLane.answer = true;
        return result("preview-retained");
      }
    }
    // Send the replacement message first, then clean up the old preview.
    // This avoids the visual "disappear then reappear" flash.
    const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
    // Once this archived preview is consumed by a fallback final send, delete it
    // regardless of deleteIfUnused. That flag only applies to unconsumed boundaries.
    if (delivered || archivedPreview.deleteIfUnused !== false) {
      try {
        await params.deletePreviewMessage(archivedPreview.messageId);
      } catch (err) {
        params.log(
          `telegram: archived answer preview cleanup failed (${archivedPreview.messageId}): ${String(err)}`,
        );
      }
    }
    return delivered ? result("sent") : result("skipped");
  };

  return async ({
    laneName,
    text,
    payload,
    infoKind,
    previewButtons,
    allowPreviewUpdateForNonFinal = false,
  }: DeliverLaneTextParams): Promise<LaneDeliveryResult> => {
    const lane = params.lanes[laneName];
    const reply = resolveSendableOutboundReplyParts(payload, { text });
    const hasMedia = reply.hasMedia;
    const canEditViaPreview =
      !hasMedia && text.length > 0 && text.length <= params.draftMaxChars && !payload.isError;

    if (infoKind === "final") {
      // Transient previews must decide cleanup retention per final attempt.
      // Completed previews intentionally stay retained so later extra payloads
      // do not clear the already-finalized message.
      if (params.activePreviewLifecycleByLane[laneName] === "transient") {
        params.retainPreviewOnCleanupByLane[laneName] = false;
      }
      if (laneName === "answer") {
        const archivedResult = await consumeArchivedAnswerPreviewForFinal({
          lane,
          text,
          payload,
          previewButtons,
          canEditViaPreview,
        });
        if (archivedResult) {
          return archivedResult;
        }
      }
      if (canEditViaPreview && params.activePreviewLifecycleByLane[laneName] === "transient") {
        await params.flushDraftLane(lane);
        if (laneName === "answer") {
          const archivedResultAfterFlush = await consumeArchivedAnswerPreviewForFinal({
            lane,
            text,
            payload,
            previewButtons,
            canEditViaPreview,
          });
          if (archivedResultAfterFlush) {
            return archivedResultAfterFlush;
          }
        }
        if (shouldUseFreshFinalForLane(lane)) {
          await params.stopDraftLane(lane);
          const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
          if (delivered) {
            await clearActivePreviewAfterFreshFinal(lane, laneName);
            return result("sent");
          }
        }
        const previewMessageId = lane.stream?.messageId();
        const finalized = await tryUpdatePreviewForLane({
          lane,
          laneName,
          text,
          previewButtons,
          stopBeforeEdit: true,
          skipRegressive: "existingOnly",
          context: "final",
        });
        if (finalized === "edited") {
          markActivePreviewComplete(laneName);
          return result("preview-finalized", {
            content: text,
            messageId: previewMessageId ?? lane.stream?.messageId(),
          });
        }
        if (finalized === "regressive-skipped") {
          markActivePreviewComplete(laneName);
          return result("preview-finalized", {
            content: lane.lastPartialText,
            messageId: previewMessageId ?? lane.stream?.messageId(),
          });
        }
        if (finalized === "retained") {
          markActivePreviewComplete(laneName);
          return result("preview-retained");
        }
      } else if (!hasMedia && !payload.isError && text.length > params.draftMaxChars) {
        params.log(
          `telegram: preview final too long for edit (${text.length} > ${params.draftMaxChars}); falling back to standard send`,
        );
      }
      await params.stopDraftLane(lane);
      const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
      return delivered ? result("sent") : result("skipped");
    }

    if (allowPreviewUpdateForNonFinal && canEditViaPreview) {
      const updated = await tryUpdatePreviewForLane({
        lane,
        laneName,
        text,
        previewButtons,
        stopBeforeEdit: false,
        updateLaneSnapshot: true,
        skipRegressive: "always",
        context: "update",
      });
      if (updated === "edited" || updated === "regressive-skipped") {
        return result("preview-updated");
      }
    }

    const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
    return delivered ? result("sent") : result("skipped");
  };
}
