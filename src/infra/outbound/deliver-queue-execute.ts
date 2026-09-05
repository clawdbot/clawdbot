// Owns queued delivery execution, custody transitions, and terminal cleanup.
import type { AuditMessageFailureStage } from "../../audit/audit-event-types.js";
import { assertSessionWriterDeliveryAuthorized } from "../../auto-reply/reply/session-writer-delivery-authority.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  findPlatformMessageRejectedError,
  isProvenDeliveryNotSentError,
} from "../delivery-recovery.shared.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import type { DeliverOutboundPayloadsParams, PlatformSendRoute } from "./deliver-contracts.js";
import { deliverOutboundPayloadsCore } from "./deliver-core.js";
import { OUTBOUND_DELIVERY_LOG_SCOPE } from "./deliver-log.js";
import {
  createQueuedDeliveryOwner,
  isDeliveryAbortError,
  persistQueuedPostSendState,
  persistQueuedPreSendState,
  type QueuedPostSendState,
  type QueuedPreSendState,
} from "./deliver-queue-state.js";
import {
  areOutboundPayloadsIntentionallySuppressed,
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
  isOutboundDeliveryAdmissionClosedError,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import { runOutboundDeliveryCommitHooks } from "./delivery-commit-hooks.js";
import { rejectDurableDelivery, settleDurableDelivery } from "./delivery-completion.js";
import { retireUnsentDelivery } from "./delivery-queue-ack.js";
import type { DeliveryProducerLease } from "./delivery-queue-lease.js";
import { releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import {
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  markDeliveryPlatformSendDispatched,
  moveToFailed,
} from "./delivery-queue-storage.js";
import { createMessageSentEmitter, type MessageSentEvent } from "./message-sent-hook.js";
import {
  completedOutboundAuditTerminals,
  emitOutboundAuditLifecycle,
  emitOutboundAuditTerminals,
  failedOutboundAuditTerminals,
  uniformOutboundAuditTerminals,
} from "./outbound-audit.js";
import type { NormalizedOutboundPayload } from "./payloads.js";

const log = createSubsystemLogger("outbound/deliver");

export async function deliverOutboundPayloadsWithQueueCleanup(
  params: DeliverOutboundPayloadsParams,
  queueId: string | null,
  auditStartedAt: number,
  producerClaimId?: string,
  producerLease?: DeliveryProducerLease,
): Promise<OutboundDeliveryResult[]> {
  // Lease loss revokes queue mutation authority. Caller cancellation still
  // follows the normal abort cleanup path through the combined signal.
  const throwIfProducerLeaseLost = (): void => {
    if (producerLease?.signal.aborted) {
      throw producerLease.signal.reason;
    }
  };
  const payloadCount = params.preparedBatch?.sourcePayloadCount ?? params.payloads.length;
  const ownsAuditTerminal = params.deliveryQueueId === undefined;
  // Terminal evidence belongs to delivery custody, independently of audit subscribers.
  const payloadOutcomes: OutboundPayloadDeliveryOutcome[] = [];
  const reusableProducerClaimId = params.reusePendingDeliveryIntent ? producerClaimId : undefined;
  const queuePolicy = params.queuePolicy ?? "best_effort";
  const platformQueueId = queueId ?? params.deliveryQueueId;
  const platformQueuePolicy = queueId ? queuePolicy : (params.queuePolicy ?? "required");
  const platformQueueStateDir = queueId ? undefined : params.deliveryQueueStateDir;
  const exactReconciliationRequired =
    params.requireUnknownSendReconciliation === true && platformQueueId !== undefined;
  let queuedPreSendState: QueuedPreSendState | undefined;
  let queuedPostSendState: QueuedPostSendState | undefined;
  let platformSendStarted = false;
  let platformSendRoute: PlatformSendRoute | undefined;
  let platformSendSourceIndex: number | undefined;
  const auditPlatformStartedPayloads = new Set<number>();
  const platformDispatchedPayloads = new Set<number>();
  let deliveredResults: OutboundDeliveryResult[] = [];
  let allPayloadsSuppressed = false;
  let commitHooksRun = false;
  const settleDeliveryCompletion = async (
    result: OutboundDeliveryResult | undefined,
  ): Promise<void> => {
    if (!params.deliveryCompletion) {
      return;
    }
    await settleDurableDelivery(
      params.deliveryCompletion,
      result ? { result } : { platformSendStarted: platformSendStarted && !allPayloadsSuppressed },
      platformQueueStateDir,
    );
  };
  // Deliberately process-local: message_sent is best-effort after queue
  // settlement, not a durable plugin outbox or a reason to retry delivery.
  const messageSentEvents: MessageSentEvent[] = [];
  const sessionKeyForInternalHooks = params.mirror?.sessionKey ?? params.session?.key;
  const { emitMessageSent, hasMessageSentHooks } = createMessageSentEmitter({
    hookRunner: getGlobalHookRunner(),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    sessionKeyForInternalHooks,
    isGroup: params.mirror?.isGroup,
    groupId: params.mirror?.groupId,
    runId: params.preparedBatch?.runId,
    logPrefix: OUTBOUND_DELIVERY_LOG_SCOPE,
  });
  if (hasMessageSentHooks && params.session?.agentId && !sessionKeyForInternalHooks) {
    log.warn(
      `${OUTBOUND_DELIVERY_LOG_SCOPE}: session.agentId present without session key; internal message:sent hook will be skipped`,
      { channel: params.channel, to: params.to, agentId: params.session.agentId },
    );
  }
  const flushMessageSentEvents = (): void => {
    if (params.deferCommitHooks) {
      return;
    }
    for (const event of messageSentEvents) {
      emitMessageSent(event);
    }
    messageSentEvents.length = 0;
  };
  const queueOwner = queueId
    ? createQueuedDeliveryOwner({
        queueId,
        expectedPlatformSendAttemptId: () => producerClaimId,
      })
    : undefined;
  const ackOwnedQueue = (options?: { suppressCompletionReceipt?: boolean }) => {
    throwIfProducerLeaseLost();
    if (!queueOwner) {
      throw new Error("Queued delivery acknowledgement requires a queue id");
    }
    return queueOwner.ack(options);
  };
  const recordOwnedQueueFailure = (
    record: typeof failDelivery | typeof failDeliveryAfterPlatformSend,
    error: string,
  ) => {
    throwIfProducerLeaseLost();
    if (!queueOwner) {
      throw new Error("Queued delivery failure requires a queue id");
    }
    return queueOwner.fail(record, error);
  };
  const persistOwnedPostSendState = () => {
    throwIfProducerLeaseLost();
    if (!queueId) {
      throw new Error("Queued delivery post-send state requires a queue id");
    }
    return persistQueuedPostSendState({
      queueId,
      queuePolicy,
      ...(reusableProducerClaimId ? { producerClaimId: reusableProducerClaimId } : {}),
      ...(producerClaimId ? { expectedPlatformSendAttemptId: producerClaimId } : {}),
    });
  };
  const emitTerminals = (
    terminals: Parameters<typeof emitOutboundAuditTerminals>[0]["terminals"],
  ): void => {
    if (!ownsAuditTerminal) {
      return;
    }
    emitOutboundAuditTerminals({
      context: params,
      terminals,
      startedAt: auditStartedAt,
      ...(queueId ? { queueId } : {}),
    });
  };
  const runCommitHooksAfterAck = async (): Promise<void> => {
    if (queuedPostSendState !== "acked" || params.deferCommitHooks || commitHooksRun) {
      return;
    }
    commitHooksRun = true;
    flushMessageSentEvents();
    if (deliveredResults.length > 0) {
      await runOutboundDeliveryCommitHooks(deliveredResults);
    }
  };
  let releaseCancelledPreparation: (() => Promise<void>) | undefined;
  const cancelBeforeSend = (): void => {
    if (!queueId || !producerClaimId || platformSendStarted || queuedPostSendState !== undefined) {
      return;
    }
    try {
      throwIfProducerLeaseLost();
      releaseCancelledPreparation = retireUnsentDelivery({ id: queueId, producerClaimId });
      if (releaseCancelledPreparation) {
        // Keep preparation attached so its late token reaches afterSendFailure.
        // Custody ends now; media and plugin resources end when that work settles.
        producerLease?.stop();
        queuedPostSendState = "acked";
        emitTerminals(() =>
          uniformOutboundAuditTerminals(payloadCount, { outcome: "failed", failureStage: "queue" }),
        );
      }
    } catch (error) {
      log.warn(`failed to retire cancelled delivery ${queueId}: ${formatErrorMessage(error)}`);
    }
  };
  const wrappedParams: DeliverOutboundPayloadsParams = {
    ...params,
    // A provider marker can represent the whole durable intent only when one payload owns it.
    // Adapters must narrow further when one payload can fan out into multiple platform sends.
    ...(exactReconciliationRequired && params.payloads.length === 1
      ? { deliveryQueueId: platformQueueId }
      : { deliveryQueueId: undefined }),
    requiredUnknownSendReconciliation: exactReconciliationRequired,
    onPlatformSendStart: async (route, sourceIndex) => {
      throwIfAborted(params.abortSignal);
      platformSendRoute = route;
      platformSendSourceIndex = sourceIndex;
      if (platformQueueId && !exactReconciliationRequired && queuedPreSendState === undefined) {
        queuedPreSendState = await persistQueuedPreSendState({
          queueId: platformQueueId,
          queuePolicy: platformQueuePolicy,
          stateDir: platformQueueStateDir,
          route,
          producerClaimId,
          // Recovery sends read queue-owned media. Removing the row prevents a
          // duplicate replay, but the active adapter still needs the files.
          retainSpoolArtifacts: queueId === null && params.deliveryQueueId !== undefined,
        });
        if (queueId && queuedPreSendState === "acked") {
          queuedPostSendState = "acked";
        }
      }
      if (
        platformQueueId &&
        sourceIndex !== undefined &&
        !auditPlatformStartedPayloads.has(sourceIndex)
      ) {
        auditPlatformStartedPayloads.add(sourceIndex);
        emitOutboundAuditLifecycle({
          context: params,
          outcome: "platform_started",
          queueId: platformQueueId,
          startedAt: auditStartedAt,
          payloadIndexes: [sourceIndex],
        });
      }
      throwIfAborted(params.abortSignal);
      await params.onPlatformSendStart?.(route);
      throwIfAborted(params.abortSignal);
      platformSendStarted = true;
    },
    onDirectAdapterHandoff: async () => {
      throwIfAborted(params.abortSignal);
      assertSessionWriterDeliveryAuthorized(
        params.deliveryCompletion?.kind === "pending-final"
          ? params.deliveryCompletion.sessionWriterDeliveryAuthority
          : undefined,
      );
      await params.onPlatformSendDispatch?.();
      throwIfAborted(params.abortSignal);
    },
    assertDirectAdapterHandoff: () => {
      params.assertDirectAdapterHandoff?.();
      throwIfAborted(params.abortSignal);
      assertSessionWriterDeliveryAuthorized(
        params.deliveryCompletion?.kind === "pending-final"
          ? params.deliveryCompletion.sessionWriterDeliveryAuthority
          : undefined,
      );
    },
    onPlatformSendDispatch: async () => {
      throwIfAborted(params.abortSignal);
      // Once any payload returns an identity, unknown-after-send protects the whole batch.
      // A later payload dispatch must not regress that durable evidence to attempt-started.
      if (platformQueueId && queuedPreSendState !== "acked" && queuedPostSendState === undefined) {
        try {
          if (producerClaimId) {
            await markDeliveryPlatformSendDispatched(
              platformQueueId,
              platformQueueStateDir,
              platformSendRoute,
              producerClaimId,
            );
          } else {
            await markDeliveryPlatformSendDispatched(
              platformQueueId,
              platformQueueStateDir,
              platformSendRoute,
            );
          }
          queuedPreSendState ??= "marked";
        } catch (dispatchMarkError) {
          // Any SQLite-fenced live producer must prove it still owns the row at
          // dispatch. Continuing after a failed refresh can outlive the lease and
          // let recovery duplicate a recipient-visible send.
          if (exactReconciliationRequired || producerClaimId) {
            throw dispatchMarkError;
          }
          log.warn(
            `failed to refresh queued delivery ${platformQueueId} at platform dispatch; continuing best-effort send: ${formatErrorMessage(dispatchMarkError)}`,
          );
        }
      }
      throwIfAborted(params.abortSignal);
      assertSessionWriterDeliveryAuthorized(
        params.deliveryCompletion?.kind === "pending-final"
          ? params.deliveryCompletion.sessionWriterDeliveryAuthority
          : undefined,
      );
      await params.onPlatformSendDispatch?.();
      throwIfAborted(params.abortSignal);
      if (platformSendSourceIndex !== undefined) {
        platformDispatchedPayloads.add(platformSendSourceIndex);
      }
    },
    onError: (err: unknown, payload: NormalizedOutboundPayload) => {
      throwIfProducerLeaseLost();
      params.onError?.(err, payload);
    },
    onPayloadDeliveryOutcome: (outcome: OutboundPayloadDeliveryOutcome) => {
      if (
        outcome.status === "failed" &&
        platformDispatchedPayloads.has(outcome.index) &&
        !isProvenDeliveryNotSentError(outcome.error)
      ) {
        outcome.sentBeforeError = true;
      }
      payloadOutcomes.push(outcome);
      params.onPayloadDeliveryOutcome?.(outcome);
    },
    onDeliveryResult: async (result) => {
      deliveredResults.push(result);
      if (queueId && queuedPostSendState === undefined) {
        queuedPostSendState = await persistOwnedPostSendState();
      }
      await params.onDeliveryResult?.(result);
    },
    onMessageSentEvent: (event, sourceIndex) => {
      messageSentEvents.push(event);
      params.onMessageSentEvent?.(event, sourceIndex);
    },
  };
  let platformResultsReturned = false;

  try {
    params.abortSignal?.addEventListener("abort", cancelBeforeSend, { once: true });
    if (params.abortSignal?.aborted) {
      cancelBeforeSend();
    }
    throwIfProducerLeaseLost();
    const conversationAttemptAuthority =
      params.deliveryCompletion?.kind === "conversation"
        ? params.deliveryCompletion
        : params.conversationDeliveryAttemptAuthority;
    if (conversationAttemptAuthority) {
      // Conversation delivery was not stable-shipped before route fingerprints. An unfinished
      // legacy intent cannot be rebound safely after upgrade, so missing authority fails closed.
      if (!conversationAttemptAuthority.routeFingerprint || !params.onDeliveryAttempt) {
        throw new PlatformMessageNotDispatchedError(
          "Conversation delivery is missing its current route authorization",
          { cause: undefined, retryable: false },
        );
      }
      // One durable attempt admits its bounded adapter fanout/retries. A later queue or recovery
      // attempt rechecks from the serialized fingerprint; in-flight revocation is not promised.
      await params.onDeliveryAttempt();
      throwIfProducerLeaseLost();
    }
    const results = await deliverOutboundPayloadsCore(wrappedParams);
    if (releaseCancelledPreparation) {
      throwIfAborted(params.abortSignal);
    }
    // Core reconciles adapter progress objects with hook-bearing final results.
    deliveredResults = results;
    const failedOutcomes = payloadOutcomes.filter((outcome) => outcome.status === "failed");
    allPayloadsSuppressed =
      results.length === 0 && areOutboundPayloadsIntentionallySuppressed(payloadOutcomes);
    throwIfProducerLeaseLost();
    platformResultsReturned = true;
    if (
      queueId &&
      reusableProducerClaimId &&
      results.length > 0 &&
      payloadOutcomes.some(
        (outcome) =>
          outcome.status === "suppressed" && outcome.reason === "adapter_returned_no_identity",
      )
    ) {
      const error = "platform send returned no delivery identity for part of the delivery batch";
      await recordOwnedQueueFailure(failDeliveryAfterPlatformSend, error);
      queuedPostSendState = "failed";
      throw new OutboundDeliveryError(error, {
        cause: new Error(error),
        results,
        payloadOutcomes,
        stage: "platform_send",
      });
    }
    if (!queueId) {
      await settleDeliveryCompletion(results.at(-1));
      if (!params.deferCommitHooks) {
        flushMessageSentEvents();
        await runOutboundDeliveryCommitHooks(results);
      }
      emitTerminals(() =>
        failedOutcomes.length > 0
          ? failedOutboundAuditTerminals({
              payloadCount,
              results,
              payloadOutcomes,
              failureStage: "platform_send",
            })
          : completedOutboundAuditTerminals({
              payloadCount,
              results,
              payloadOutcomes,
            }),
      );
      return results;
    }
    if (queueId) {
      if (failedOutcomes.length > 0) {
        const partialFailuresAreProvenNotSent = failedOutcomes.every((outcome) =>
          isProvenDeliveryNotSentError(outcome.error),
        );
        const partialSendEvidence =
          results.length > 0 ||
          payloadOutcomes.some((outcome) =>
            outcome.status === "failed"
              ? outcome.sentBeforeError
              : outcome.status === "suppressed" &&
                outcome.reason === "adapter_returned_no_identity",
          );
        const postSendState =
          queuedPostSendState ??
          (partialSendEvidence ? await persistOwnedPostSendState() : undefined);
        const error = "partial delivery failure (bestEffort)";
        if (postSendState === undefined || postSendState === "marked") {
          const recordFailure =
            !partialSendEvidence && partialFailuresAreProvenNotSent
              ? failDeliveryBeforePlatformSend
              : failDelivery;
          await recordOwnedQueueFailure(recordFailure, error).catch((err: unknown) => {
            log.warn(
              `failed to mark queued delivery ${queueId} as failed after partial failure; continuing best-effort delivery: ${formatErrorMessage(err)}`,
            );
          });
        } else if (postSendState === "acked") {
          // Direct ack is the fallback when the post-send marker cannot be
          // written. Once the row is gone, recovery cannot run these hooks.
          await runCommitHooksAfterAck();
          emitTerminals(() =>
            failedOutboundAuditTerminals({
              payloadCount,
              results,
              payloadOutcomes,
              failureStage: "platform_send",
            }),
          );
        }
      } else {
        const postSendState =
          queuedPostSendState ??
          (results.length > 0 || (queuedPreSendState === "marked" && !allPayloadsSuppressed)
            ? await persistOwnedPostSendState()
            : queuedPreSendState === "acked"
              ? "acked"
              : undefined);
        await settleDeliveryCompletion(results.at(-1));
        if (results.length === 0 && postSendState === "marked") {
          // The provider was invoked but returned no recipient-visible identity;
          // never convert that ambiguous platform outcome into a success receipt.
          await recordOwnedQueueFailure(
            failDeliveryAfterPlatformSend,
            "platform send returned no delivery identity",
          );
          queuedPostSendState = "failed";
          // Durable custody remains with recovery. Publishing a terminal here
          // would make a later reconciliation reuse the same audit identity.
          return results;
        }
        const acked =
          postSendState === "acked"
            ? true
            : postSendState === "failed"
              ? false
              : await (
                  results.length === 0 && typeof params.completionRetention === "object"
                    ? ackOwnedQueue({ suppressCompletionReceipt: true })
                    : ackOwnedQueue()
                )
                  .then(() => true)
                  .catch(async (err: unknown) => {
                    const hasSendEvidence =
                      deliveredResults.length > 0 ||
                      (queuedPreSendState !== undefined && !allPayloadsSuppressed);
                    try {
                      if (hasSendEvidence) {
                        await recordOwnedQueueFailure(
                          failDeliveryAfterPlatformSend,
                          `failed to ack sent delivery: ${formatErrorMessage(err)}`,
                        );
                        queuedPostSendState = "failed";
                      } else {
                        // Proven omission clears the handoff marker so recovery can safely retry.
                        await recordOwnedQueueFailure(
                          allPayloadsSuppressed ? failDeliveryBeforePlatformSend : failDelivery,
                          `failed to ack unsent delivery: ${formatErrorMessage(err)}`,
                        );
                      }
                    } catch (persistErr: unknown) {
                      log.warn(
                        `failed to preserve queued delivery ${queueId} after ack failure: ${formatErrorMessage(persistErr)}`,
                      );
                    }
                    if (queuePolicy === "required") {
                      throw err;
                    }
                    log.warn(
                      hasSendEvidence
                        ? `failed to ack queued delivery ${queueId}; preserved unknown-after-send state: ${formatErrorMessage(err)}`
                        : `failed to ack unsent queued delivery ${queueId}; retained it for retry: ${formatErrorMessage(err)}`,
                    );
                    return false;
                  });
        if (acked) {
          queuedPostSendState = "acked";
          await runCommitHooksAfterAck();
          emitTerminals(() =>
            completedOutboundAuditTerminals({
              payloadCount,
              results,
              payloadOutcomes,
            }),
          );
        }
      }
    }
    return results;
  } catch (err) {
    throwIfProducerLeaseLost();
    if (releaseCancelledPreparation) {
      flushMessageSentEvents();
      throw err;
    }
    if (isOutboundDeliveryAdmissionClosedError(err)) {
      throw err;
    }
    if (err instanceof OutboundDeliveryError && err.results.length > 0) {
      deliveredResults = err.results;
    }
    const hasPlatformSendEvidence =
      deliveredResults.length > 0 ||
      (!allPayloadsSuppressed &&
        (queuedPreSendState === "marked" || queuedPostSendState === "marked")) ||
      (err instanceof OutboundDeliveryError && err.sentBeforeError) ||
      (reusableProducerClaimId !== undefined &&
        payloadOutcomes.some((outcome) => outcome.status === "sent"));
    // Every terminal below reports the same failed batch; only the stage differs.
    const emitFailedTerminals = (failureStage: AuditMessageFailureStage) =>
      emitTerminals(() =>
        failedOutboundAuditTerminals({
          payloadCount,
          results: deliveredResults,
          payloadOutcomes,
          failureStage,
        }),
      );
    const platformSendFailureStage: AuditMessageFailureStage =
      err instanceof OutboundDeliveryError ? err.stage : "platform_send";
    if (queueId) {
      if (queuedPreSendState === "acked") {
        // Best-effort fallback removed durable custody before provider I/O.
        // This process is now the only owner that can publish terminal observers.
        await runCommitHooksAfterAck();
        emitFailedTerminals(platformSendFailureStage);
      } else if (params.abortSignal?.aborted || isDeliveryAbortError(err)) {
        if (hasPlatformSendEvidence) {
          if (queuedPostSendState !== "failed") {
            await recordOwnedQueueFailure(
              failDeliveryAfterPlatformSend,
              `delivery aborted after platform send: ${formatErrorMessage(err)}`,
            );
            queuedPostSendState = "failed";
          }
        } else if (params.abortSignal?.aborted !== true) {
          await recordOwnedQueueFailure(failDelivery, formatErrorMessage(err)).catch(
            (failErr: unknown) => {
              log.warn(
                `failed to preserve queued delivery ${queueId} after provider abort: ${formatErrorMessage(failErr)}`,
              );
            },
          );
        } else if (
          await (
            producerClaimId ? ackOwnedQueue({ suppressCompletionReceipt: true }) : ackOwnedQueue()
          )
            .then(() => true)
            .catch(() => false)
        ) {
          queuedPostSendState = "acked";
          await runCommitHooksAfterAck();
          emitFailedTerminals("queue");
        }
      } else if (!platformResultsReturned) {
        const sendEvidence =
          deliveredResults.length > 0 ||
          (!isProvenDeliveryNotSentError(err) &&
            (platformDispatchedPayloads.size > 0 ||
              (err instanceof OutboundDeliveryError && err.sentBeforeError)));
        if (sendEvidence) {
          try {
            queuedPostSendState ??= await persistOwnedPostSendState();
            if (queuedPostSendState === "marked") {
              await recordOwnedQueueFailure(failDeliveryAfterPlatformSend, formatErrorMessage(err));
              queuedPostSendState = "failed";
            }
          } catch (persistErr: unknown) {
            // Do not convert concrete send evidence back into a generic retry.
            // All canonical state transitions failed, so retain the original row.
            log.warn(
              `failed to preserve queued delivery ${queueId} post-send evidence: ${formatErrorMessage(persistErr)}`,
            );
          }
          await runCommitHooksAfterAck();
          if (queuedPostSendState === "acked") {
            emitFailedTerminals(platformSendFailureStage);
          }
        } else {
          const permanentRejection = findPlatformMessageRejectedError(err);
          let terminalRejectionHandled = false;
          if (permanentRejection) {
            let ownerRejected = false;
            let queueAcked = false;
            try {
              const ambiguousStableRejection =
                producerClaimId !== undefined &&
                (deliveredResults.length > 0 ||
                  queuedPostSendState === "marked" ||
                  (reusableProducerClaimId &&
                    payloadOutcomes.some((outcome) => outcome.status === "sent")));
              if (ambiguousStableRejection) {
                await recordOwnedQueueFailure(
                  failDeliveryAfterPlatformSend,
                  `delivery partially sent before permanent rejection: ${permanentRejection.message}`,
                );
                queuedPostSendState = "failed";
                terminalRejectionHandled = true;
              } else {
                if (params.deliveryCompletion) {
                  await rejectDurableDelivery(
                    params.deliveryCompletion,
                    permanentRejection.message,
                    platformQueueStateDir,
                  );
                  ownerRejected = true;
                }
                await (producerClaimId
                  ? ackOwnedQueue({ suppressCompletionReceipt: true })
                  : ackOwnedQueue());
                queueAcked = true;
              }
            } catch (rejectionError) {
              log.warn(
                `failed to finalize permanently rejected delivery ${queueId}: ${formatErrorMessage(rejectionError)}`,
              );
            }
            terminalRejectionHandled ||= ownerRejected || queueAcked;
            if (queueAcked) {
              queuedPostSendState = "acked";
              await runCommitHooksAfterAck();
              emitFailedTerminals("platform_send");
            }
          }
          if (!terminalRejectionHandled) {
            // A caller that resends this failure itself must not leave a row
            // behind: the recovery drain would send the same message again
            // behind that retry (#124279). Callers that only report the error
            // (CLI, gateway RPC) and durable completions keep their own owner,
            // so their rows stay replayable (#100979).
            const callerOwnsRetry =
              isProvenDeliveryNotSentError(err) &&
              params.deliveryRetryOwner === "caller" &&
              !params.deliveryCompletion;
            if (callerOwnsRetry) {
              try {
                throwIfProducerLeaseLost();
                // Claim-fenced removal: the row is gone, so nothing replays it.
                // That also retires recovery's chance to report this delivery,
                // so the terminal audit fact is owed right here.
                const spooled = await moveToFailed(
                  queueId,
                  platformQueueStateDir,
                  producerClaimId ?? null,
                );
                await releaseSpoolArtifacts(spooled, platformQueueStateDir);
                emitFailedTerminals(platformSendFailureStage);
              } catch (failErr: unknown) {
                // Claim loss or a failed removal leaves the row with its owner;
                // no terminal is emitted because recovery still owns the entry.
                log.warn(
                  `failed to dead-letter queued delivery ${queueId} after proven-not-sent failure: ${formatErrorMessage(failErr)}`,
                );
              }
            } else {
              // One retry owner per row: the proven-not-sent row stays replay
              // eligible, so the thrown error is marked to tell RPC callers the
              // queue resends and the model must not.
              const recoveryOwnsRetry = isProvenDeliveryNotSentError(err);
              const recordFailure = recoveryOwnsRetry
                ? failDeliveryBeforePlatformSend
                : failDelivery;
              try {
                await recordOwnedQueueFailure(recordFailure, formatErrorMessage(err));
                if (recoveryOwnsRetry && err instanceof OutboundDeliveryError) {
                  err.recoveryOwnedRetry = true;
                }
              } catch (failErr) {
                log.warn(
                  `failed to mark queued delivery ${queueId} as failed: ${formatErrorMessage(failErr)}`,
                );
              }
            }
          }
        }
      }
    } else {
      flushMessageSentEvents();
      emitFailedTerminals(platformSendFailureStage);
    }
    throw err;
  } finally {
    params.abortSignal?.removeEventListener("abort", cancelBeforeSend);
    await releaseCancelledPreparation?.();
  }
}

/** Core delivery logic (extracted for queue wrapper). */
