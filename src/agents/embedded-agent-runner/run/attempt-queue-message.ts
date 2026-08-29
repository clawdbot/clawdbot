/**
 * Steers active embedded sessions and waits for transcript commits when needed.
 */
import { toErrorObject } from "../../../infra/errors.js";
import type { ImageContent } from "../../../llm/types.js";
import type { MediaFact } from "../../../media/media-facts.js";
import {
  hasPromptImageInput,
  type PromptImageOrderEntry,
} from "../../../media/prompt-image-order.js";
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
  agent?: {
    cancelSteeringMessage?: (
      predicate: (message: AgentMessage) => boolean,
    ) => AgentMessage | undefined;
  };
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

function getTerminalActiveSessionEvent(event: unknown): "settled" | "handoff" | undefined {
  if (!event || typeof event !== "object") {
    return undefined;
  }
  const type = (event as { type?: unknown }).type;
  if (type === "agent_settled") {
    return "settled";
  }
  return type === "agent_handoff" ? "handoff" : undefined;
}

/**
 * Removes one pending steered user message from both the runtime queue and its
 * exact identity-owned display entry.
 */
async function cancelQueuedSteeringMessage(
  activeSession: EmbeddedAgentActiveSessionSteerTarget,
  queueIdentity: string,
): Promise<boolean> {
  const cancelSteeringMessage = activeSession.agent?.cancelSteeringMessage;
  if (!cancelSteeringMessage) {
    return false;
  }
  const message = cancelSteeringMessage.call(
    activeSession.agent,
    (queuedMessage) => getSteeringMessageIdentity(queuedMessage) === queueIdentity,
  );
  if (!message) {
    return false;
  }
  try {
    if (!retireQueuedUserMessage(message as AgentMessage)) {
      log.warn("failed to retire queued steering display entry during cancellation");
    }
  } catch (error) {
    // Runtime ownership is already retired; a display cleanup failure must not
    // leave the same user turn eligible for both the old queue and its replay.
    log.warn(`failed to retire queued steering display entry: ${String(error)}`);
  }
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
      unsubscribe?.();
      unsubscribePersistenceFailure?.();
      abortSignal?.removeEventListener("abort", onAbort);
      if (err) {
        reject(toErrorObject(err, "Non-Error rejection"));
        return;
      }
      resolve();
    };
    const rejectAfterCancellation = (message: string, allowReplay = false) => {
      acceptanceOpen = false;
      const wasAccepted = accepted;
      if (!wasAccepted) {
        reportAcceptance(false);
      }
      // Cancellation is best-effort but must finish before rejecting so callers
      // do not return while a stale queued message can leak into the next turn.
      cancellation ??= cancelQueuedSteeringMessage(activeSession, queueIdentity).then((removed) => {
        if (!removed && wasAccepted && !allowReplay) {
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
              : wasAccepted && !allowReplay
                ? new EmbeddedSteeringAcceptedUnconfirmedError(message, { cause: error })
                : new Error(message, { cause: error }),
          );
        },
      );
    };
    const rejectBeforeAcceptance = (message: string) => {
      acceptanceOpen = false;
      reportAcceptance(false);
      finish(new Error(message));
    };
    const timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => {
        const message =
          "queued steering message was not committed to the transcript before timeout";
        rejectAfterCancellation(message);
      },
      Math.max(1, timeoutMs),
    );
    timer.unref?.();
    const unsubscribe: (() => void) | undefined = activeSession.subscribe((event) => {
      if (isQueuedUserMessageEnd(event, queueIdentity)) {
        finish();
        return;
      }
      const terminalEvent = getTerminalActiveSessionEvent(event);
      if (terminalEvent) {
        const handedOff = terminalEvent === "handoff";
        const message = `active session ${handedOff ? "handed off" : "ended"} before queued steering message was committed to the transcript`;
        // Terminal state closes admission and owns exact queue cleanup even when
        // steer() enqueued synchronously but its Promise has not settled yet.
        rejectAfterCancellation(message, handedOff);
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
        if (!acceptanceOpen) {
          return;
        }
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
      rejectAfterCancellation(
        accepted
          ? "queued steering message was cancelled before delivery"
          : "queued steering message was cancelled before acceptance",
      );
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
  const isPlainTextAnswer = !hasPromptImageInput(options);
  if (isInboundUserMessage && !isPlainTextAnswer) {
    try {
      await cancelPendingAgentQuestionForSession({ sessionKey, resolvedBy: "image-reply" });
    } catch (error) {
      log.warn(`failed to cancel ask_user before image steering: ${String(error)}`);
    }
  }
  // Non-user steering must install its transcript listener synchronously; an
  // unnecessary await here lets callers emit before subscribe() runs.
  if (
    isInboundUserMessage &&
    isPlainTextAnswer &&
    (await claimEmbeddedPendingUserInputAnswer(text, options, sessionKey))
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

export async function claimEmbeddedPendingUserInputAnswer(
  text: string,
  options: EmbeddedAgentQueueMessageOptions | undefined,
  sessionKey?: string,
): Promise<boolean> {
  if (options?.isInboundUserMessage !== true || hasPromptImageInput(options)) {
    return false;
  }
  const claimed = await claimPendingAgentQuestionAnswer({
    sessionKey,
    text,
    persist: options.userTurnTranscriptRecorder
      ? async () => {
          await options.userTurnTranscriptRecorder?.persistApproved();
        }
      : undefined,
  });
  return claimed;
}
