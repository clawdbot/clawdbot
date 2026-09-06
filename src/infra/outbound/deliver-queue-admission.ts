// Owns durable outbound admission, immutable payload custody, and media staging.
import { createRenderedMessageBatchPlan } from "../../channels/message/rendered-batch.js";
import { resolveOutboundMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { createInitialDeliveryProducerClaim } from "../delivery-queue-sqlite-claim.js";
import type { DeliverOutboundPayloadsParams } from "./deliver-contracts.js";
import {
  collectPayloadMediaSources,
  resolveOutboundMediaAccessForSend,
  stripInternalRuntimeScaffoldingFromPayload,
} from "./deliver-payload.js";
import { releaseSpoolArtifacts, stageQueuePayloadMedia } from "./delivery-queue-media-spool.js";
import { cancelDeliveryQueueMediaRetention } from "./delivery-queue-media-staging.js";
import type { StableDeliveryPreparation } from "./delivery-queue-preparation.js";
import {
  loadPendingDelivery,
  type QueuedDelivery,
  enqueueDelivery,
  enqueueDeliveryOnce,
  enqueuePreparedDeliveryOnce,
} from "./delivery-queue-storage.js";
import {
  acceptedPreparedOutboundEntries,
  mapPreparedOutboundAcceptedPayloads,
  type PreparedOutboundBatch,
} from "./prepared-batch.js";
import { normalizeOutboundReplyFacts } from "./reply-policy.js";

export function restoreQueuedDeliveryCustody(
  params: DeliverOutboundPayloadsParams,
  entry: QueuedDelivery,
): DeliverOutboundPayloadsParams {
  // A regenerated caller owns current runtime authority, never the durable
  // effect. Recipient, staged payload, and completion stay with the first row.
  const {
    id: _id,
    enqueuedAt: _enqueuedAt,
    retryCount: _retryCount,
    attemptCount: _attemptCount,
    requiresProducerClaim: _requiresProducerClaim,
    availableAt: _availableAt,
    producerClaimId: _producerClaimId,
    lastAttemptAt: _lastAttemptAt,
    lastError: _lastError,
    platformSendAttemptId: _platformSendAttemptId,
    platformSendStartedAt: _platformSendStartedAt,
    effectiveReplyToId: _effectiveReplyToId,
    recoveryState: _recoveryState,
    maxRetries: _maxRetries,
    legacyUnknownSendReconciliation: _legacyUnknownSendReconciliation,
    legacyPreparedContentUnavailable: _legacyPreparedContentUnavailable,
    ...custody
  } = entry;
  const payloads = acceptedPreparedOutboundEntries(custody.preparedBatch).map(
    (prepared) => prepared.payload,
  );
  return { ...params, ...custody, payloads };
}

/** Stages producer-owned media and atomically admits one durable outbound intent. */
export async function stageAndEnqueueOutboundDelivery(
  params: DeliverOutboundPayloadsParams,
  preparedBatch: PreparedOutboundBatch,
  options?: {
    getStablePreparation?: () => StableDeliveryPreparation;
    claimForLiveDelivery?: boolean;
  },
): Promise<{ id: string; created: boolean; producerClaimId?: string } | null> {
  const { channel, to } = params;
  const queuePolicy = params.queuePolicy ?? "best_effort";
  const acceptedPayloads = acceptedPreparedOutboundEntries(preparedBatch).map((entry) =>
    stripInternalRuntimeScaffoldingFromPayload(entry.payload),
  );
  const renderedBatchPlan =
    params.renderedBatchPlan ?? createRenderedMessageBatchPlan(acceptedPayloads);

  if (params.deliveryIntentId && params.reusePendingDeliveryIntent) {
    const existing = await loadPendingDelivery(params.deliveryIntentId);
    if (existing) {
      // Durable custody owns its already-staged media. A regenerated TTS or
      // producer file may have vanished, so claim the row before staging it.
      return { id: existing.id, created: false };
    }
  }
  // A durable row must not outlive its media. Producer-owned local sources
  // (TTS temps above all) are deleted when this process exits, so the queue
  // takes its own copy first and the row references that; the live send below
  // keeps the original path and stays copy-free.
  const staged = await stageQueuePayloadMedia({
    payloads: acceptedPayloads,
    // Resolved exactly as the live send resolves it: staging must neither
    // reject media the send would deliver (agent workspace sources are only
    // reachable through the agent-scoped roots) nor read more than the send may.
    mediaAccess: resolveOutboundMediaAccessForSend(
      params,
      channel,
      collectPayloadMediaSources(acceptedPayloads),
    ),
    maxBytes: resolveOutboundMediaMaxBytes({
      cfg: params.cfg,
      channel,
      accountId: params.accountId,
    }),
  });
  if (staged.status !== "staged") {
    // Sensitive media must reach neither the spool nor the row, so there is no
    // replayable copy to promise. Required sends fail closed instead of
    // persisting an unreplayable row; best-effort degrades to a live-only send.
    if (queuePolicy === "required") {
      throw new Error(
        `Required durable message send is unsupported for ${channel}: ${staged.reason} cannot be persisted`,
      );
    }
    return null;
  }
  try {
    const initialProducerClaim = options?.claimForLiveDelivery
      ? createInitialDeliveryProducerClaim()
      : undefined;
    const queuedPreparedBatch = mapPreparedOutboundAcceptedPayloads(preparedBatch, staged.payloads);
    const delivery = {
      channel,
      to,
      accountId: params.accountId,
      queuePolicy,
      requireUnknownSendReconciliation: params.requireUnknownSendReconciliation,
      ...(params.reusePendingDeliveryIntent ? { requiresProducerClaim: true } : {}),
      ...(initialProducerClaim ? { initialProducerClaim } : {}),
      preparedBatch: queuedPreparedBatch,
      renderedBatchPlan,
      threadId: params.threadId,
      reply: normalizeOutboundReplyFacts(params),
      formatting: params.formatting,
      identity: params.identity,
      bestEffort: params.bestEffort,
      gifPlayback: params.gifPlayback,
      forceDocument: params.forceDocument,
      silent: params.silent,
      mirror: params.mirror,
      session: params.session,
      gatewayClientScopes: params.gatewayClientScopes,
      preparedMessageId: params.preparedMessageId,
      completionRetention: params.completionRetention,
      maxRetries: params.maxRetries,
      deliveryCompletion: params.deliveryCompletion,
    };
    if (params.deliveryIntentId) {
      const queued = options?.getStablePreparation
        ? await enqueuePreparedDeliveryOnce(
            delivery,
            params.deliveryIntentId,
            options.getStablePreparation(),
            undefined,
            staged.mediaStageId,
          )
        : await enqueueDeliveryOnce(
            delivery,
            params.deliveryIntentId,
            undefined,
            staged.mediaStageId,
          );
      if (!queued.created) {
        cancelDeliveryQueueMediaRetention(staged.mediaStageId);
        await releaseSpoolArtifacts(staged.artifacts);
      }
      return {
        ...queued,
        ...(queued.created && initialProducerClaim
          ? { producerClaimId: initialProducerClaim.producerClaimId }
          : {}),
      };
    }
    const id = await enqueueDelivery(delivery, undefined, staged.mediaStageId);
    return {
      id,
      created: true,
      ...(initialProducerClaim ? { producerClaimId: initialProducerClaim.producerClaimId } : {}),
    };
  } catch (err) {
    cancelDeliveryQueueMediaRetention(staged.mediaStageId);
    await releaseSpoolArtifacts(staged.artifacts);
    throw err;
  }
}
