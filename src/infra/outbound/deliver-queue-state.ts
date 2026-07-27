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
  producerClaimId?: string;
  retainSpoolArtifacts?: boolean;
}): Promise<QueuedPreSendState> {
  try {
    const route = { replyToId: params.route.replyToId ?? null };
    if (params.producerClaimId) {
      await markDeliveryPlatformSendAttemptStarted(
        params.queueId,
        params.stateDir,
        route,
        params.producerClaimId,
      );
    } else {
      await markDeliveryPlatformSendAttemptStarted(params.queueId, params.stateDir, route);
    }
    return "marked";
  } catch (markErr: unknown) {
    // A fenced producer must never discard a lease it no longer owns: doing so
    // could erase the replacement owner and send the same intent twice.
    if (params.queuePolicy === "required" || params.producerClaimId) {
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
  stateDir?: string;
  producerClaimId?: string;
}): Promise<QueuedPostSendState> {
  try {
    if (params.producerClaimId) {
      await markDeliveryPlatformOutcomeUnknown(
        params.queueId,
        params.stateDir,
        params.producerClaimId,
      );
    } else if (params.stateDir !== undefined) {
      await markDeliveryPlatformOutcomeUnknown(params.queueId, params.stateDir);
    } else {
      await markDeliveryPlatformOutcomeUnknown(params.queueId);
    }
    return "marked";
  } catch (markErr: unknown) {
    if (params.producerClaimId) {
      // A bounded batch may still contain identityless later payloads. Its
      // intermediate state must never become a premature success receipt.
      await failDeliveryAfterPlatformSend(
        params.queueId,
        `post-send state persistence failed: ${formatErrorMessage(markErr)}`,
        params.stateDir,
        params.producerClaimId,
      );
      return "failed";
    }
    log.warn(
      `failed to mark queued delivery ${params.queueId} as platform-outcome-unknown; falling back to direct ack (${params.queuePolicy}): ${formatErrorMessage(markErr)}`,
    );
    try {
      // The platform already returned a result. If state marking is unavailable,
      // deleting the intent is safer than leaving it replayable.
      if (params.stateDir !== undefined) {
        await ackDelivery(params.queueId, params.stateDir);
      } else {
        await ackDelivery(params.queueId);
      }
      return "acked";
    } catch (ackErr: unknown) {
      const error = `post-send state persistence failed: marker=${formatErrorMessage(markErr)}; ack=${formatErrorMessage(ackErr)}`;
      // Keep the evidence in the same canonical row if both primary state
      // transitions fail; a generic failure update would make it replayable.
      if (params.stateDir !== undefined) {
        await failDeliveryAfterPlatformSend(params.queueId, error, params.stateDir);
      } else {
        await failDeliveryAfterPlatformSend(params.queueId, error);
      }
      return "failed";
    }
  }
}
