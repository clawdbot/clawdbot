// Persists queue state around the irreversible platform-send boundary.
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatErrorMessage } from "../errors.js";
import type { OutboundDeliveryQueuePolicy, PlatformSendRoute } from "./deliver-contracts.js";
import { OutboundDeliveryError } from "./deliver-types.js";
import {
  ackDelivery,
  failDelivery,
  failDeliveryAfterPlatformSend,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
} from "./delivery-queue-storage.js";

const log = createSubsystemLogger("outbound/deliver");

const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

export const isDeliveryAbortError = (err: unknown): boolean =>
  isAbortError(err) ||
  (err instanceof OutboundDeliveryError &&
    isAbortError((err as Error & { cause?: unknown }).cause));

export type QueuedPostSendState = "marked" | "acked" | "failed";

export type QueuedPreSendState = "marked" | "acked";

type QueuedDeliveryFailureRecorder = typeof failDelivery | typeof failDeliveryAfterPlatformSend;

/** Keeps live and recovered queue transitions on the same producer claim. */
export function createQueuedDeliveryOwner(params: {
  queueId: string;
  stateDir?: string;
  expectedPlatformSendAttemptId?: string | null | (() => string | null | undefined);
}) {
  const resolveExpectedPlatformSendAttemptId = () =>
    typeof params.expectedPlatformSendAttemptId === "function"
      ? params.expectedPlatformSendAttemptId()
      : params.expectedPlatformSendAttemptId;
  return {
    ack(options?: Parameters<typeof ackDelivery>[2]): Promise<void> {
      const expectedPlatformSendAttemptId = resolveExpectedPlatformSendAttemptId();
      if (expectedPlatformSendAttemptId !== undefined) {
        return ackDelivery(params.queueId, params.stateDir, {
          ...options,
          expectedPlatformSendAttemptId,
        });
      }
      return options
        ? ackDelivery(params.queueId, params.stateDir, options)
        : params.stateDir !== undefined
          ? ackDelivery(params.queueId, params.stateDir)
          : ackDelivery(params.queueId);
    },
    fail(record: QueuedDeliveryFailureRecorder, error: string): Promise<void> {
      const expectedPlatformSendAttemptId = resolveExpectedPlatformSendAttemptId();
      if (expectedPlatformSendAttemptId !== undefined) {
        return record(params.queueId, error, params.stateDir, expectedPlatformSendAttemptId);
      }
      return params.stateDir !== undefined
        ? record(params.queueId, error, params.stateDir)
        : record(params.queueId, error);
    },
  };
}

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
  expectedPlatformSendAttemptId?: string | null;
  retainSpoolArtifacts?: boolean;
  onPostSendMarkerError?: (error: unknown) => void;
}): Promise<QueuedPostSendState> {
  const expectedPlatformSendAttemptId =
    params.producerClaimId ?? params.expectedPlatformSendAttemptId;
  const owner = createQueuedDeliveryOwner({
    queueId: params.queueId,
    stateDir: params.stateDir,
    expectedPlatformSendAttemptId,
  });
  try {
    if (expectedPlatformSendAttemptId !== undefined) {
      await markDeliveryPlatformOutcomeUnknown(
        params.queueId,
        params.stateDir,
        expectedPlatformSendAttemptId,
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
    params.onPostSendMarkerError?.(markErr);
    log.warn(
      `failed to mark queued delivery ${params.queueId} as platform-outcome-unknown; falling back to direct ack (${params.queuePolicy}): ${formatErrorMessage(markErr)}`,
    );
    try {
      // The platform already returned a result. If state marking is unavailable,
      // deleting the intent is safer than leaving it replayable.
      await owner.ack(params.retainSpoolArtifacts ? { retainSpoolArtifacts: true } : undefined);
      return "acked";
    } catch (ackErr: unknown) {
      const error = `post-send state persistence failed: marker=${formatErrorMessage(markErr)}; ack=${formatErrorMessage(ackErr)}`;
      // Keep the evidence in the same canonical row if both primary state
      // transitions fail; a generic failure update would make it replayable.
      await owner.fail(failDeliveryAfterPlatformSend, error);
      return "failed";
    }
  }
}
