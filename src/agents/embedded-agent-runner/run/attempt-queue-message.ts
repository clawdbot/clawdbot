/**
 * Steers active embedded sessions and waits for transcript commits when needed.
 */
import { toErrorObject } from "../../../infra/errors.js";
import type { ImageContent } from "../../../llm/types.js";
import type { MediaFact } from "../../../media/media-facts.js";
import type { PromptImageOrderEntry } from "../../../media/prompt-image-order.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import {
  cancelPendingAgentQuestionForSession,
  claimPendingAgentQuestionAnswer,
} from "../../harness/gateway-question.js";
import type { AgentMessage } from "../../runtime/index.js";
import { retireQueuedUserMessage } from "../../sessions/queued-user-message-retirement.js";
import {
  getSteeringMessageIdentity,
  subscribeSteeringMessagePersistenceFailure,
} from "../../sessions/steering-message-identity.js";
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
  agent?: unknown;
  steer(
    text: string,
    images?: ImageContent[],
    userTurnTranscriptRecorder?: UserTurnTranscriptRecorder,
    media?: MediaFact[],
    imageOrder?: PromptImageOrderEntry[],
    queueIdentity?: string,
    canInject?: () => boolean,
  ): Promise<void>;
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
  queueIdentity?: string,
  canInject?: () => boolean,
): Promise<void> {
  if (canInject) {
    return activeSession.steer(
      text,
      images,
      userTurnTranscriptRecorder,
      media,
      imageOrder,
      queueIdentity,
      canInject,
    );
  }
  if (media?.length || queueIdentity) {
    return activeSession.steer(
      text,
      images,
      userTurnTranscriptRecorder,
      media,
      imageOrder,
      queueIdentity,
    );
  }
  return userTurnTranscriptRecorder
    ? activeSession.steer(text, images, userTurnTranscriptRecorder)
    : activeSession.steer(text, images);
}

function isQueuedUserMessageEnd(event: unknown, queueIdentity: string): boolean {
  if (!event || typeof event !== "object") {
    return false;
  }
  const record = event as { message?: unknown; type?: unknown };
  return (
    record.type === "message_end" && getSteeringMessageIdentity(record.message) === queueIdentity
  );
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

function getAgentSteeringQueueMessages(agent: unknown): unknown[] | undefined {
  if (!agent || typeof agent !== "object") {
    return undefined;
  }
  const queue = (agent as { steeringQueue?: unknown }).steeringQueue;
  if (!queue || typeof queue !== "object") {
    return undefined;
  }
  const messages = (queue as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages : undefined;
}

/**
 * Removes one pending steered user message from both the runtime queue and its
 * exact identity-owned display entry.
 */
async function cancelQueuedSteeringMessage(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  queueIdentity: string,
): Promise<boolean> {
  const queuedMessages = getAgentSteeringQueueMessages(activeSession.agent);
  if (!queuedMessages) {
    return false;
  }
  // The session runtime exposes only all-queue clears publicly; mutate the exact pending message
  // so unrelated queued messages keep their full payloads.
  const queueIndex = queuedMessages.findIndex(
    (message) => getSteeringMessageIdentity(message) === queueIdentity,
  );
  if (queueIndex === -1) {
    return false;
  }
  const message = queuedMessages[queueIndex];
  if (!message || !retireQueuedUserMessage(message as AgentMessage)) {
    return false;
  }
  queuedMessages.splice(queueIndex, 1);
  return true;
}

/**
 * Sends a steering message and resolves only after the matching user
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
  queueIdentity: string = crypto.randomUUID(),
  abortSignal?: AbortSignal,
  onQueueAccepted?: (accepted: boolean) => void,
  canInject?: () => boolean,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let terminalTimer: ReturnType<typeof setTimeout> | undefined;
    let accepted = false;
    let abortRequested = abortSignal?.aborted === true;
    let acceptanceReported = false;
    let cancellation: Promise<void> | undefined;
    let acceptanceOpen = true;
    const reportAcceptance = (value: boolean) => {
      if (acceptanceReported) {
        return;
      }
      acceptanceReported = true;
      onQueueAccepted?.(value);
    };
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
      unsubscribePersistenceFailure?.();
      abortSignal?.removeEventListener("abort", onAbort);
      if (err) {
        reject(toErrorObject(err, "Non-Error rejection"));
        return;
      }
      resolve();
    };
    const rejectAfterCancellation = (message: string) => {
      // Cancellation is best-effort but must finish before rejecting so callers
      // do not return while a stale queued message can leak into the next turn.
      cancellation ??= cancelQueuedSteeringMessage(activeSession, queueIdentity).then((removed) => {
        if (!removed) {
          log.warn("failed to find queued steering message for cancellation");
          throw new EmbeddedSteeringAcceptedUnconfirmedError(message);
        }
      });
      void cancellation.then(
        () => finish(new Error(message)),
        (error: unknown) => {
          if (!(error instanceof EmbeddedSteeringAcceptedUnconfirmedError)) {
            log.warn(`failed to cancel queued steering message: ${String(error)}`);
          }
          finish(
            error instanceof EmbeddedSteeringAcceptedUnconfirmedError
              ? error
              : new EmbeddedSteeringAcceptedUnconfirmedError(message, { cause: error }),
          );
        },
      );
    };
    const rejectBeforeAcceptance = (message: string) => {
      acceptanceOpen = false;
      reportAcceptance(false);
      finish(new Error(message));
    };
    const scheduleTerminalCancellation = () => {
      if (terminalTimer) {
        return;
      }
      terminalTimer = setTimeout(() => {
        terminalTimer = undefined;
        const message =
          "active session ended before queued steering message was committed to the transcript";
        if (accepted) {
          rejectAfterCancellation(message);
          return;
        }
        rejectBeforeAcceptance(message);
      }, 0);
      terminalTimer.unref?.();
    };
    const timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => {
        const message =
          "queued steering message was not committed to the transcript before timeout";
        if (accepted) {
          rejectAfterCancellation(message);
          return;
        }
        rejectBeforeAcceptance(message);
      },
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
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
      if (isQueuedUserMessageEnd(event, queueIdentity)) {
        finish();
        return;
      }
      if (isTerminalActiveSessionEvent(event)) {
        // AgentSession emits agent_end before announcing auto-retry or
        // auto-compaction continuations. Defer cancellation one tick so those
        // continuation events can keep draining this message.
        scheduleTerminalCancellation();
      }
    });
    const unsubscribePersistenceFailure = subscribeSteeringMessagePersistenceFailure(
      queueIdentity,
      (error) => finish(error),
    );
    if (abortRequested) {
      rejectBeforeAcceptance("queued steering message was cancelled before acceptance");
      return;
    }
    const steer = steerActiveSession(
      activeSession,
      text,
      images,
      userTurnTranscriptRecorder,
      media,
      imageOrder,
      queueIdentity,
      () => acceptanceOpen && (canInject?.() ?? true),
    );
    void steer.then(
      () => {
        accepted = true;
        reportAcceptance(true);
        if (abortRequested) {
          rejectAfterCancellation("queued steering message was cancelled before delivery");
        }
      },
      (err: unknown) => {
        reportAcceptance(false);
        finish(err);
      },
    );
    function onAbort() {
      abortRequested = true;
      if (accepted) {
        rejectAfterCancellation("queued steering message was cancelled before delivery");
      }
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true });
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
  canInject?: () => boolean,
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
    options?.onQueueAccepted?.(true);
    return;
  }
  if (options?.waitForTranscriptCommit !== true) {
    try {
      await steerActiveSession(
        activeSession,
        text,
        options?.images,
        options?.userTurnTranscriptRecorder,
        options?.media,
        options?.imageOrder,
        options?.queueIdentity,
        canInject,
      );
      options?.onQueueAccepted?.(true);
    } catch (error) {
      options?.onQueueAccepted?.(false);
      throw error;
    }
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
      options.queueIdentity,
      options.abortSignal,
      options.onQueueAccepted,
      canInject,
    );
  } catch (error) {
    if (error instanceof EmbeddedSteeringAcceptedUnconfirmedError) {
      return { transcriptCommit: "unconfirmed", errorMessage: error.message };
    }
    throw error;
  }
}
