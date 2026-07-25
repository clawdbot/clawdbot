// Persists queue state around the irreversible platform-send boundary.
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatErrorMessage } from "../errors.js";
import type { OutboundDeliveryQueuePolicy, PlatformSendRoute } from "./deliver-contracts.js";
import { OutboundDeliveryError } from "./deliver-types.js";
import {
  ackDelivery,
  failDeliveryAfterPlatformSend,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
} from "./delivery-queue.js";

const log = createSubsystemLogger("outbound/deliver");

const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

export const isDeliveryAbortError = (err: unknown): boolean =>
  isAbortError(err) ||
  (err instanceof OutboundDeliveryError &&
    isAbortError((err as Error & { cause?: unknown }).cause));

export type QueuedPostSendState = "marked" | "acked" | "failed";

export type QueuedPreSendState = "marked" | "acked";

export async function persistQueuedPreSendState(params: {
  queueId: string;
  queuePolicy: OutboundDeliveryQueuePolicy;
  stateDir?: string;
  route: PlatformSendRoute;
  retainSpoolArtifacts?: boolean;
}): Promise<QueuedPreSendState> {
  try {
    await markDeliveryPlatformSendAttemptStarted(params.queueId, params.stateDir, {
      replyToId: params.route.replyToId ?? null,
    });
    return "marked";
  } catch (markErr: unknown) {
    if (params.queuePolicy === "required") {
      throw markErr;
    }
    log.warn(
      `failed to mark queued delivery ${params.queueId} as platform-send-attempt-started; removing replay intent before best-effort send: ${formatErrorMessage(markErr)}`,
    );
    // If the pre-send marker is unavailable, remove the intent before crossing
    // the platform boundary. An ack failure aborts the send, leaving safe retry state.
    if (params.retainSpoolArtifacts) {
      await ackDelivery(params.queueId, params.stateDir, { retainSpoolArtifacts: true });
    } else {
      await ackDelivery(params.queueId, params.stateDir);
    }
    return "acked";
  }
}

export async function persistQueuedPostSendState(params: {
  queueId: string;
  queuePolicy: OutboundDeliveryQueuePolicy;
}): Promise<QueuedPostSendState> {
  try {
    await markDeliveryPlatformOutcomeUnknown(params.queueId);
    return "marked";
  } catch (markErr: unknown) {
    log.warn(
      `failed to mark queued delivery ${params.queueId} as platform-outcome-unknown; falling back to direct ack (${params.queuePolicy}): ${formatErrorMessage(markErr)}`,
    );
    try {
      // The platform already returned a result. If state marking is unavailable,
      // deleting the intent is safer than leaving it replayable.
      await ackDelivery(params.queueId);
      return "acked";
    } catch (ackErr: unknown) {
      const error = `post-send state persistence failed: marker=${formatErrorMessage(markErr)}; ack=${formatErrorMessage(ackErr)}`;
      // Keep the evidence in the same canonical row if both primary state
      // transitions fail; a generic failure update would make it replayable.
      await failDeliveryAfterPlatformSend(params.queueId, error);
      return "failed";
    }
  }
}
