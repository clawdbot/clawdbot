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
import type { AgentMessage } from "../../runtime/index.js";
import { log } from "../logger.js";
import type {
  EmbeddedAgentQueueMessageOptions,
  EmbeddedAgentQueueMessageResult,
} from "../run-state.js";

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
  ): Promise<AgentMessage>;
  cancelSteer(receipt: AgentMessage): boolean;
  subscribe(listener: (event: unknown) => void): () => void;
};

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
): Promise<AgentMessage> {
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

function isQueuedUserMessageEnd(event: unknown, receipt: AgentMessage): boolean {
  if (!event || typeof event !== "object") {
    return false;
  }
  const record = event as { message?: unknown; type?: unknown };
  return record.type === "message_end" && record.message === receipt;
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
 * Sends a steering message and resolves only after the exact queued user
 * `message_end` event appears. If the run ends or times out first, the pending
 * queue entry is removed so an abandoned steer does not leak into a later turn.
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
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let receipt: AgentMessage | undefined;
    let cancellationMessage: string | undefined;
    const committedBeforeAdmission = new Set<AgentMessage>();
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
      // Cancellation is best-effort but must finish before rejecting so callers
      // do not return while a stale queued message can leak into the next turn.
      try {
        if (!activeSession.cancelSteer(receipt)) {
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
      if (
        event &&
        typeof event === "object" &&
        (event as { type?: unknown }).type === "message_end"
      ) {
        const message = (event as { message?: unknown }).message;
        if (receipt && isQueuedUserMessageEnd(event, receipt)) {
          finish();
        } else if (!receipt && message && typeof message === "object") {
          committedBeforeAdmission.add(message as AgentMessage);
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
    void steerActiveSession(
      activeSession,
      text,
      images,
      userTurnTranscriptRecorder,
      media,
      imageOrder,
      inputProvenance,
    ).then(
      (queuedReceipt) => {
        receipt = queuedReceipt;
        if (committedBeforeAdmission.has(queuedReceipt)) {
          finish();
          return;
        }
        if (cancellationMessage) {
          rejectAfterCancellation(cancellationMessage);
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
): Promise<void | EmbeddedAgentQueueMessageResult> {
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
    return;
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
    return;
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
  } catch (error) {
    if (error instanceof EmbeddedSteeringAcceptedUnconfirmedError) {
      return { transcriptCommit: "unconfirmed", errorMessage: error.message };
    }
    throw error;
  }
}
