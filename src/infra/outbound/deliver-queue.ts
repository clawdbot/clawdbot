// Owns durable queue admission and hands stable custody to the execution loop.
import { deriveDurableFinalDeliveryRequirementsForBatch } from "../../channels/message/capabilities.js";
import { createRenderedMessageBatchPlan } from "../../channels/message/rendered-batch.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { formatErrorMessage } from "../errors.js";
import { resolveDeferredDeliveryAdmission } from "./deferred-delivery-admission.js";
import { resolveOutboundDurableFinalDeliverySupport } from "./deliver-channel.js";
import type { DeliverOutboundPayloadsParams } from "./deliver-contracts.js";
import { OUTBOUND_DELIVERY_LOG_SCOPE } from "./deliver-log.js";
import { buildPayloadSummary } from "./deliver-payload.js";
import { OutboundPayloadPreparationError, prepareOutboundPayloadBatch } from "./deliver-prepare.js";
import {
  restoreQueuedDeliveryCustody,
  stageAndEnqueueOutboundDelivery,
} from "./deliver-queue-admission.js";
import { deliverOutboundPayloadsWithQueueCleanup } from "./deliver-queue-execute.js";
import type { OutboundDeliveryResult } from "./deliver-types.js";
import { startDeliveryProducerLease } from "./delivery-queue-lease.js";
import {
  StableDeliveryPreparationLostError,
  withStableDeliveryPreparation,
  type StableDeliveryPreparationOwner,
} from "./delivery-queue-preparation.js";
import { findDeliveryIntentOwner, loadPendingDelivery } from "./delivery-queue-storage.js";
import {
  claimReusableDeliveryPlatformSendAttempt,
  renewDeliveryPlatformSendLease,
  withActiveDeliveryClaim,
} from "./delivery-queue.js";
import { createMessageSentEmitter } from "./message-sent-hook.js";
import { emitOutboundAuditTerminals, uniformOutboundAuditTerminals } from "./outbound-audit.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

export async function runOutboundDelivery(
  params: DeliverOutboundPayloadsParams,
): Promise<OutboundDeliveryResult[]> {
  return await runOutboundDeliveryInternal(params);
}

export async function runOutboundDeliveryInternal(
  params: DeliverOutboundPayloadsParams,
): Promise<OutboundDeliveryResult[]> {
  const stableIntentId = params.deliveryIntentId?.trim();
  if (stableIntentId) {
    const stableParams =
      stableIntentId === params.deliveryIntentId
        ? params
        : { ...params, deliveryIntentId: stableIntentId };
    // Serializing preparation prevents concurrent producers from running
    // stateful modifiers before SQLite chooses the stable delivery owner.
    const claim = await withActiveDeliveryClaim(stableIntentId, async () => {
      const preparation = await withStableDeliveryPreparation({
        id: stableIntentId,
        run: async (owner) => await runOutboundDeliveryWithQueue(stableParams, true, owner),
      });
      return preparation.status === "claimed"
        ? preparation.value
        : await runOutboundDeliveryWithQueue(stableParams, true, undefined, false);
    });
    if (claim.status === "claimed") {
      return claim.value;
    }
    throw new Error(`Stable delivery intent is already queued: ${stableIntentId}`);
  }
  return await runOutboundDeliveryWithQueue(params, false);
}

async function deliverWithProducerLease(
  params: DeliverOutboundPayloadsParams,
  queueId: string | null,
  auditStartedAt: number,
  producerClaimId?: string,
): Promise<OutboundDeliveryResult[]> {
  if (params.deliveryProducerLeaseRequired !== true) {
    return await deliverOutboundPayloadsWithQueueCleanup(
      params,
      queueId,
      auditStartedAt,
      producerClaimId,
    );
  }
  const platformQueueId = queueId ?? params.deliveryQueueId;
  if (!platformQueueId || !producerClaimId) {
    throw new Error("Stable delivery producer lease requires an exact queue owner");
  }
  const stateDir = queueId ? undefined : params.deliveryQueueStateDir;
  const lease = await startDeliveryProducerLease({
    id: platformQueueId,
    renew: async () =>
      await renewDeliveryPlatformSendLease(platformQueueId, stateDir, producerClaimId),
  });
  const abortSignal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, lease.signal])
    : lease.signal;
  try {
    return await deliverOutboundPayloadsWithQueueCleanup(
      { ...params, abortSignal },
      queueId,
      auditStartedAt,
      producerClaimId,
      lease.signal,
    );
  } finally {
    lease.stop();
  }
}

async function runOutboundDeliveryWithQueue(
  params: DeliverOutboundPayloadsParams,
  stableIntentClaimHeld: boolean,
  stablePreparationOwner?: StableDeliveryPreparationOwner,
  allowFreshPreparation = true,
): Promise<OutboundDeliveryResult[]> {
  const auditStartedAt = Date.now();
  const { channel, to, payloads } = params;
  const emitPreQueueFailure = (): void => {
    // Recovery owns the stable queue terminal for replayed intents.
    if (params.deliveryQueueId !== undefined) {
      return;
    }
    emitOutboundAuditTerminals({
      context: params,
      terminals: () =>
        uniformOutboundAuditTerminals(params.payloads.length, {
          outcome: "failed",
          failureStage: "queue",
        }),
      startedAt: auditStartedAt,
    });
  };
  if (params.requireUnknownSendReconciliation === true && payloads.length !== 1) {
    emitPreQueueFailure();
    throw new Error(
      `Required durable message send is unsupported for ${channel}: unknown-send reconciliation requires exactly one payload`,
    );
  }
  if (params.deferredDeliveryAdmissionPassed !== true) {
    const admission = resolveDeferredDeliveryAdmission({
      cfg: params.cfg,
      channel,
      to,
      accountId: params.accountId,
      phase: "live",
    });
    if (admission.status === "permanent_rejection") {
      emitPreQueueFailure();
      throw new Error(admission.reason);
    }
  }
  const queuePolicy = params.queuePolicy ?? "best_effort";
  const existingStableDelivery = params.deliveryIntentId
    ? await loadPendingDelivery(params.deliveryIntentId)
    : null;
  if (params.deliveryIntentId && !existingStableDelivery && !stablePreparationOwner) {
    const owner = findDeliveryIntentOwner(params.deliveryIntentId);
    if (owner) {
      throw new Error(
        owner.namespace === "legacy"
          ? `Stable delivery intent is awaiting queue migration: ${params.deliveryIntentId}`
          : `Stable delivery intent is already queued: ${params.deliveryIntentId}`,
      );
    }
  }
  if (params.deliveryIntentId && !existingStableDelivery && !allowFreshPreparation) {
    throw new Error(`Stable delivery intent is already queued: ${params.deliveryIntentId}`);
  }
  if (existingStableDelivery && !params.reusePendingDeliveryIntent) {
    throw new Error(`Stable delivery intent is already queued: ${params.deliveryIntentId}`);
  }
  let preparedBatch;
  try {
    // Modifying policy is intentionally a pre-admission boundary. Persisting
    // raw content before it is cancelled or redacted would recreate the leak
    // this queue contract removes; queue durability begins at prepared custody.
    preparedBatch =
      existingStableDelivery?.preparedBatch ??
      params.preparedBatch ??
      (await prepareOutboundPayloadBatch(params, {
        onBeforeFirstModifier: stablePreparationOwner?.beforeFirstModifier,
      }));
    stablePreparationOwner?.markPrepared();
  } catch (error) {
    emitPreQueueFailure();
    const failedPayload =
      error instanceof OutboundPayloadPreparationError ? error.payload : params.payloads[0];
    if (failedPayload) {
      const summary = buildPayloadSummary(failedPayload);
      const { emitMessageSent } = createMessageSentEmitter({
        hookRunner: getGlobalHookRunner(),
        channel,
        to,
        accountId: params.accountId,
        sessionKeyForInternalHooks: params.mirror?.sessionKey ?? params.session?.key,
        isGroup: params.mirror?.isGroup,
        groupId: params.mirror?.groupId,
        runId: params.replyPayloadSendingHook?.runId,
        logPrefix: OUTBOUND_DELIVERY_LOG_SCOPE,
      });
      emitMessageSent({
        success: false,
        content: summary.hookContent ?? summary.text,
        error: formatErrorMessage(error),
      });
    }
    throw error;
  }
  const preparedPayloads = acceptedPreparedOutboundEntries(preparedBatch).map(
    (entry) => entry.payload,
  );
  const preparedRenderedBatchPlan =
    existingStableDelivery?.renderedBatchPlan ??
    (params.preparedBatch ? params.renderedBatchPlan : undefined) ??
    createRenderedMessageBatchPlan(preparedPayloads);
  let unknownSendReconciliationEnabled = params.requireUnknownSendReconciliation === true;
  if (params.requireUnknownSendReconciliation !== false && preparedPayloads.length === 1) {
    const requirements = deriveDurableFinalDeliveryRequirementsForBatch({
      payloads: preparedPayloads,
      replyToId: params.replyToId,
      threadId: params.threadId,
      silent: params.silent,
      reconcileUnknownSend: true,
    });
    delete requirements.messageSendingHooks;
    const support = await resolveOutboundDurableFinalDeliverySupport({
      cfg: params.cfg,
      channel,
      requirements,
    });
    if (params.requireUnknownSendReconciliation === true && !support.ok) {
      emitPreQueueFailure();
      throw new Error(
        `Required durable message send is unsupported for ${channel}: prepared payload capability mismatch${support.capability ? ` (${support.capability})` : ""}`,
      );
    }
    unknownSendReconciliationEnabled =
      support.ok &&
      (params.requireUnknownSendReconciliation === true ||
        support.automaticUnknownSendReconciliation);
  }
  const deliveryParams: DeliverOutboundPayloadsParams = {
    ...params,
    payloads: preparedPayloads,
    preparedBatch,
    // Recovery must preserve the provider-facing plan captured before local
    // media was rewritten to spool paths; reconciliation uses that same plan.
    renderedBatchPlan: preparedRenderedBatchPlan,
    ...(unknownSendReconciliationEnabled ? { requireUnknownSendReconciliation: true } : {}),
  };

  // Invocation authority is not queued; recovery must re-enter delegated after restart.
  // Write-ahead delivery queue: persist before sending, remove after success.
  const shouldPersistSuppressedIntent = Boolean(
    params.deliveryIntentId || params.deliveryCompletion || params.completionRetention,
  );
  const queued =
    params.skipQueue || (preparedPayloads.length === 0 && !shouldPersistSuppressedIntent)
      ? null
      : await stageAndEnqueueOutboundDelivery(
          deliveryParams,
          preparedBatch,
          stablePreparationOwner
            ? { getStablePreparation: stablePreparationOwner.current }
            : undefined,
        ).catch((err: unknown) => {
          if (queuePolicy === "required" || err instanceof StableDeliveryPreparationLostError) {
            emitPreQueueFailure();
            throw err;
          }
          return null;
        }); // Best-effort delivery falls back to direct send if staging or the queue write fails.

  const queueId = queued?.id ?? null;
  if (queued?.created && stablePreparationOwner) {
    stablePreparationOwner.markPublished();
  }
  if (queueId) {
    params.onDeliveryIntent?.({
      id: queueId,
      channel,
      to,
      ...(params.accountId ? { accountId: params.accountId } : {}),
      queuePolicy,
    });
  }

  if (!queueId) {
    return await deliverWithProducerLease(
      deliveryParams,
      null,
      auditStartedAt,
      params.deliveryProducerClaimId,
    );
  }

  if (!queued?.created && !params.reusePendingDeliveryIntent) {
    throw new Error(`Stable delivery intent is already queued: ${queueId}`);
  }
  const deliverClaimedIntent = async (): Promise<OutboundDeliveryResult[]> => {
    const producerClaimId = params.reusePendingDeliveryIntent
      ? await claimReusableDeliveryPlatformSendAttempt(queueId)
      : undefined;
    if (params.reusePendingDeliveryIntent && !producerClaimId) {
      throw new Error(`Stable delivery intent is already queued: ${queueId}`);
    }
    let claimedDeliveryParams: DeliverOutboundPayloadsParams =
      params.reusePendingDeliveryIntent && queued?.created === true
        ? { ...deliveryParams, deliveryProducerLeaseRequired: true }
        : deliveryParams;
    if (queued?.created !== true) {
      const queuedEntry = await loadPendingDelivery(queueId);
      if (!queuedEntry || queuedEntry.producerClaimId !== producerClaimId) {
        throw new Error(`Stable delivery platform claim was lost: ${queueId}`);
      }
      const restoredDeliveryParams = restoreQueuedDeliveryCustody(deliveryParams, queuedEntry);
      claimedDeliveryParams =
        queuedEntry.requiresProducerClaim === true
          ? { ...restoredDeliveryParams, deliveryProducerLeaseRequired: true }
          : restoredDeliveryParams;
    }
    return deliverWithProducerLease(
      claimedDeliveryParams,
      queueId,
      auditStartedAt,
      producerClaimId,
    );
  };
  if (stableIntentClaimHeld) {
    return await deliverClaimedIntent();
  }
  const claimResult = await withActiveDeliveryClaim(queueId, deliverClaimedIntent);
  if (claimResult.status === "claimed") {
    return claimResult.value;
  }
  if (params.reusePendingDeliveryIntent) {
    throw new Error(`Stable delivery intent is already queued: ${queueId}`);
  }
  return [];
}
