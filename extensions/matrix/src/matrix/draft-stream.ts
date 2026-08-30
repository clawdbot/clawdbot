// Matrix plugin module implements draft stream behavior.
import { randomUUID } from "node:crypto";
import { createFinalizableDraftStreamControlsForState } from "openclaw/plugin-sdk/channel-outbound";
import type { CoreConfig } from "../types.js";
import {
  buildMatrixOpenClawPreviewContent,
  type MatrixOpenClawPreviewKind,
  type MatrixOpenClawPreviewMarker,
  type MatrixOpenClawPreviewState,
} from "./preview-protocol.js";
import type { MatrixClient } from "./sdk.js";
import { editMessageMatrix, prepareMatrixSingleText, sendSingleTextMessageMatrix } from "./send.js";
import { MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY, MsgType } from "./send/types.js";

const DEFAULT_THROTTLE_MS = 1000;
type MatrixDraftPreviewMode = "partial" | "quiet";

function resolveDraftPreviewOptions(mode: MatrixDraftPreviewMode): {
  msgtype: typeof MsgType.Text | typeof MsgType.Notice;
  includeMentions?: boolean;
} {
  if (mode === "quiet") {
    return {
      msgtype: MsgType.Notice,
      includeMentions: false,
    };
  }
  // Drafts can contain partial model text and raw tool-progress paths; keep
  // Matrix mentions inert until callers send a normal final message.
  return {
    msgtype: MsgType.Text,
    includeMentions: false,
  };
}

type MatrixDraftStream = {
  /** Update the draft with the latest accumulated text for the current block. */
  update: (text: string) => void;
  /** Ensure the last pending update has been sent. */
  flush: () => Promise<void>;
  /** Flush and mark this block as done. Returns the event ID if a message was sent. */
  stop: () => Promise<string | undefined>;
  /** Cancel pending draft updates without creating a new preview event. */
  discardPending: () => Promise<void>;
  /** Clear the MSC4357 live marker in place when the draft is kept as final text. */
  finalizeLive: () => Promise<boolean>;
  /** Finalize with the canonical answer text and protocol marker. */
  finalize: (text: string, options?: { includeMentions?: boolean }) => Promise<boolean>;
  /** Close the lineage without promoting it as a completed agent message. */
  abandon: () => Promise<void>;
  /** Mark subsequent updates as answer text or non-answer progress. */
  setKind: (kind: MatrixOpenClawPreviewKind) => void;
  /** Current OpenClaw protocol lineage, when enhanced turn-taking is active. */
  responseId: () => string | undefined;
  /** Reset state for the next text block (after tool calls). */
  reset: () => void;
  /** The event ID of the current draft message, if any. */
  eventId: () => string | undefined;
  /** The last content accepted for the current draft event, if any. */
  content: () => string | undefined;
  /** True when the provided text matches the last rendered draft payload. */
  matchesPreparedText: (text: string) => boolean;
  /** True when preview streaming must fall back to normal final delivery. */
  mustDeliverFinalNormally: () => boolean;
};

export function createMatrixDraftStream(params: {
  roomId: string;
  client: MatrixClient;
  cfg: CoreConfig;
  mode?: MatrixDraftPreviewMode;
  threadId?: string;
  replyToId?: string;
  /** When true, reset() restores the original replyToId instead of clearing it. */
  preserveReplyId?: boolean;
  accountId?: string;
  log?: (message: string) => void;
  protocol?: {
    triggerEventId: string;
    threadId?: string;
    replyToId?: string;
    createResponseId?: () => string;
    onUpdate: (update: {
      originalEventId: string;
      sourceEventId: string;
      marker: MatrixOpenClawPreviewMarker;
      body: string;
    }) => Promise<void> | void;
  };
}): MatrixDraftStream {
  const { roomId, client, cfg, threadId, accountId, log } = params;
  const preview = resolveDraftPreviewOptions(params.mode ?? "partial");
  // MSC4357 live markers are only useful for "partial" mode where users see
  // the draft evolve. "quiet" mode uses m.notice for background previews
  // where a streaming animation would be unexpected.
  const useLive = params.mode !== "quiet";

  let currentEventId: string | undefined;
  let lastSentText = "";
  let lastSentContent = "";
  const streamState = { stopped: false, final: false };
  let sendFailed = false;
  let finalizeInPlaceBlocked = false;
  let liveFinalized = false;
  let replyToId = params.replyToId;
  let previewKind: MatrixOpenClawPreviewKind = "progress";
  let lastSentKind: MatrixOpenClawPreviewKind | undefined;
  let protocolRevision = 0;
  let responseId = params.protocol?.createResponseId?.() ?? randomUUID();

  const buildProtocolMarker = (
    state: MatrixOpenClawPreviewState,
    revision: number,
    kind = previewKind,
  ): MatrixOpenClawPreviewMarker | undefined =>
    params.protocol
      ? {
          v: 1,
          responseId,
          triggerEventId: params.protocol.triggerEventId,
          state,
          revision,
          kind,
          ...(params.protocol.threadId ? { threadId: params.protocol.threadId } : {}),
          ...(params.protocol.replyToId ? { replyToId: params.protocol.replyToId } : {}),
        }
      : undefined;

  const notifyProtocolUpdate = async (paramsLocal: {
    sourceEventId: string;
    marker?: MatrixOpenClawPreviewMarker;
    body: string;
  }) => {
    if (!params.protocol || !paramsLocal.marker || !currentEventId) {
      return;
    }
    try {
      await params.protocol.onUpdate({
        originalEventId: currentEventId,
        sourceEventId: paramsLocal.sourceEventId,
        marker: paramsLocal.marker,
        body: paramsLocal.body,
      });
    } catch (error) {
      // Matrix has already accepted this event. Local observation failure must
      // never turn a successful wire send/edit into duplicate fallback output.
      log?.(`draft-stream: protocol observation failed after accepted send: ${String(error)}`);
    }
  };

  const sendOrEdit = async (text: string): Promise<boolean> => {
    const trimmed = text.trimEnd();
    if (!trimmed.trim()) {
      return false;
    }
    const preparedText = prepareMatrixSingleText(trimmed, {
      cfg,
      accountId,
      preserveWhitespace: true,
    });
    if (!preparedText.fitsInSingleEvent) {
      finalizeInPlaceBlocked = true;
      if (!currentEventId) {
        sendFailed = true;
      }
      streamState.stopped = true;
      log?.(
        `draft-stream: preview exceeded single-event limit (${preparedText.convertedText.length} > ${preparedText.singleEventLimit})`,
      );
      return false;
    }
    if (sendFailed) {
      return false;
    }
    if (preparedText.trimmedText === lastSentText && previewKind === lastSentKind) {
      return true;
    }
    try {
      if (!currentEventId) {
        const marker = buildProtocolMarker("in-progress", 0);
        const result = await sendSingleTextMessageMatrix(roomId, preparedText.trimmedText, {
          client,
          cfg,
          replyToId,
          threadId,
          accountId,
          msgtype: preview.msgtype,
          includeMentions: preview.includeMentions,
          live: useLive,
          ...(marker ? { extraContent: buildMatrixOpenClawPreviewContent(marker) } : {}),
        });
        currentEventId = result.messageId;
        protocolRevision = 0;
        lastSentText = preparedText.trimmedText;
        lastSentContent = preparedText.convertedText;
        lastSentKind = previewKind;
        await notifyProtocolUpdate({
          sourceEventId: result.messageId,
          marker,
          body: preparedText.convertedText,
        });
        log?.(`draft-stream: created message ${currentEventId}${useLive ? " (MSC4357 live)" : ""}`);
      } else {
        const nextRevision = protocolRevision + 1;
        const marker = buildProtocolMarker("in-progress", nextRevision);
        const editEventId = await editMessageMatrix(
          roomId,
          currentEventId,
          preparedText.trimmedText,
          {
            client,
            cfg,
            threadId,
            accountId,
            msgtype: preview.msgtype,
            includeMentions: preview.includeMentions,
            live: useLive,
            ...(marker ? { extraContent: buildMatrixOpenClawPreviewContent(marker) } : {}),
          },
        );
        protocolRevision = nextRevision;
        lastSentText = preparedText.trimmedText;
        lastSentContent = preparedText.convertedText;
        lastSentKind = previewKind;
        await notifyProtocolUpdate({
          sourceEventId: editEventId,
          marker,
          body: preparedText.convertedText,
        });
      }
      return true;
    } catch (err) {
      log?.(`draft-stream: send/edit failed: ${String(err)}`);
      const isPreviewLimitError =
        err instanceof Error && err.message.startsWith("Matrix single-message text exceeds limit");
      if (isPreviewLimitError) {
        finalizeInPlaceBlocked = true;
      }
      if (!currentEventId) {
        sendFailed = true;
      }
      streamState.stopped = true;
      return false;
    }
  };

  const {
    loop,
    update,
    stop: stopDraft,
    discardPending,
  } = createFinalizableDraftStreamControlsForState({
    throttleMs: DEFAULT_THROTTLE_MS,
    state: streamState,
    sendOrEditStreamMessage: sendOrEdit,
  });

  log?.(`draft-stream: ready (throttleMs=${DEFAULT_THROTTLE_MS})`);

  const finalize = async (
    text: string,
    options?: { includeMentions?: boolean },
  ): Promise<boolean> => {
    const preparedText = prepareMatrixSingleText(text.trimEnd(), {
      cfg,
      accountId,
      preserveWhitespace: true,
    });
    if (!currentEventId || !preparedText.trimmedText.trim() || !preparedText.fitsInSingleEvent) {
      finalizeInPlaceBlocked = true;
      return false;
    }
    if (liveFinalized) {
      return true;
    }
    const nextRevision = protocolRevision + 1;
    const marker = buildProtocolMarker("final", nextRevision, "answer");
    const extraContent = {
      ...(params.mode === "quiet" ? { [MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY]: true } : {}),
      ...(marker ? buildMatrixOpenClawPreviewContent(marker) : {}),
    };
    liveFinalized = true;
    try {
      const editEventId = await editMessageMatrix(
        roomId,
        currentEventId,
        preparedText.trimmedText,
        {
          client,
          cfg,
          threadId,
          accountId,
          msgtype: preview.msgtype,
          // Block and quiet-preview edits remain inert; an ordinary terminal
          // edit can opt into authoritative Matrix mention metadata.
          includeMentions: options?.includeMentions ?? preview.includeMentions,
          extraContent,
          live: false,
        },
      );
      protocolRevision = nextRevision;
      previewKind = "answer";
      lastSentKind = "answer";
      lastSentText = preparedText.trimmedText;
      lastSentContent = preparedText.convertedText;
      await notifyProtocolUpdate({
        sourceEventId: editEventId,
        marker,
        body: preparedText.convertedText,
      });
      log?.(`draft-stream: finalized ${currentEventId} (MSC4357 stream ended)`);
      return true;
    } catch (err) {
      log?.(`draft-stream: finalize edit failed: ${String(err)}`);
      finalizeInPlaceBlocked = true;
      liveFinalized = false;
      return false;
    }
  };

  const finalizeLive = async (): Promise<boolean> => {
    // Send a final edit without the MSC4357 live marker to signal that
    // the stream is complete. Supporting clients will stop the streaming
    // animation and display the final content.
    if (useLive && !liveFinalized && currentEventId && lastSentText) {
      return await finalize(lastSentText);
    }
    return true;
  };

  const abandon = async (options?: { isSourceLive?: () => boolean }): Promise<void> => {
    await discardPending();
    streamState.stopped = true;
    streamState.final = true;
    if (!params.protocol || !currentEventId || !lastSentText || liveFinalized) {
      return;
    }
    const nextRevision = protocolRevision + 1;
    const marker = buildProtocolMarker("abandoned", nextRevision);
    try {
      // The source owner may retire while pending draft work drains. Recheck its
      // exact lifecycle immediately before the Matrix cleanup edit.
      if (options?.isSourceLive?.() === false) {
        return;
      }
      const editEventId = await editMessageMatrix(roomId, currentEventId, lastSentText, {
        client,
        cfg,
        threadId,
        accountId,
        msgtype: preview.msgtype,
        includeMentions: preview.includeMentions,
        ...(marker ? { extraContent: buildMatrixOpenClawPreviewContent(marker) } : {}),
        live: false,
      });
      protocolRevision = nextRevision;
      await notifyProtocolUpdate({ sourceEventId: editEventId, marker, body: lastSentContent });
    } catch (err) {
      log?.(`draft-stream: abandon edit failed: ${String(err)}`);
      // The caller still redacts the root. Record the local tombstone even
      // when the best-effort wire edit is unavailable.
      await notifyProtocolUpdate({ sourceEventId: currentEventId, marker, body: lastSentContent });
    }
  };

  const stop = async (): Promise<string | undefined> => {
    await stopDraft();
    return currentEventId;
  };

  const reset = (): void => {
    // Clear reply context unless preserveReplyId is set (replyToMode "all"),
    // in which case subsequent blocks should keep replying to the original.
    replyToId = params.preserveReplyId ? params.replyToId : undefined;
    currentEventId = undefined;
    lastSentText = "";
    lastSentContent = "";
    streamState.stopped = false;
    streamState.final = false;
    sendFailed = false;
    finalizeInPlaceBlocked = false;
    liveFinalized = false;
    lastSentKind = undefined;
    previewKind = "progress";
    protocolRevision = 0;
    responseId = params.protocol?.createResponseId?.() ?? randomUUID();
    loop.resetPending();
    loop.resetThrottleWindow();
  };

  return {
    update,
    flush: loop.flush,
    stop,
    discardPending,
    finalizeLive,
    finalize,
    abandon,
    setKind: (kind) => {
      previewKind = kind;
    },
    responseId: () => (params.protocol ? responseId : undefined),
    reset,
    eventId: () => currentEventId,
    content: () => lastSentContent || undefined,
    matchesPreparedText: (text: string) =>
      prepareMatrixSingleText(text.trimEnd(), {
        cfg,
        accountId,
        preserveWhitespace: true,
      }).trimmedText === lastSentText,
    mustDeliverFinalNormally: () => sendFailed || finalizeInPlaceBlocked,
  };
}
