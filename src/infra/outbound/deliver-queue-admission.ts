// Owns durable outbound admission, immutable payload custody, and media staging.
import type { ReplyPayload } from "../../auto-reply/types.js";
import { createRenderedMessageBatchPlan } from "../../channels/message/rendered-batch.js";
import { resolveOutboundMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { resolveChannelOutboundDirectiveOptions } from "./deliver-channel.js";
import type { DeliverOutboundPayloadsParams } from "./deliver-contracts.js";
import {
  collectPayloadMediaSources,
  resolveOutboundMediaAccessForSend,
  stripInternalRuntimeScaffoldingFromPayload,
} from "./deliver-payload.js";
import { releaseSpoolArtifacts, stageQueuePayloadMedia } from "./delivery-queue-media-spool.js";
import { cancelDeliveryQueueMediaStage } from "./delivery-queue-media-staging.js";
import { loadPendingDelivery, type QueuedDelivery } from "./delivery-queue-storage.js";
import { enqueueDelivery, enqueueDeliveryOnce } from "./delivery-queue.js";
import { createOutboundPayloadPlan, type OutboundPayloadPlan } from "./payloads.js";

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
    ...custody
  } = entry;
  return { ...params, ...custody };
}

function materializeQueueCustodyMedia(
  payloads: readonly ReplyPayload[],
  plan: readonly OutboundPayloadPlan[],
): ReplyPayload[] {
  const effectiveBySource = new Map(
    plan.map((entry) => [entry.sourceIndex, entry.parts.mediaUrls] as const),
  );
  return payloads.map((payload, index) => {
    const effective = effectiveBySource.get(index);
    if (!effective?.length) {
      return payload;
    }
    const structured = new Set(
      [payload.mediaUrl, ...(payload.mediaUrls ?? [])]
        .map((url) => url?.trim())
        .filter((url): url is string => Boolean(url)),
    );
    if (effective.every((url) => structured.has(url))) {
      return payload;
    }
    // Keep raw pre-hook text for deterministic replay. The singular anchor
    // prevents recovery from re-adding its original MEDIA: path.
    return { ...payload, mediaUrl: effective[0], mediaUrls: [...effective] };
  });
}

/** Stages producer-owned media and atomically admits one durable outbound intent. */
export async function stageAndEnqueueOutboundDelivery(
  params: DeliverOutboundPayloadsParams,
): Promise<{ id: string; created: boolean } | null> {
  const { channel, to, payloads } = params;
  const queuePolicy = params.queuePolicy ?? "best_effort";
  const strippedQueuePayloads = payloads.map(stripInternalRuntimeScaffoldingFromPayload);
  const renderedBatchPlan =
    params.renderedBatchPlan ?? createRenderedMessageBatchPlan(params.payloads);

  if (params.deliveryIntentId && params.reusePendingDeliveryIntent) {
    const existing = await loadPendingDelivery(params.deliveryIntentId);
    if (existing) {
      // Durable custody owns its already-staged media. A regenerated TTS or
      // producer file may have vanished, so claim the row before staging it.
      return { id: existing.id, created: false };
    }
  }
  // Legacy `MEDIA:` text directives carry local media that only materializes
  // into structured fields at send time, so the spool (which reads structured
  // media) would skip it and a retry would read the vanished producer path.
  // Project each source payload's effective media through the same canonical
  // plan the live send uses and fold directive-derived sources into the queue
  // copy's structured media before staging. The raw payload and its pre-hook
  // text are untouched, so the live send below stays copy-free on the original.
  const directiveOptions = await resolveChannelOutboundDirectiveOptions({
    cfg: params.cfg,
    channel,
  });
  const queueCustodyPayloads = materializeQueueCustodyMedia(
    strippedQueuePayloads,
    createOutboundPayloadPlan(strippedQueuePayloads, {
      cfg: params.cfg,
      sessionKey: params.session?.policyKey ?? params.session?.key,
      surface: channel,
      conversationType: params.session?.conversationType,
      extractMarkdownImages: directiveOptions.extractMarkdownImages,
    }),
  );
  const queuePayloadsChanged = queueCustodyPayloads.some(
    (payload, index) => payload !== payloads[index],
  );
  // Media staging only rewrites source URLs one-for-one, so the plan stays keyed
  // to the custody payload counts rather than to which copy the row references;
  // recovery replays entry.payloads and this plan together. Materialized custody
  // anchors mediaUrl to the effective set (to override the in-text directive on
  // replay), so count fan-out from mediaUrls alone for payloads we rewrote to
  // keep the plan aligned with the deduped effective media recovery re-derives.
  const renderPlanPayloads = queueCustodyPayloads.map((payload, index) =>
    payload === strippedQueuePayloads[index] ? payload : { ...payload, mediaUrl: undefined },
  );
  const queueRenderedBatchPlan = queuePayloadsChanged
    ? createRenderedMessageBatchPlan(renderPlanPayloads)
    : renderedBatchPlan;
  // A durable row must not outlive its media. Producer-owned local sources
  // (TTS temps above all) are deleted when this process exits, so the queue
  // takes its own copy first and the row references that; the live send below
  // keeps the original path and stays copy-free.
  const staged = await stageQueuePayloadMedia({
    payloads: queueCustodyPayloads,
    // Resolved exactly as the live send resolves it: staging must neither
    // reject media the send would deliver (agent workspace sources are only
    // reachable through the agent-scoped roots) nor read more than the send may.
    mediaAccess: resolveOutboundMediaAccessForSend(
      params,
      channel,
      collectPayloadMediaSources(queueCustodyPayloads),
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
    const delivery = {
      channel,
      to,
      accountId: params.accountId,
      queuePolicy,
      requireUnknownSendReconciliation: params.requireUnknownSendReconciliation,
      ...(params.reusePendingDeliveryIntent ? { requiresProducerClaim: true } : {}),
      payloads: staged.payloads,
      renderedBatchPlan: queueRenderedBatchPlan,
      threadId: params.threadId,
      replyToId: params.replyToId,
      replyToMode: params.replyToMode,
      formatting: params.formatting,
      identity: params.identity,
      bestEffort: params.bestEffort,
      gifPlayback: params.gifPlayback,
      forceDocument: params.forceDocument,
      replyPayloadSendingHook: params.replyPayloadSendingHook,
      silent: params.silent,
      mirror: params.mirror,
      session: params.session,
      gatewayClientScopes: params.gatewayClientScopes,
      preparedMessageId: params.preparedMessageId,
      completionRetention: params.completionRetention,
      deliveryCompletion: params.deliveryCompletion,
    };
    if (params.deliveryIntentId) {
      const queued = await enqueueDeliveryOnce(
        delivery,
        params.deliveryIntentId,
        undefined,
        staged.mediaStageId,
      );
      if (!queued.created) {
        cancelDeliveryQueueMediaStage(staged.mediaStageId);
        await releaseSpoolArtifacts(staged.artifacts);
      }
      return queued;
    }
    const id = staged.mediaStageId
      ? await enqueueDelivery(delivery, undefined, staged.mediaStageId)
      : await enqueueDelivery(delivery);
    return { id, created: true };
  } catch (err) {
    cancelDeliveryQueueMediaStage(staged.mediaStageId);
    await releaseSpoolArtifacts(staged.artifacts);
    throw err;
  }
}
