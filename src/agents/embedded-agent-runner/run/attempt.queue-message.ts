/**
 * Steers active embedded sessions and waits for transcript commits when needed.
 */
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

type SteerReceipt = {
  accepted: Promise<void>;
  committed: Promise<void>;
  cancel(): boolean;
};
type SteerArgs = [
  text: string,
  images?: ImageContent[],
  recorder?: UserTurnTranscriptRecorder,
  media?: MediaFact[],
  imageOrder?: PromptImageOrderEntry[],
  provenance?: InputProvenance,
];
type SteerTarget = {
  steer(...args: SteerArgs): Promise<void>;
  steerWithReceipt?(...args: SteerArgs): SteerReceipt;
};
type SteeringOutcome =
  | { kind: "answered-pending-input" }
  | { kind: "steered"; transcriptCommit: "confirmed" | "not-requested" }
  | { kind: "accepted-unconfirmed"; errorMessage: string };

const DEFAULT_COMMIT_TIMEOUT_MS = 120_000;

class ReceiptWaitError extends Error {}

function waitForStage(
  stage: Promise<void>,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  timeoutMessage: string,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new ReceiptWaitError("queued steering message was cancelled"));
  }
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    return Promise.reject(new ReceiptWaitError(timeoutMessage));
  }
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) {
        resolve();
      } else {
        reject(
          error instanceof Error
            ? error
            : new Error("steering receipt wait failed", { cause: error }),
        );
      }
    };
    const timer = setTimeout(() => finish(new ReceiptWaitError(timeoutMessage)), remainingMs);
    timer.unref?.();
    const onAbort = () => finish(new ReceiptWaitError("queued steering message was cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    void stage.then(() => finish(), finish);
  });
}

function tryCancel(receipt: SteerReceipt): boolean {
  try {
    return receipt.cancel();
  } catch (error) {
    log.warn(`failed to cancel queued steering message: ${String(error)}`);
    return false;
  }
}

async function steerWithCommitWait(
  target: SteerTarget,
  text: string,
  deadlineMs: number,
  options: EmbeddedAgentQueueMessageOptions,
): Promise<string | undefined> {
  if (!target.steerWithReceipt) {
    options.onQueueAccepted?.(false);
    throw new Error("active session does not support transcript commit receipts");
  }
  if (options.abortSignal?.aborted) {
    options.onQueueAccepted?.(false);
    throw new Error("queued steering message was cancelled before acceptance");
  }
  const receipt = target.steerWithReceipt(
    text,
    options.images,
    options.userTurnTranscriptRecorder,
    options.media,
    options.imageOrder,
    options.inputProvenance,
  );
  let accepted = false;
  try {
    await waitForStage(
      receipt.accepted,
      deadlineMs,
      options.abortSignal,
      "queued steering message was not accepted before timeout",
    );
    accepted = true;
    options.onQueueAccepted?.(true);
    await waitForStage(
      receipt.committed,
      deadlineMs,
      options.abortSignal,
      "queued steering message was not committed to the transcript before timeout",
    );
  } catch (error) {
    if (!accepted && !(error instanceof ReceiptWaitError)) {
      options.onQueueAccepted?.(false);
      throw error;
    }
    const cancelled = tryCancel(receipt);
    if (!accepted) {
      options.onQueueAccepted?.(!cancelled);
    }
    if (cancelled) {
      throw error;
    }
    return error instanceof Error ? error.message : "queued steering commitment failed";
  }
  return undefined;
}

export async function steerActiveSessionWithOptionalDeliveryWait(
  target: SteerTarget,
  text: string,
  options: EmbeddedAgentQueueMessageOptions | undefined,
  sessionKey?: string,
): Promise<SteeringOutcome> {
  const isInbound = options?.isInboundUserMessage === true;
  if (isInbound && options?.images?.length) {
    try {
      await cancelPendingAgentQuestionForSession({ sessionKey, resolvedBy: "image-reply" });
    } catch (error) {
      log.warn(`failed to cancel ask_user before image steering: ${String(error)}`);
    }
  } else if (
    isInbound &&
    (await claimPendingAgentQuestionAnswer({
      sessionKey,
      text,
      persist: options?.userTurnTranscriptRecorder
        ? async () => {
            await options.userTurnTranscriptRecorder?.persistApproved();
          }
        : undefined,
    }))
  ) {
    options?.onQueueAccepted?.(true);
    return { kind: "answered-pending-input" };
  }

  if (options?.waitForTranscriptCommit !== true) {
    try {
      if (options?.abortSignal?.aborted) {
        throw new Error("queued steering message was cancelled before acceptance");
      }
      await target.steer(
        text,
        options?.images,
        options?.userTurnTranscriptRecorder,
        options?.media,
        options?.imageOrder,
        options?.inputProvenance,
      );
      options?.onQueueAccepted?.(true);
      return { kind: "steered", transcriptCommit: "not-requested" };
    } catch (error) {
      options?.onQueueAccepted?.(false);
      throw error;
    }
  }

  const errorMessage = await steerWithCommitWait(
    target,
    text,
    Date.now() + Math.max(0, options.deliveryTimeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS),
    options,
  );
  return errorMessage
    ? { kind: "accepted-unconfirmed", errorMessage }
    : { kind: "steered", transcriptCommit: "confirmed" };
}
