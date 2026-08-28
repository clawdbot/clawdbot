// Persists queue state around the irreversible platform-send boundary.
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatErrorMessage } from "../errors.js";
import type { OutboundDeliveryQueuePolicy, PlatformSendRoute } from "./deliver-contracts.js";
import {
  OutboundDeliveryError,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
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

export type QueuedPostSendState = "marked" | "unmarked" | "acked" | "failed";

export type QueuedPreSendState = "marked" | "acked";

type QueuedDeliveryFailureRecorder = typeof failDelivery | typeof failDeliveryAfterPlatformSend;

/** A surviving receipt cannot settle a batch that also contains an unidentified send. */
export function hasUnconfirmedOutboundSends(params: {
  results: readonly OutboundDeliveryResult[];
  payloadOutcomes: readonly OutboundPayloadDeliveryOutcome[];
  platformSendStarted: boolean;
}): boolean {
  return (
    params.payloadOutcomes.some(
      (outcome) =>
        outcome.status === "suppressed" && outcome.reason === "adapter_returned_no_identity",
    ) ||
    (params.results.length === 0 &&
      params.platformSendStarted &&
      !params.payloadOutcomes.some((outcome) => outcome.status === "failed"))
  );
}

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
    if (params.queuePolicy === "required") {
      throw markErr;
    }
    log.warn(
      `failed to mark queued delivery ${params.queueId} as platform-send-attempt-started; removing replay intent before best-effort send: ${formatErrorMessage(markErr)}`,
    );
    // Remove only the exact owner before crossing the platform boundary. A lost
    // claim or failed ack aborts the send instead of erasing a replacement owner.
    const options = {
      ...(params.retainSpoolArtifacts ? { retainSpoolArtifacts: true } : {}),
      ...(params.producerClaimId ? { expectedPlatformSendAttemptId: params.producerClaimId } : {}),
    };
    await ackDelivery(
      params.queueId,
      params.stateDir,
      Object.keys(options).length > 0 ? options : undefined,
    );
    return "acked";
  }
}

export async function persistQueuedPostSendState(params: {
  queueId: string;
  stateDir?: string;
  expectedPlatformSendAttemptId?: string | null;
}): Promise<"marked" | "unmarked"> {
  const expectedPlatformSendAttemptId = params.expectedPlatformSendAttemptId;
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
    // Progress is not settlement: ack would erase an unfinished batch, and
    // failure would release its live lease. Keep the dispatch fence until the
    // owner can ack complete success or persist the settled failure.
    log.warn(
      `failed to mark queued delivery ${params.queueId} as platform-outcome-unknown; deferring settlement until the batch finishes: ${formatErrorMessage(markErr)}`,
    );
    return "unmarked";
  }
}
