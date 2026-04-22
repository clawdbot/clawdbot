import { createDraftStreamLoop } from "openclaw/plugin-sdk/channel-lifecycle";
import type { CoreConfig } from "../types.js";
import type { MatrixClient } from "./sdk.js";
import { editMessageMatrix, prepareMatrixSingleText, sendSingleTextMessageMatrix } from "./send.js";
import { MsgType } from "./send/types.js";

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
  return {
    msgtype: MsgType.Text,
  };
}

export type MatrixDraftStream = {
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
  /** Reset state for the next text block (after tool calls). */
  reset: () => void;
  /** The event ID of the current draft message, if any. */
  eventId: () => string | undefined;
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
}): MatrixDraftStream {
  const { roomId, client, cfg, threadId, accountId, log } = params;
  const preview = resolveDraftPreviewOptions(params.mode ?? "partial");
  // MSC4357 live markers are only useful for "partial" mode where users see
  // the draft evolve. "quiet" mode uses m.notice for background previews
  // where a streaming animation would be unexpected.
  const useLive = params.mode !== "quiet";

  let currentEventId: string | undefined;
  let lastSentText = "";
  let stopped = false;
  let sendFailed = false;
  let finalizeInPlaceBlocked = false;
  let liveFinalized = false;
  let replyToId = params.replyToId;

  const sendOrEdit = async (text: string): Promise<boolean> => {
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    const preparedText = prepareMatrixSingleText(trimmed, { cfg, accountId });
    if (!preparedText.fitsInSingleEvent) {
      finalizeInPlaceBlocked = true;
      if (!currentEventId) {
        sendFailed = true;
      }
      stopped = true;
      log?.(
        `draft-stream: preview exceeded single-event limit (${preparedText.convertedText.length} > ${preparedText.singleEventLimit})`,
      );
      return false;
    }
    if (sendFailed) {
      return false;
    }
    if (preparedText.trimmedText === lastSentText) {
      return true;
    }
    try {
      if (!currentEventId) {
        const result = await sendSingleTextMessageMatrix(roomId, preparedText.trimmedText, {
          client,
          cfg,
          replyToId,
          threadId,
          accountId,
          msgtype: preview.msgtype,
          includeMentions: preview.includeMentions,
          live: useLive,
        });
        currentEventId = result.messageId;
        lastSentText = preparedText.trimmedText;
        log?.(`draft-stream: created message ${currentEventId}${useLive ? " (MSC4357 live)" : ""}`);
      } else {
        await editMessageMatrix(roomId, currentEventId, preparedText.trimmedText, {
          client,
          cfg,
          threadId,
          accountId,
          msgtype: preview.msgtype,
          includeMentions: preview.includeMentions,
          live: useLive,
        });
        lastSentText = preparedText.trimmedText;
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
      stopped = true;
      return false;
    }
  };

  const loop = createDraftStreamLoop({
    throttleMs: DEFAULT_THROTTLE_MS,
    isStopped: () => stopped,
    sendOrEditStreamMessage: sendOrEdit,
  });

  log?.(`draft-stream: ready (throttleMs=${DEFAULT_THROTTLE_MS})`);

  const finalizeLive = async (): Promise<boolean> => {
    // Send a final edit without the MSC4357 live marker to signal that
    // the stream is complete. Supporting clients will stop the streaming
    // animation and display the final content.
    if (useLive && !liveFinalized && currentEventId && lastSentText) {
      liveFinalized = true;
      try {
        await editMessageMatrix(roomId, currentEventId, lastSentText, {
          client,
          cfg,
          threadId,
          accountId,
          msgtype: preview.msgtype,
          includeMentions: preview.includeMentions,
          live: false,
        });
        log?.(`draft-stream: finalized ${currentEventId} (MSC4357 stream ended)`);
        return true;
      } catch (err) {
        log?.(`draft-stream: finalize edit failed: ${String(err)}`);
        // If the finalize edit fails, the live marker remains on the last
        // successful edit. Flag the stream so callers can fall back to
        // normal final delivery or redaction instead of leaving the message
        // stuck in a "still streaming" state for MSC4357 clients.
        finalizeInPlaceBlocked = true;
        return false;
      }
    }
    return true;
  };

  const stop = async (): Promise<string | undefined> => {
    // Flush before marking stopped so the loop can drain pending text.
    await loop.flush();
    stopped = true;
    return currentEventId;
  };

  const discardPending = async (): Promise<void> => {
    stopped = true;
    loop.stop();
    await loop.waitForInFlight();
  };

  const reset = (): void => {
    // Clear reply context unless preserveReplyId is set (replyToMode "all"),
    // in which case subsequent blocks should keep replying to the original.
    replyToId = params.preserveReplyId ? params.replyToId : undefined;
    currentEventId = undefined;
    lastSentText = "";
    stopped = false;
    sendFailed = false;
    finalizeInPlaceBlocked = false;
    liveFinalized = false;
    loop.resetPending();
    loop.resetThrottleWindow();
  };

  return {
    update: (text: string) => {
      if (stopped) {
        return;
      }
      loop.update(text);
    },
    flush: loop.flush,
    stop,
    discardPending,
    finalizeLive,
    reset,
    eventId: () => currentEventId,
    matchesPreparedText: (text: string) =>
      prepareMatrixSingleText(text, {
        cfg,
        accountId,
      }).trimmedText === lastSentText,
    mustDeliverFinalNormally: () => sendFailed || finalizeInPlaceBlocked,
  };
}
