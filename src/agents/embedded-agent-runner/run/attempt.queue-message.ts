/**
 * Steers active embedded sessions and waits for transcript commits when needed.
 */
import { toErrorObject } from "../../../infra/errors.js";
import type { ImageContent } from "../../../llm/types.js";
import type { MediaFact } from "../../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import type { InputProvenance } from "../../../sessions/input-provenance.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import {
  cancelPendingAgentQuestionForSession,
  claimPendingAgentQuestionAnswer,
} from "../../harness/gateway-question.js";
import { log } from "../logger.js";
import type { EmbeddedAgentQueueMessageOptions } from "../run-state.js";

type AgentSessionSteerReceipt = {
  committed: Promise<void>;
  cancel(): boolean;
};

type ReceiptAwareSteerTarget = {
  steerWithReceipt(
    text: string,
    images?: ImageContent[],
    userTurnTranscriptRecorder?: UserTurnTranscriptRecorder,
    media?: MediaFact[],
    imageOrder?: PromptImageOrderEntry[],
    inputProvenance?: InputProvenance,
  ): Promise<AgentSessionSteerReceipt>;
};

type EmbeddedSteeringQueueOutcome =
  | { kind: "answered-pending-input" }
  | { kind: "steered"; transcriptCommit: "confirmed" | "not-requested" }
  | { kind: "accepted-unconfirmed"; errorMessage: string };

/**
 * Minimal active-session surface needed to steer a running attempt and observe
 * whether the queued user message reached the transcript.
 */
type EmbeddedAgentActiveSessionSteerTarget = {
  steer(
    text: string,
    images?: ImageContent[],
    userTurnTranscriptRecorder?: UserTurnTranscriptRecorder,
    media?: MediaFact[],
    imageOrder?: PromptImageOrderEntry[],
    inputProvenance?: InputProvenance,
  ): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
};

function isReceiptAwareSteerTarget(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
): activeSession is EmbeddedAgentActiveSessionSteerTarget & ReceiptAwareSteerTarget {
  return (
    "steerWithReceipt" in activeSession &&
    typeof (activeSession as { steerWithReceipt?: unknown }).steerWithReceipt === "function"
  );
}

/** Default wait for a steered user message to appear in the active transcript. */
const DEFAULT_QUEUE_TRANSCRIPT_COMMIT_TIMEOUT_MS = 120_000;

class EmbeddedSteeringAcceptedUnconfirmedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EmbeddedSteeringAcceptedUnconfirmedError";
  }
}

function steerActiveSession(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  text: string,
  images?: ImageContent[],
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder,
  media?: MediaFact[],
  imageOrder?: PromptImageOrderEntry[],
  inputProvenance?: EmbeddedAgentQueueMessageOptions["inputProvenance"],
): Promise<void> {
  if (inputProvenance) {
    return activeSession.steer(
      text,
      images,
      userTurnTranscriptRecorder,
      media,
      imageOrder,
      inputProvenance,
    );
  }
  if (media?.length) {
    return activeSession.steer(text, images, userTurnTranscriptRecorder, media, imageOrder);
  }
  return userTurnTranscriptRecorder
    ? activeSession.steer(text, images, userTurnTranscriptRecorder)
    : activeSession.steer(text, images);
}

function isTerminalActiveSessionEvent(event: unknown): boolean {
  return Boolean(
    event && typeof event === "object" && (event as { type?: unknown }).type === "agent_end",
  );
}

function isAutoRetryStartEvent(event: unknown): boolean {
  return Boolean(
    event && typeof event === "object" && (event as { type?: unknown }).type === "auto_retry_start",
  );
}

function isCompactionStartEvent(event: unknown): boolean {
  return Boolean(
    event && typeof event === "object" && (event as { type?: unknown }).type === "compaction_start",
  );
}

/**
 * Sends a steering message and resolves only after its session-owned receipt
 * confirms transcript persistence. Terminal events only drive timely cleanup.
 */
async function steerAndWaitForTranscriptCommit(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  text: string,
  timeoutMs: number,
  userTurnTranscriptRecorder?: UserTurnTranscriptRecorder,
  images?: ImageContent[],
  media?: MediaFact[],
  imageOrder?: PromptImageOrderEntry[],
  inputProvenance?: EmbeddedAgentQueueMessageOptions["inputProvenance"],
): Promise<void> {
  if (!isReceiptAwareSteerTarget(activeSession)) {
    throw new Error("active session does not support transcript commit receipts");
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let receipt: AgentSessionSteerReceipt | undefined;
    let cancellationMessage: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let terminalTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (terminalTimer) {
        clearTimeout(terminalTimer);
      }
      unsubscribe?.();
      if (err) {
        reject(toErrorObject(err, "Non-Error rejection"));
        return;
      }
      resolve();
    };
    const rejectAfterCancellation = (message: string) => {
      if (!receipt) {
        cancellationMessage = message;
        return;
      }
      try {
        if (!receipt.cancel()) {
          log.warn("failed to find queued steering receipt for cancellation");
          finish(new EmbeddedSteeringAcceptedUnconfirmedError(message));
          return;
        }
        finish(new Error(message));
      } catch (error) {
        log.warn(`failed to cancel queued steering message: ${String(error)}`);
        finish(new EmbeddedSteeringAcceptedUnconfirmedError(message, { cause: error }));
      }
    };
    const scheduleTerminalCancellation = () => {
      if (terminalTimer) {
        return;
      }
      terminalTimer = setTimeout(() => {
        terminalTimer = undefined;
        rejectAfterCancellation(
          "active session ended before queued steering message was committed to the transcript",
        );
      }, 0);
      terminalTimer.unref?.();
    };
    const startCommitTimer = () => {
      timer = setTimeout(
        () => {
          rejectAfterCancellation(
            "queued steering message was not committed to the transcript before timeout",
          );
        },
        Math.max(1, timeoutMs),
      );
      timer.unref?.();
    };
    const unsubscribe: (() => void) | undefined = activeSession.subscribe((event) => {
      if (isAutoRetryStartEvent(event) || isCompactionStartEvent(event)) {
        // Continuation events prove the run is still alive under a new attempt,
        // so keep waiting for the queued user message to drain.
        if (terminalTimer) {
          clearTimeout(terminalTimer);
          terminalTimer = undefined;
        }
        return;
      }
      if (isTerminalActiveSessionEvent(event)) {
        // AgentSession emits agent_end before announcing auto-retry or
        // auto-compaction continuations. Defer cancellation one tick so those
        // continuation events can keep draining this message.
        scheduleTerminalCancellation();
      }
    });
    void activeSession
      .steerWithReceipt(
        text,
        images,
        userTurnTranscriptRecorder,
        media,
        imageOrder,
        inputProvenance,
      )
      .then(
        (sessionReceipt) => {
          receipt = sessionReceipt;
          void receipt.committed.then(
            () => finish(),
            (error: unknown) => finish(error),
          );
          if (cancellationMessage) {
            // An already-settled commit wins over a terminal event observed
            // before steerWithReceipt returned.
            queueMicrotask(() => {
              if (!settled && cancellationMessage) {
                rejectAfterCancellation(cancellationMessage);
              }
            });
            return;
          }
          startCommitTimer();
        },
        (error: unknown) => finish(error),
      );
  });
}

/**
 * Steers the active session directly or waits for transcript commitment when a
 * caller needs delivery proof before returning.
 */
export async function steerActiveSessionWithOptionalDeliveryWait(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  text: string,
  options: EmbeddedAgentQueueMessageOptions | undefined,
  sessionKey?: string,
): Promise<EmbeddedSteeringQueueOutcome> {
  const isInboundUserMessage = options?.isInboundUserMessage === true;
  const isPlainTextAnswer = !options?.images?.length;
  if (isInboundUserMessage && !isPlainTextAnswer) {
    try {
      await cancelPendingAgentQuestionForSession({ sessionKey, resolvedBy: "image-reply" });
    } catch (error) {
      log.warn(`failed to cancel ask_user before image steering: ${String(error)}`);
    }
  }
  if (
    isInboundUserMessage &&
    isPlainTextAnswer &&
    (await claimPendingAgentQuestionAnswer({
      sessionKey,
      text,
      persist: options.userTurnTranscriptRecorder
        ? async () => {
            await options.userTurnTranscriptRecorder?.persistApproved();
          }
        : undefined,
    }))
  ) {
    return { kind: "answered-pending-input" };
  }
  if (options?.waitForTranscriptCommit !== true) {
    await steerActiveSession(
      activeSession,
      text,
      options?.images,
      options?.userTurnTranscriptRecorder,
      options?.media,
      options?.imageOrder,
      options?.inputProvenance,
    );
    return { kind: "steered", transcriptCommit: "not-requested" };
  }
  try {
    await steerAndWaitForTranscriptCommit(
      activeSession,
      text,
      options.deliveryTimeoutMs ?? DEFAULT_QUEUE_TRANSCRIPT_COMMIT_TIMEOUT_MS,
      options.userTurnTranscriptRecorder,
      options.images,
      options.media,
      options.imageOrder,
      options.inputProvenance,
    );
    return { kind: "steered", transcriptCommit: "confirmed" };
  } catch (error) {
    if (error instanceof EmbeddedSteeringAcceptedUnconfirmedError) {
      return { kind: "accepted-unconfirmed", errorMessage: error.message };
    }
    throw error;
  }
}
