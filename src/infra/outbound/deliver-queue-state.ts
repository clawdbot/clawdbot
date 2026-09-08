// Persists queue state around the irreversible platform-send boundary.
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { formatErrorMessage } from "../errors.js";
import {
  OutboundDeliveryError,
  type OutboundDeliveryQueuePolicy,
  type PlatformSendRoute,
} from "./deliver-types.js";
import { retireUnsentDelivery } from "./delivery-queue-ack.js";
import { releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import {
  ackDelivery,
  failDelivery,
  failDeliveryAfterPlatformSend,
  markDeliveryPlatformOutcomeUnknown,
  markDeliveryPlatformSendAttemptStarted,
  moveToFailed,
} from "./delivery-queue-storage.js";

const log = createSubsystemLogger("outbound/deliver");

export type QueuedPostSendState = "marked" | "acked" | "failed";

export type QueuedPreSendState = "marked" | "acked";

type QueuedDeliveryFailureRecorder = typeof failDelivery | typeof failDeliveryAfterPlatformSend;

/** Keeps live and recovered queue transitions on the same producer claim. */
export function createQueuedDeliveryOwner(params: {
  queueId: string;
  stateDir?: string;
  expectedPlatformSendAttemptId?: string | null;
  signal?: AbortSignal;
}) {
  let custody: "held" | "released" = "held";
  const owner = {
    queueId: params.queueId,
    stateDir: params.stateDir,
    claimId: params.expectedPlatformSendAttemptId,
    signal: params.signal,
    get custody() {
      return custody;
    },
    project(
      error: unknown,
      evidence?: Omit<ConstructorParameters<typeof OutboundDeliveryError>[1], "cause">,
    ): OutboundDeliveryError {
      const failure =
        error instanceof OutboundDeliveryError
          ? error
          : new OutboundDeliveryError(formatErrorMessage(error), {
              cause: error,
              ...evidence,
            });
      failure.queueCustody = custody;
      return failure;
    },
    retireUnsent(): ReturnType<typeof retireUnsentDelivery> {
      owner.signal?.throwIfAborted();
      if (!owner.claimId) {
        return undefined;
      }
      const release = retireUnsentDelivery({
        id: owner.queueId,
        producerClaimId: owner.claimId,
        stateDir: owner.stateDir,
      });
      // Cleanup is returned only after the exact unsent claim has been retired.
      if (release) {
        custody = "released";
      }
      return release;
    },
    async ack(options?: Parameters<typeof ackDelivery>[2]): Promise<void> {
      owner.signal?.throwIfAborted();
      await ackDelivery(owner.queueId, owner.stateDir, {
        ...options,
        ...(owner.claimId !== undefined ? { expectedPlatformSendAttemptId: owner.claimId } : {}),
      });
      custody = "released";
    },
    fail(record: QueuedDeliveryFailureRecorder, error: string): Promise<void> {
      owner.signal?.throwIfAborted();
      return record(owner.queueId, error, owner.stateDir, owner.claimId);
    },
    async retire(): Promise<void> {
      owner.signal?.throwIfAborted();
      const spooled = await moveToFailed(owner.queueId, owner.stateDir, owner.claimId ?? null);
      custody = "released";
      await releaseSpoolArtifacts(spooled, owner.stateDir);
    },
  };
  return owner;
}

export type QueuedDeliveryOwner = ReturnType<typeof createQueuedDeliveryOwner>;

export async function persistQueuedPreSendState(params: {
  owner: QueuedDeliveryOwner;
  queuePolicy: OutboundDeliveryQueuePolicy;
  route: PlatformSendRoute;
  retainSpoolArtifacts?: boolean;
}): Promise<QueuedPreSendState> {
  const { owner } = params;
  owner.signal?.throwIfAborted();
  try {
    const route = { replyToId: params.route.replyToId ?? null };
    if (owner.claimId) {
      await markDeliveryPlatformSendAttemptStarted(
        owner.queueId,
        owner.stateDir,
        route,
        owner.claimId,
      );
    } else {
      await markDeliveryPlatformSendAttemptStarted(owner.queueId, owner.stateDir, route);
    }
    return "marked";
  } catch (markErr: unknown) {
    if (params.queuePolicy === "required") {
      throw markErr;
    }
    log.warn(
      `failed to mark queued delivery ${owner.queueId} as platform-send-attempt-started; removing replay intent before best-effort send: ${formatErrorMessage(markErr)}`,
    );
    // Remove only the exact owner before crossing the platform boundary. A lost
    // claim or failed ack aborts the send instead of erasing a replacement owner.
    await owner.ack(params.retainSpoolArtifacts ? { retainSpoolArtifacts: true } : undefined);
    return "acked";
  }
}

export async function persistQueuedPostSendState(params: {
  owner: QueuedDeliveryOwner;
  queuePolicy: OutboundDeliveryQueuePolicy;
  preserveBatch?: boolean;
  retainSpoolArtifacts?: boolean;
  onPostSendMarkerError?: (error: unknown) => void;
}): Promise<QueuedPostSendState> {
  const { owner } = params;
  owner.signal?.throwIfAborted();
  try {
    await markDeliveryPlatformOutcomeUnknown(owner.queueId, owner.stateDir, owner.claimId);
    return "marked";
  } catch (markErr: unknown) {
    if (params.preserveBatch) {
      // A bounded batch may still contain identityless later payloads. Its
      // intermediate state must never become a premature success receipt.
      await owner.fail(
        failDeliveryAfterPlatformSend,
        `post-send state persistence failed: ${formatErrorMessage(markErr)}`,
      );
      return "failed";
    }
    params.onPostSendMarkerError?.(markErr);
    log.warn(
      `failed to mark queued delivery ${owner.queueId} as platform-outcome-unknown; falling back to direct ack (${params.queuePolicy}): ${formatErrorMessage(markErr)}`,
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
